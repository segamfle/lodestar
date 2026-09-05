/**
 * The room the game is heard in.
 *
 * A struck tone played dry sounds like a test signal, however carefully its partials are
 * tuned - there is no distance in it, and the ear reads that instantly as "computer made a
 * noise" rather than "something happened somewhere". What turns synthesis into a place is
 * reverberation and width: a tail that decays like air, and voices that sit at different
 * points across the stereo field instead of stacking in the middle of your skull.
 *
 * The impulse response is generated rather than downloaded, so the whole thing stays a static
 * build with no assets to fetch.
 */

/**
 * Build a decaying-noise impulse response.
 *
 * Real rooms are noise shaped by an envelope: dense random reflections whose energy falls off
 * roughly exponentially. `decay` sets how fast, and the pre-delay leaves a gap of silence for
 * the direct sound to arrive first, which is what makes a space read as large rather than as
 * a metallic ring.
 */
export function makeImpulse(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  preDelay = 0.012,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const gap = Math.floor(rate * preDelay);
  const impulse = ctx.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      if (i < gap) {
        data[i] = 0;
        continue;
      }
      const t = (i - gap) / (length - gap);
      // Slight per-channel difference in the noise is what gives the tail width; identical
      // channels collapse to mono the moment they are summed.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return impulse;
}

export interface Space {
  /** Send voices here to place them in the room. */
  input: GainNode;
  /** Per-voice panning, so seven stars do not stack in the centre of the head. */
  place(pan: number): GainNode;
}

/**
 * A reverb send with a gentle high cut.
 *
 * Rooms absorb treble faster than bass, so a tail that keeps all its top end sounds like a
 * plate rather than a place. The low-pass on the wet path is the whole difference between
 * "reverb effect" and "somewhere".
 */
export function createSpace(
  ctx: AudioContext,
  destination: AudioNode,
  options: { seconds?: number; decay?: number; wet?: number; damping?: number } = {},
): Space {
  const { seconds = 3.4, decay = 2.6, wet = 0.34, damping = 4200 } = options;

  const input = ctx.createGain();
  input.gain.value = 1;

  const dry = ctx.createGain();
  dry.gain.value = 1;
  input.connect(dry).connect(destination);

  const send = ctx.createGain();
  send.gain.value = wet;

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx, seconds, decay);

  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = damping;

  input.connect(send).connect(convolver).connect(damp).connect(destination);

  return {
    input,
    place(pan: number) {
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner).connect(input);
      return gain;
    },
  };
}
