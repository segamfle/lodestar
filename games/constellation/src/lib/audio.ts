/**
 * Constellation's sound.
 *
 * The game is mostly quiet. Stars arrive one at a time, each with a struck tone rising
 * through a pentatonic ladder, so a round is a phrase rather than a noise. Completing a whole
 * shape is the only loud moment in the game.
 *
 * Everything is synthesised - the build has to load fast inside an iframe and struck metal is
 * cheaper to make than to download - but synthesis alone sounds like a test signal. Three
 * things stop it: the partials are inharmonic, the way struck metal really rings; every voice
 * goes through a generated room so it decays into air instead of stopping dead; and each star
 * is panned to where it sits on the board, so the sky has width.
 *
 * Nothing opens until the player's first click. Browsers refuse an audio context before a
 * gesture, and sounds queued against a clock that has not started collapse onto one instant.
 */

import { createSpace, type Space } from './space';

const STORAGE_KEY = 'constellation:muted';

/** Inharmonic partials - the ratios struck metal actually rings at. */
const PARTIALS = [
  { ratio: 1.0, gain: 0.5, decay: 2.6 },
  { ratio: 2.01, gain: 0.3, decay: 1.9 },
  { ratio: 2.99, gain: 0.18, decay: 1.2 },
  { ratio: 4.21, gain: 0.1, decay: 0.8 },
  { ratio: 5.43, gain: 0.05, decay: 0.5 },
];

/** A pentatonic ladder, so any subset of stars sounds intentional rather than arbitrary. */
const SCALE = [0, 2, 4, 7, 9, 12, 14];

class ConstellationAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private space: Space | null = null;
  private noise: AudioBuffer | null = null;

  muted = readMuted();

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as never as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // no Web Audio here; the game stays silent and otherwise unaffected

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.85;
    master.connect(ctx.destination);

    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buffer;
    // A long, dark tail: this is meant to read as open sky, not as a tiled room.
    this.space = createSpace(ctx, master, { seconds: 4.2, decay: 3, wet: 0.4, damping: 3600 });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Private browsing refuses storage; the setting just will not persist.
    }
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.05);
    }
  }

  /** Everything a voice needs, or null when the context is closed or the game is muted. */
  private voice(): { ctx: AudioContext; space: Space; noise: AudioBuffer } | null {
    if (this.muted || !this.ctx || !this.space || !this.noise) return null;
    return { ctx: this.ctx, space: this.space, noise: this.noise };
  }

  /** Marking or clearing a cell. A fingertip on glass, not a click. */
  mark(placing: boolean, pan = 0) {
    const v = this.voice();
    if (!v) return;
    const { ctx, space, noise } = v;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = noise;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = placing ? 2800 : 1500;
    band.Q.value = 9;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    source.connect(band).connect(gain).connect(space.place(pan));
    source.start(now);
    source.stop(now + 0.1);
  }

  /**
   * One star arriving.
   *
   * `step` walks the scale so seven stars form a phrase. `pan` places the voice where the
   * star sits on the board. `onShape` is louder and rings longer, because whether the star
   * landed on your mark is the only question the game asks.
   */
  star(step: number, onShape: boolean, pan = 0) {
    const v = this.voice();
    if (!v) return;
    const { ctx, space } = v;
    const at = ctx.currentTime;

    const semitones = SCALE[Math.min(step, SCALE.length - 1)];
    const fundamental = 293.66 * Math.pow(2, semitones / 12); // from D4

    const bus = space.place(pan);
    bus.gain.value = onShape ? 0.32 : 0.1;

    for (const partial of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // A touch of detune per voice keeps repeated notes from sounding machine-stamped.
      osc.frequency.value = fundamental * partial.ratio;
      osc.detune.value = (Math.random() - 0.5) * 6;

      const decay = partial.decay * (onShape ? 1 : 0.45);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(partial.gain, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);

      osc.connect(gain).connect(bus);
      osc.start(at);
      osc.stop(at + decay + 0.1);
    }
  }

  /** The whole shape came alight. The one loud moment. */
  complete() {
    const v = this.voice();
    if (!v) return;
    const { ctx, space } = v;

    // An arpeggio up the scale, spread across the field.
    for (let i = 0; i < 4; i++) {
      const at = i * 0.1;
      setTimeout(() => this.star(3 + i, true, (i - 1.5) * 0.4), at * 1000);
    }

    // A low swell underneath, so it lands in the chest and not only in the ear.
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(73.42, now); // D2
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.26, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 3);
    osc.connect(gain).connect(space.input);
    osc.start(now);
    osc.stop(now + 3.2);
  }

  /** Nothing landed. Air leaving the room. */
  dark() {
    const v = this.voice();
    if (!v) return;
    const { ctx, space, noise } = v;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.playbackRate.value = 0.35;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.exponentialRampToValueAtTime(110, now + 1.6);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);

    source.connect(filter).connect(gain).connect(space.input);
    source.start(now);
    source.stop(now + 2);
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const audio = new ConstellationAudio();
