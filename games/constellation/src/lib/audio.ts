/**
 * Constellation's sound, synthesised in the browser.
 *
 * The game is mostly quiet. Stars arrive one at a time and each one gets a single struck
 * tone, rising in pitch as the count climbs, so a good round is an ascending phrase and a
 * bad one is the same phrase landing nowhere near your shape. Completing a whole shape is
 * the only loud moment in the game, which is what makes it worth chasing.
 *
 * No audio files: the build has to load fast inside an iframe, and struck metal is cheaper
 * to synthesise than to download. Nothing opens until the player's first click, because
 * browsers refuse an audio context before a gesture.
 */

const STORAGE_KEY = 'constellation:muted';

/** Inharmonic partials, the ratios struck metal actually rings at. */
const PARTIALS = [
  { ratio: 1.0, gain: 0.5, decay: 2.4 },
  { ratio: 2.01, gain: 0.3, decay: 1.7 },
  { ratio: 2.99, gain: 0.18, decay: 1.1 },
  { ratio: 4.21, gain: 0.1, decay: 0.7 },
  { ratio: 5.43, gain: 0.05, decay: 0.45 },
];

/** A pentatonic ladder, so any subset of stars sounds intentional rather than random. */
const SCALE = [0, 2, 4, 7, 9, 12, 14];

class ConstellationAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
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
    master.gain.value = this.muted ? 0 : 0.9;
    master.connect(ctx.destination);

    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buffer;
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
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }

  /** Marking or clearing a cell. A fingertip on glass, not a click. */
  mark(placing: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = placing ? 2600 : 1500;
    band.Q.value = 8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

    source.connect(band).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + 0.12);
  }

  /**
   * One star arriving. `step` walks up the scale so the seven stars form a phrase; `onShape`
   * is louder and brighter, because the whole game is whether the star landed on your mark.
   */
  star(step: number, when: number, onShape: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const at = ctx.currentTime + Math.max(when, 0);

    const semitones = SCALE[Math.min(step, SCALE.length - 1)];
    const fundamental = 293.66 * Math.pow(2, semitones / 12); // from D4

    const bus = ctx.createGain();
    bus.gain.value = onShape ? 0.3 : 0.11;
    bus.connect(this.master);

    for (const partial of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = fundamental * partial.ratio;

      const decay = partial.decay * (onShape ? 1 : 0.5);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(partial.gain, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);

      osc.connect(gain).connect(bus);
      osc.start(at);
      osc.stop(at + decay + 0.1);
    }
  }

  /** The whole shape came alight. The one loud moment. */
  complete(when = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    for (let i = 0; i < 4; i++) this.star(3 + i, when + i * 0.11, true);

    // A low swell underneath so it lands in the chest rather than only in the ear.
    const at = ctx.currentTime + Math.max(when, 0);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(73.42, at); // D2
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.24, at + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 2.6);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + 2.8);
  }

  /** Nothing landed. Air leaving the room. */
  dark(when = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const at = ctx.currentTime + Math.max(when, 0);

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    source.playbackRate.value = 0.4;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(700, at);
    filter.frequency.exponentialRampToValueAtTime(120, at + 1.4);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.1, at + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.5);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(at);
    source.stop(at + 1.7);
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
