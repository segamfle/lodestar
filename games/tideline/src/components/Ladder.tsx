import { useEffect, useRef } from 'react';
import { RUNGS, LEVELS } from '../lib/tideline';

export type LadderPhase = 'idle' | 'rising' | 'settled';

interface LadderProps {
  /** Stake on each rung, index 0 = rung 1. Zero means the player skipped it. */
  stakes: readonly bigint[];
  /** Tide level 0..6 once drawn, or null while the draw is still out. */
  level: number | null;
  phase: LadderPhase;
  /** Rung the pointer is over, 1-based, for the hover glow. */
  hovered: number | null;
}

/** Where each rung sits vertically, as a fraction of the scene height from the top. */
const RUNG_TOP = 0.12;
const RUNG_BOTTOM = 0.82;
const rungY = (rung: number) =>
  RUNG_TOP + ((RUNGS - rung) / (RUNGS - 1)) * (RUNG_BOTTOM - RUNG_TOP);

/**
 * Time constant for the tide, in seconds. The water covers most of the distance in about a
 * second and a half and keeps creeping after, which is the shape that makes a climb feel
 * like it might stop just short of your rung.
 */
const TIDE_TAU = 0.42;

/** Waterline for a tide level. Level 0 sits below the ladder; level 6 drowns the top rung. */
function waterlineFor(level: number): number {
  if (level <= 0) return 0.94;
  const target = rungY(Math.min(level, RUNGS));
  // Settle a little above the rung it covers, so a covered rung reads as submerged rather
  // than merely touched.
  return target - 0.018;
}

/** The surface at a given x, as a sum of three swells running at different rates. */
function surfaceAt(x: number, h: number, t: number, surge: number): number {
  return (
    Math.sin(x * 0.021 + t * 1.7) * (h * 0.006) +
    Math.sin(x * 0.047 - t * 2.6) * (h * 0.0035) +
    Math.sin(x * 0.011 + t * 0.9) * (h * 0.004) +
    surge * Math.sin(x * 0.03 + t * 6) * h * 0.012
  );
}

/** Deterministic value noise — the stone wants texture, not a flicker that changes each frame. */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * The harbour wall and the ladder rails never move, so they are painted once into an
 * offscreen canvas and blitted each frame. Redrawing coursed masonry sixty times a second
 * was what made the tide crawl on the first pass.
 */
function paintBackdrop(w: number, h: number, ratio: number): HTMLCanvasElement {
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.round(w * ratio));
  layer.height = Math.max(1, Math.round(h * ratio));
  const ctx = layer.getContext('2d');
  if (!ctx) return layer;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#0b1220');
  sky.addColorStop(0.55, '#101a2b');
  sky.addColorStop(1, '#0a1017');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const wallLeft = w * 0.22;
  const wallRight = w * 0.78;
  ctx.fillStyle = '#141b26';
  ctx.fillRect(wallLeft, 0, wallRight - wallLeft, h);

  const course = h * 0.075;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  for (let row = 0; row * course < h; row++) {
    const y = row * course;
    ctx.beginPath();
    ctx.moveTo(wallLeft, y);
    ctx.lineTo(wallRight, y);
    ctx.stroke();

    // Alternate courses break their joints, the way real masonry does.
    const offset = row % 2 === 0 ? 0 : (wallRight - wallLeft) / 6;
    for (let block = 0; block < 4; block++) {
      const x = wallLeft + offset + (block * (wallRight - wallLeft)) / 3;
      if (x <= wallLeft || x >= wallRight) continue;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + course);
      ctx.stroke();
    }

    ctx.fillStyle = `rgba(255,255,255,${(hash2(row, 3) * 0.05).toFixed(3)})`;
    ctx.fillRect(wallLeft, y, wallRight - wallLeft, course);
  }

  const railInset = w * 0.32;
  const railWidth = Math.max(3, w * 0.012);
  for (const x of [railInset, w - railInset - railWidth]) {
    const grad = ctx.createLinearGradient(x, 0, x + railWidth, 0);
    grad.addColorStop(0, '#6b563c');
    grad.addColorStop(0.5, '#8d7350');
    grad.addColorStop(1, '#5a462f');
    ctx.fillStyle = grad;
    ctx.fillRect(x, h * 0.06, railWidth, h * 0.9);
  }

  return layer;
}

export function Ladder({ stakes, level, phase, hovered }: LadderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Props are mirrored into refs so the animation loop reads current values without being
  // torn down and rebuilt every time the pointer moves across a rung.
  const propsRef = useRef({ stakes, level, hovered });
  propsRef.current = { stakes, level, hovered };

  // The tide is a function of wall-clock time since the level was drawn, not an accumulator
  // advanced once per frame. Accumulating made the climb depend on frame delivery, so a
  // throttled or backgrounded tab replayed it in slow motion; this way the water is wherever
  // the clock says it should be, however many frames actually arrived.
  const riseRef = useRef({ from: waterlineFor(0), to: waterlineFor(0), startedAt: 0 });
  const splashRef = useRef({ at: 0 });

  useEffect(() => {
    const to = waterlineFor(level ?? 0);
    const now = performance.now();
    const { from, to: previousTo, startedAt } = riseRef.current;

    // Start from wherever the water actually is, so a re-draw mid-climb does not snap.
    const elapsed = (now - startedAt) / 1000;
    const settled = startedAt === 0 ? previousTo : from + (previousTo - from) * (1 - Math.exp(-elapsed / TIDE_TAU));

    riseRef.current = { from: settled, to, startedAt: now };
    if (phase === 'rising') splashRef.current = { at: now };
  }, [level, phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let backdrop: HTMLCanvasElement | null = null;
    let width = 0;
    let height = 0;
    let ratio = 1;

    const resize = () => {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width < 1 || height < 1) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      backdrop = paintBackdrop(width, height, ratio);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (width < 1 || height < 1 || !backdrop) return;

      const t = now / 1000;
      const { stakes: currentStakes, level: currentLevel, hovered: currentHover } =
        propsRef.current;

      const rise = riseRef.current;
      const elapsed = (now - rise.startedAt) / 1000;
      const progress = reduceMotion ? 1 : 1 - Math.exp(-elapsed / TIDE_TAU);
      const waterline = rise.from + (rise.to - rise.from) * progress;
      const surgeAge = (now - splashRef.current.at) / 1000;
      const surge = splashRef.current.at === 0 ? 0 : Math.exp(-surgeAge / 0.55);

      const w = width;
      const h = height;
      const waterY = waterline * h;
      const railInset = w * 0.32;
      const railWidth = Math.max(3, w * 0.012);

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(backdrop, 0, 0, w, h);

      // ---- rungs -------------------------------------------------------------------
      for (let rung = 1; rung <= RUNGS; rung++) {
        const y = rungY(rung) * h;
        const staked = currentStakes[rung - 1] > 0n;
        const submerged = currentLevel !== null && y > waterY;
        const thickness = Math.max(4, h * 0.014);

        const grad = ctx.createLinearGradient(0, y - thickness, 0, y + thickness);
        if (submerged) {
          grad.addColorStop(0, '#3f6f7a');
          grad.addColorStop(1, '#24454e');
        } else {
          grad.addColorStop(0, '#9c8158');
          grad.addColorStop(1, '#6a5537');
        }
        ctx.fillStyle = grad;
        ctx.fillRect(railInset, y - thickness / 2, w - railInset * 2, thickness);

        if (staked || currentHover === rung) {
          const glow = currentHover === rung ? 0.5 : 0.28;
          ctx.save();
          ctx.shadowColor = submerged ? 'rgba(120,220,255,0.9)' : 'rgba(255,196,92,0.9)';
          ctx.shadowBlur = h * (submerged ? 0.045 : 0.03);
          ctx.fillStyle = submerged
            ? `rgba(150,230,255,${glow + 0.25})`
            : `rgba(255,198,102,${glow})`;
          ctx.fillRect(railInset, y - thickness / 2, w - railInset * 2, thickness);
          ctx.restore();
        }
      }

      // ---- bell over the top rung -----------------------------------------------------
      const crowned = currentLevel === RUNGS;
      const bellY = rungY(RUNGS) * h - h * 0.055;
      const swing = crowned && !reduceMotion ? Math.sin(t * 9) * 0.14 * surge : 0;
      ctx.save();
      ctx.translate(w / 2, bellY);
      ctx.rotate(swing);
      if (crowned) {
        ctx.shadowColor = 'rgba(255,214,138,0.8)';
        ctx.shadowBlur = h * 0.05;
      }
      ctx.fillStyle = crowned ? '#ffd68a' : '#7d6b4a';
      ctx.beginPath();
      ctx.moveTo(-w * 0.028, w * 0.026);
      ctx.quadraticCurveTo(-w * 0.026, -w * 0.022, 0, -w * 0.026);
      ctx.quadraticCurveTo(w * 0.026, -w * 0.022, w * 0.028, w * 0.026);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // ---- water ------------------------------------------------------------------------
      const phaseT = reduceMotion ? 0 : t;
      const step = Math.max(3, w / 120);

      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, waterY + surfaceAt(0, h, phaseT, surge));
      for (let x = step; x <= w; x += step) {
        ctx.lineTo(x, waterY + surfaceAt(x, h, phaseT, surge));
      }
      ctx.lineTo(w, h);
      ctx.closePath();

      const water = ctx.createLinearGradient(0, waterY - h * 0.05, 0, h);
      water.addColorStop(0, 'rgba(96,190,214,0.72)');
      water.addColorStop(0.35, 'rgba(31,104,138,0.86)');
      water.addColorStop(1, 'rgba(8,32,48,0.96)');
      ctx.fillStyle = water;
      ctx.fill();

      // Foam catching the light along the surface.
      ctx.strokeStyle = `rgba(214,244,255,${(0.35 + surge * 0.4).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, h * 0.0035);
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) {
        const y = waterY + surfaceAt(x, h, phaseT, surge);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // The rails carry on down through the water, dimmed by it.
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#8d7350';
      for (const x of [railInset, w - railInset - railWidth]) {
        ctx.fillRect(x, waterY, railWidth, h - waterY);
      }
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="tideline-canvas"
      role="img"
      aria-label={
        level === null
          ? 'A harbour ladder of six rungs above still water, waiting for the tide.'
          : `The tide reached level ${level} of ${LEVELS - 1}.`
      }
    />
  );
}
