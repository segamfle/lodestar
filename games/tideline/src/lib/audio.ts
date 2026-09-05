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

const STORAGE_KEY = 'tideline:muted';

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
  private noise: AudioBuffer | null = null;
  private swell: { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null =
    null;

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
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.9;
    master.connect(ctx.destination);

    // Two seconds of white noise, reused for every watery sound.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
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
      // Private browsing refuses storage; the setting simply will not persist.
    }
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }

  /** A knock on wet timber. Pitched down as you go up the ladder, so the rungs feel ordered. */
  knock(rung: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.8 + Math.random() * 0.4;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900 - rung * 70;
    band.Q.value = 4.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    source.connect(band).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + 0.16);
  }

  /** One bell strike. `rung` picks the pitch; the top rung gets the loudest, longest voice. */
  bell(rung: number, when = 0, strength = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const at = ctx.currentTime + Math.max(when, 0);

    // Rising rungs ring higher, so a climb up the ladder is an ascending phrase.
    const fundamental = 196 * Math.pow(2, (rung - 1) / 6);

    const bus = ctx.createGain();
    bus.gain.value = 0.22 * strength;
    bus.connect(this.master);

    for (const partial of BELL_PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = fundamental * partial.ratio;

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
  startSwell() {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise || this.muted) return;
    this.stopSwell();
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(240, now);
    // Opening the filter as the water rises reads as the sound getting closer, not just louder.
    filter.frequency.exponentialRampToValueAtTime(1500, now + 1.8);
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.32, now + 0.5);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
    this.swell = { source, gain, filter };
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
    swell.source.stop(now + 0.9);
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
