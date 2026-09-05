import { useEffect, useRef } from 'react';
import { RUNGS, LEVELS } from '../lib/tideline';
import { rungY, waterlineAt, waterlineFor } from '../lib/tide';

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

  // The wall fills the frame. An earlier version drew it as a strip down the middle, which
  // read as a rectangle floating on a background rather than as the side of a harbour.
  const stone = ctx.createLinearGradient(0, 0, w, h);
  stone.addColorStop(0, '#1a1f28');
  stone.addColorStop(0.5, '#141920');
  stone.addColorStop(1, '#0d1116');
  ctx.fillStyle = stone;
  ctx.fillRect(0, 0, w, h);

  // Coursed masonry. Rows break their joints the way real stonework does, and each block
  // gets its own weathering so the wall is never twice the same.
  const course = h * 0.062;
  for (let row = 0; row * course < h + course; row++) {
    const y = row * course;
    const offset = (row % 2) * (w / 7);

    for (let block = -1; block < 8; block++) {
      const x = offset + (block * w) / 3.5;
      const bw = w / 3.5;

      const shade = hash2(row, block);
      ctx.fillStyle = `rgba(${Math.round(150 + shade * 40)},${Math.round(150 + shade * 38)},${Math.round(148 + shade * 36)},${(0.018 + shade * 0.032).toFixed(3)})`;
      ctx.fillRect(x, y, bw, course);

      // Damp bleeding down from each joint.
      const damp = ctx.createLinearGradient(0, y, 0, y + course * 0.7);
      damp.addColorStop(0, `rgba(20,34,42,${(0.1 + hash2(block, row) * 0.16).toFixed(3)})`);
      damp.addColorStop(1, 'rgba(20,34,42,0)');
      ctx.fillStyle = damp;
      ctx.fillRect(x, y, bw, course * 0.7);
    }

    // Mortar: a dark line with a hairline of light beneath, which is what gives stone edges.
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.beginPath();
    ctx.moveTo(0, y + 1);
    ctx.lineTo(w, y + 1);
    ctx.stroke();

    for (let block = -1; block < 8; block++) {
      const x = offset + (block * w) / 3.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + course);
      ctx.stroke();
    }
  }

  // Light from somewhere above and left, so the wall has a direction.
  const key = ctx.createLinearGradient(0, 0, w * 0.9, h);
  key.addColorStop(0, 'rgba(150,180,220,0.09)');
  key.addColorStop(0.5, 'rgba(150,180,220,0.02)');
  key.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, w, h);

  return layer;
}

/**
 * A tile of grain. Perfectly smooth gradients are the loudest tell that a picture was
 * computed rather than captured; a faint layer of noise over everything is most of the
 * difference between a render and a photograph.
 */
function makeGrain(size = 128): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext('2d');
  if (!ctx) return tile;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

/** The bell over the top rung: yoke, crown, shoulder, lip, and a clapper that swings. */
function paintBell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  lit: boolean,
  swing: number,
) {
  ctx.save();
  ctx.translate(x, y);

  // The headstock the bell hangs from stays put; only the bell swings.
  ctx.fillStyle = '#3a2f21';
  ctx.fillRect(-size * 0.62, -size * 0.92, size * 1.24, size * 0.16);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(-size * 0.62, -size * 0.92, size * 1.24, size * 0.04);

  ctx.rotate(swing);

  if (lit) {
    ctx.shadowColor = 'rgba(255,214,138,0.85)';
    ctx.shadowBlur = size * 1.1;
  }

  const body = ctx.createLinearGradient(-size * 0.6, 0, size * 0.6, 0);
  if (lit) {
    body.addColorStop(0, '#8a6a2e');
    body.addColorStop(0.32, '#ffe9ad');
    body.addColorStop(0.62, '#d8a94e');
    body.addColorStop(1, '#6d5223');
  } else {
    body.addColorStop(0, '#4a3f2c');
    body.addColorStop(0.32, '#9a8358');
    body.addColorStop(0.62, '#6b5a3b');
    body.addColorStop(1, '#3b3123');
  }
  ctx.fillStyle = body;

  // Crown loop.
  ctx.beginPath();
  ctx.arc(0, -size * 0.7, size * 0.13, Math.PI, 0);
  ctx.lineTo(size * 0.08, -size * 0.55);
  ctx.lineTo(-size * 0.08, -size * 0.55);
  ctx.closePath();
  ctx.fill();

  // Shoulder curving out to the lip — the profile is what makes a bell read as a bell.
  ctx.beginPath();
  ctx.moveTo(-size * 0.2, -size * 0.58);
  ctx.bezierCurveTo(-size * 0.34, -size * 0.4, -size * 0.44, size * 0.05, -size * 0.56, size * 0.42);
  ctx.lineTo(-size * 0.62, size * 0.52);
  ctx.lineTo(size * 0.62, size * 0.52);
  ctx.lineTo(size * 0.56, size * 0.42);
  ctx.bezierCurveTo(size * 0.44, size * 0.05, size * 0.34, -size * 0.4, size * 0.2, -size * 0.58);
  ctx.closePath();
  ctx.fill();

  // The lip catches the most light.
  ctx.shadowBlur = 0;
  ctx.fillStyle = lit ? 'rgba(255,246,214,0.9)' : 'rgba(190,170,130,0.35)';
  ctx.fillRect(-size * 0.62, size * 0.44, size * 1.24, size * 0.07);

  // Clapper, trailing the swing.
  ctx.fillStyle = lit ? '#7a5c25' : '#2e271c';
  ctx.beginPath();
  ctx.arc(-swing * size * 1.6, size * 0.34, size * 0.11, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
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
    const settled =
      startedAt === 0 ? previousTo : waterlineAt(from, previousTo, (now - startedAt) / 1000);

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
    const grain = makeGrain();
    const grainPattern = ctx.createPattern(grain, 'repeat');
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
      const waterline = reduceMotion
        ? rise.to
        : waterlineAt(rise.from, rise.to, (now - rise.startedAt) / 1000);
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
      const bellSize = Math.min(w, h) * 0.075;
      const swing = crowned && !reduceMotion ? Math.sin(t * 7.5) * 0.22 * surge : 0;
      paintBell(ctx, w / 2, rungY(RUNGS) * h - h * 0.075, bellSize, crowned, swing);

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

      // The rails carry on down through the water, dimmed and wavering.
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#8d7350';
      for (const x of [railInset, w - railInset - railWidth]) {
        for (let y = waterY; y < h; y += 4) {
          const waver = reduceMotion ? 0 : Math.sin(y * 0.13 + phaseT * 2.4) * railWidth * 0.5;
          ctx.fillRect(x + waver, y, railWidth, 4);
        }
      }
      ctx.restore();

      // A bright band just beneath the surface, where light gets in before the water takes
      // it. Without this the water is a flat sheet of colour.
      const shallows = ctx.createLinearGradient(0, waterY, 0, waterY + h * 0.09);
      shallows.addColorStop(0, 'rgba(168,232,250,0.24)');
      shallows.addColorStop(1, 'rgba(168,232,250,0)');
      ctx.fillStyle = shallows;
      ctx.fillRect(0, waterY, w, h * 0.09);

      // ---- atmosphere ------------------------------------------------------------------
      const vignette = ctx.createRadialGradient(
        w / 2, h * 0.45, Math.min(w, h) * 0.4,
        w / 2, h * 0.45, Math.max(w, h) * 0.85,
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      if (grainPattern) {
        ctx.save();
        ctx.globalAlpha = 0.04;
        ctx.globalCompositeOperation = 'overlay';
        const shift = reduceMotion ? 0 : Math.floor(t * 12) % 16;
        ctx.translate(shift, (shift * 7) % 16);
        ctx.fillStyle = grainPattern;
        ctx.fillRect(-16, -16, w + 32, h + 32);
        ctx.restore();
      }
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
