/**
 * Tideline's sound, synthesised in the browser.
 *
 * No audio files: the whole game is a static build that has to load fast inside an iframe,
 * and a harbour is mostly noise and metal anyway — both cheaper to make than to download.
 *
 * The palette is three materials. Water is filtered noise. The ladder is wood, a short
 * bandpassed knock. The bell is metal, a stack of inharmonic partials in the ratios a real
 * bell rings at, which is what stops it sounding like a sine beep.
 *
 * Nothing here starts until the player's first click. Browsers refuse to open an audio
 * context before a gesture, and a game that fights that ends up silent for the whole session.
 */

import { createSpace, type Space } from './space';

const STORAGE_KEY = 'tideline:muted';

/**
 * Where each rung sits, in semitones from the lowest.
 *
 * This was an even division of an octave, which is a whole-tone scale - rootless by
 * construction, every step the same interval, so the sixth rung was not an arrival but simply
 * another step and the climax had nowhere to land. These intervals put the top rung an octave
 * above the bottom, so crowning the ladder resolves.
 */
const RUNG_SEMITONES = [0, 3, 5, 7, 10, 12];

/** Hum, prime, tierce, quint, nominal — the partials that make metal sound like a bell. */
const BELL_PARTIALS = [
  { ratio: 0.5, gain: 0.32, decay: 2.6 },
  { ratio: 1.0, gain: 0.5, decay: 2.1 },
  { ratio: 1.19, gain: 0.28, decay: 1.5 },
  { ratio: 1.5, gain: 0.22, decay: 1.2 },
  { ratio: 2.0, gain: 0.16, decay: 0.9 },
  { ratio: 2.67, gain: 0.09, decay: 0.55 },
];

class TidelineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private space: Space | null = null;
  private noise: AudioBuffer | null = null;
  private swell: { gain: GainNode; sources: AudioBufferSourceNode[] } | null = null;
  /** Long-running oscillators driving the swell's shape, stopped with it. */
  private modulators: OscillatorNode[] = [];

  muted = readMuted();

  /** Open the context. Safe to call on every gesture; only the first one does anything. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no Web Audio here; the game stays silent and otherwise unaffected

    const ctx = new Ctor();
    // Safari hands back a suspended context, and resume() has to happen inside the gesture
    // that created it. Without this the whole first round is silent and everything it
    // scheduled arrives at once on the next click.
    if (ctx.state === 'suspended') void ctx.resume();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 1.6;

    // Nothing was catching the peaks and the mix sat far below where it should. The
    // compressor buys the headroom to bring the whole harbour up.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;
    master.connect(limiter).connect(ctx.destination);

    // Two seconds of white noise, reused for every watery sound.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buffer;
    // A harbour has a stone wall three feet away. Everything here used to be bone dry and
    // perfectly mono - measured, the two channels were identical to three decimal places -
    // which is most of why it sounded like a signal generator rather than a place. Shorter
    // and darker than Constellation's sky, because this room has walls.
    this.space = createSpace(ctx, master, { seconds: 2.4, decay: 2, wet: 0.26, damping: 2400 });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Private browsing refuses storage; the setting simply will not persist.
    }
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(muted ? 0 : 1.6, this.ctx.currentTime, 0.05);
    }
  }

  /** A knock on wet timber. Pitched down as you go up the ladder, so the rungs feel ordered. */
  knock(rung: number) {
    const ctx = this.ctx;
    if (!ctx || !this.space || !this.noise || this.muted) return;
    const now = ctx.currentTime + 0.008;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.8 + Math.random() * 0.4;

    // A bandpass over noise loses power as its centre descends.
    const centre = 900 - rung * 70;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = centre;
    band.Q.value = 4.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    // The same click on rung 6 measured nearly nine decibels quieter than on rung 1.
    // Compensating by the square root of the frequency ratio makes the ladder respond evenly.
    gain.gain.exponentialRampToValueAtTime(0.5 * Math.sqrt(830 / centre), now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    source.connect(band).connect(gain).connect(this.space.place((rung - 3.5) * 0.16));
    source.start(now);
    source.stop(now + 0.16);
  }

  /** One bell strike. `rung` picks the pitch; the top rung gets the loudest, longest voice. */
  bell(rung: number, when = 0, strength = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.space || this.muted) return;
    const at = ctx.currentTime + Math.max(when, 0) + 0.008;

    // Rising rungs ring higher, so a climb up the ladder is an ascending phrase that lands an
    // octave up when the tide crowns.
    const fundamental = 196 * Math.pow(2, RUNG_SEMITONES[Math.min(rung, 6) - 1] / 12);

    const bus = this.space.place((rung - 3.5) * 0.12);
    bus.gain.value = 0.22 * strength;

    // Struck metal is broadband for the first twenty milliseconds. Measured, this bell had
    // nothing at all above 1 kHz - a blob rather than a strike, and that transient is the
    // whole difference between a bell and an oscillator.
    if (this.noise) {
      const clapper = ctx.createBufferSource();
      clapper.buffer = this.noise;
      const body = ctx.createBiquadFilter();
      body.type = 'bandpass';
      body.frequency.value = 3200;
      body.Q.value = 1.1;
      const strike = ctx.createGain();
      strike.gain.setValueAtTime(0.0001, at);
      strike.gain.exponentialRampToValueAtTime(0.38 * strength, at + 0.002);
      strike.gain.exponentialRampToValueAtTime(0.0001, at + 0.032);
      clapper.connect(body).connect(strike).connect(bus);
      clapper.start(at);
      clapper.stop(at + 0.05);
    }

    for (const partial of BELL_PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = fundamental * partial.ratio;
      // Every strike was bit-identical. A few cents of drift is what the ear uses to decide
      // that something was cast rather than computed.
      osc.detune.value = (Math.random() - 0.5) * 7;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(partial.gain, at + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + partial.decay * strength);

      osc.connect(gain).connect(bus);
      osc.start(at);
      osc.stop(at + partial.decay * strength + 0.1);
    }
  }

  /** The wash of water climbing the wall. Held until `stopSwell`. */
  /**
   * Water climbing stone.
   *
   * The first version was white noise through one lowpass whose cutoff swept smoothly from
   * 240 Hz to 1500 Hz. Every property of that is wrong for water and right for a machine: the
   * spectrum never changes shape, the amplitude never varies, and the one thing that does
   * move rises monotonically - which is exactly what a motor spinning up does. It sounded
   * like a vacuum cleaner because acoustically it was one.
   *
   * Water is not a continuous hiss. It is thousands of separate small impacts, and what the
   * ear uses to identify it is the irregularity: the surge and fall of a swell that never
   * repeats, a spectrum that wanders rather than sweeps, and discrete droplets on top. All
   * three are built here.
   */
  startSwell(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    this.stopSwell();
    const now = ctx.currentTime;
    const noise = this.noise;

    const bus = ctx.createGain();
    // Scaled by the tide, so how far the water climbs is audible and not only visible.
    const loudness = 0.1 + level * 0.045;
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.exponentialRampToValueAtTime(loudness, now + 0.45);
    bus.connect(this.master);

    const sources: AudioBufferSourceNode[] = [];

    // ---- body: the mass of moving water, felt more than heard --------------------------
    {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      source.playbackRate.value = 0.55;

      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 190;
      low.Q.value = 0.6;

      const swellGain = ctx.createGain();
      swellGain.gain.value = 0.85;

      // Two slow modulators at rates that share no common multiple, so the surge never
      // settles into a pattern the ear can predict. A single LFO reads as a wobble effect.
      for (const [rate, depth] of [[0.23, 0.3], [0.37, 0.18]] as const) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const amount = ctx.createGain();
        amount.gain.value = depth;
        lfo.connect(amount).connect(swellGain.gain);
        lfo.start(now);
        this.modulators.push(lfo);
      }

      source.connect(low).connect(swellGain).connect(bus);
      source.start(now);
      sources.push(source);
    }

    // ---- wash: the surface, wandering rather than sweeping ------------------------------
    for (const [pan, rate] of [[-0.8, 1.0], [0.8, 1.017]] as const) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      source.playbackRate.value = rate;

      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 0.7;
      band.frequency.setValueAtTime(400, now);

      // The centre is re-aimed at a fresh random target several times a second, drifting
      // upward as the tide climbs. A smooth ramp to a fixed destination is a machine
      // changing speed; this is a surface that will not hold still.
      for (let step = 0; step < 14; step++) {
        const at = now + step * 0.16;
        const bias = 320 + step * 34 * (0.4 + level * 0.1);
        band.frequency.setTargetAtTime(bias * (0.62 + Math.random() * 0.9), at, 0.09);
      }

      const side = ctx.createStereoPanner();
      side.pan.value = pan;

      const level2 = ctx.createGain();
      level2.gain.value = 0.5;

      source.connect(band).connect(level2).connect(side).connect(bus);
      source.start(now);
      sources.push(source);
    }

    // ---- droplets: the part that makes it liquid ----------------------------------------
    //
    // Discrete impacts at irregular intervals. Without these the layers above are still just
    // shaped noise, however carefully shaped - the ear needs individual events to hear
    // water rather than air. Scheduled on the audio clock rather than with timers, so there
    // is nothing to clean up and nothing to drift.
    let at = now + 0.08;
    while (at < now + 2.6) {
      const drop = ctx.createBufferSource();
      drop.buffer = noise;
      drop.playbackRate.value = 0.8 + Math.random() * 1.6;
      // Start somewhere random in the buffer so no two droplets are the same sample.
      const offset = Math.random() * (noise.duration - 0.1);

      const voice = ctx.createBiquadFilter();
      voice.type = 'bandpass';
      voice.frequency.value = 700 + Math.random() * 2600;
      voice.Q.value = 2.5 + Math.random() * 5;

      const envelope = ctx.createGain();
      const peak = 0.05 + Math.random() * 0.14;
      const decay = 0.03 + Math.random() * 0.07;
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(peak, at + 0.004);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);

      const where = ctx.createStereoPanner();
      where.pan.value = Math.random() * 1.6 - 0.8;

      drop.connect(voice).connect(envelope).connect(where).connect(bus);
      drop.start(at, offset, decay + 0.05);
      sources.push(drop);

      // Irregular spacing. An even one would be a tick, not weather.
      at += 0.018 + Math.random() * 0.07;
    }

    this.swell = { gain: bus, sources };
  }

  /**
   * Pull the wash down so something else can be heard over it.
   *
   * The bells were competing with a constant bed of noise, which is why the loudest moment in
   * the game barely registered against the quietest.
   */
  duckSwell(when: number, seconds = 1.1) {
    const ctx = this.ctx;
    const swell = this.swell;
    if (!ctx || !swell) return;
    const at = ctx.currentTime + Math.max(when, 0);
    swell.gain.gain.setTargetAtTime(0.06, at, 0.06);
    swell.gain.gain.setTargetAtTime(0.24, at + seconds, 0.35);
  }

  stopSwell() {
    const ctx = this.ctx;
    const swell = this.swell;
    if (!ctx || !swell) return;
    this.swell = null;
    const now = ctx.currentTime;
    swell.gain.gain.cancelScheduledValues(now);
    swell.gain.gain.setValueAtTime(Math.max(swell.gain.gain.value, 0.0001), now);
    swell.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
    for (const source of swell.sources) {
      // Droplets scheduled past the stop have not started and will throw if stopped.
      try {
        source.stop(now + 0.9);
      } catch {
        // Already finished; nothing to do.
      }
    }
    for (const lfo of this.modulators) {
      try {
        lfo.stop(now + 0.9);
      } catch {
        // Already stopped.
      }
    }
    this.modulators = [];
  }

  /** The ladder came up dry. Water pulling back off stone, and nothing else. */
  ebb() {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.55;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(180, now + 1.1);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + 1.3);
  }

  /** The tide crowned the ladder. The only loud moment in the game. */
  crown(when = 0) {
    this.bell(6, when, 1.6);
    this.bell(6, when + 0.42, 1.1);
    this.bell(6, when + 0.9, 0.7);

    // Measured, there was nothing below 100 Hz anywhere in this game - the crown was a
    // 125 Hz-to-1 kHz blob. A note two octaves under the bell is what puts it in the chest
    // rather than only in the ear.
    const ctx = this.ctx;
    if (!ctx || !this.space || this.muted) return;
    const at = ctx.currentTime + Math.max(when, 0);
    for (const [frequency, level, seconds] of [[87.31, 0.2, 1.9], [174.62, 0.06, 1.2]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(level, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
      osc.connect(gain).connect(this.space.input);
      osc.start(at);
      osc.stop(at + seconds + 0.1);
    }
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const audio = new TidelineAudio();
