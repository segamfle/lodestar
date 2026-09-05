import { useEffect, useRef } from 'react';
import { COLUMNS, ROWS, boardGrid, isLit } from '../lib/constellation';

export type SkyPhase = 'idle' | 'lighting' | 'settled';

interface SkyProps {
  /** Cells the player marked, as a 25-bit mask. */
  shape: bigint;
  /** Cells the draw lit, or null while the sky is still dark. */
  sky: bigint | null;
  /** How many stars have arrived so far during the reveal. */
  revealed: number;
  /** Order the stars arrive in, so the reveal is a sequence rather than a flash. */
  order: number[];
  phase: SkyPhase;
  hovered: number | null;
  /** Identifies the round. Changing it clears the record of what has already landed. */
  roundKey: string;
}

/** Seconds a star takes to settle after it lands. Shorter than the gap between arrivals, so
 *  each one is its own beat rather than a smear across the others. */
const BLOOM = 0.26;

/** Seconds the arrival flash lasts - the punch that makes the eye catch each star land. */
const SPARK = 0.34;

/** Deterministic jitter so the grid reads as a sky rather than a spreadsheet. */
function drift(cell: number, axis: number): number {
  const n = Math.sin(cell * 78.233 + axis * 12.9898) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

/**
 * A tile of monochrome grain.
 *
 * Perfectly smooth gradients are the loudest tell that a picture was computed rather than
 * captured - the eye reads banding and cleanliness as synthetic long before it can say why.
 * A faint layer of noise over everything is most of the difference between a gradient and a
 * photograph of the night.
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

export function Sky({ shape, sky, revealed, order, phase, hovered, roundKey }: SkyProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Props read through a ref so the animation loop is built once and never torn down by a
  // pointer moving across the board.
  const stateRef = useRef({ shape, sky, revealed, order, phase, hovered });
  stateRef.current = { shape, sky, revealed, order, phase, hovered };

  /** When each star arrived, in animation time, so its bloom is a function of the clock. */
  const arrivalsRef = useRef<Map<number, number>>(new Map());

  // Cleared per round, not per phase.
  //
  // This was keyed on the phase returning to idle, which the Again button never does - it
  // starts the next round straight from 'settled'. So arrival times survived into the new
  // round, and any cell that had also been lit in the previous one appeared instantly at
  // full brightness, out of sequence and out of step with its sound. The first round after
  // a page load looked right and every one after it looked worse.
  useEffect(() => {
    arrivalsRef.current = new Map();
  }, [roundKey]);

  useEffect(() => {
    const arrivals = arrivalsRef.current;
    const now = performance.now();
    for (let i = 0; i < revealed; i++) {
      const cell = order[i];
      if (cell !== undefined && !arrivals.has(cell)) arrivals.set(cell, now);
    }
  }, [revealed, order]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let width = 0;
    let height = 0;
    const grain = makeGrain();
    const grainPattern = ctx.createPattern(grain, 'repeat');

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width < 1 || height < 1) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (width < 1 || height < 1) return;

      const { shape: marks, sky: lit, hovered: hover } = stateRef.current;
      const arrivals = arrivalsRef.current;
      const t = now / 1000;

      const w = width;
      const h = height;

      // Night sky, darker toward the edges so the eye settles on the board.
      const sky2 = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.8);
      sky2.addColorStop(0, '#1b2440');
      sky2.addColorStop(0.45, '#111830');
      sky2.addColorStop(1, '#080b16');
      ctx.fillStyle = sky2;
      ctx.fillRect(0, 0, w, h);

      const { left, top, step } = boardGrid(w, h);
      const radius = step * 0.5;

      for (let row = 0; row < ROWS; row++) {
        for (let column = 0; column < COLUMNS; column++) {
          const cell = row * COLUMNS + column;
          const x = left + step * (column + 0.5) + drift(cell, 0) * step * 0.06;
          const y = top + step * (row + 0.5) + drift(cell, 1) * step * 0.06;

          const marked = isLit(marks, cell);
          const starHere = lit !== null && isLit(lit, cell);
          const arrivedAt = arrivals.get(cell);
          const age = arrivedAt === undefined ? -1 : (now - arrivedAt) / 1000;
          const bloom = age < 0 ? 0 : reduceMotion ? 1 : Math.min(age / BLOOM, 1);

          // The point every cell keeps, so an empty board still reads as sky. Brightness
          // varies per cell and drifts slowly: a lattice of identical dots looks printed,
          // and a sky that holds perfectly still looks dead.
          const base = 0.44 + drift(cell, 2) * 0.2;
          const twinkle = reduceMotion ? 0 : Math.sin(t * 0.7 + cell * 1.7) * 0.14;
          const faint = Math.max(0.2, base + twinkle);
          ctx.beginPath();
          ctx.arc(x, y, radius * (0.07 + faint * 0.035), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(196,214,246,${faint.toFixed(3)})`;
          ctx.fill();

          // The ring the player drew.
          if (marked) {
            const pulse = phaseIdle(stateRef.current.phase) ? 0.14 * Math.sin(t * 2 + cell) : 0;
            ctx.beginPath();
            ctx.arc(x, y, radius * (0.52 + pulse * 0.1), 0, Math.PI * 2);
            ctx.strokeStyle = starHere && bloom > 0
              ? `rgba(255,226,150,${0.55 + 0.45 * bloom})`
              : 'rgba(126,180,255,0.75)';
            ctx.lineWidth = Math.max(1.5, radius * 0.09);
            ctx.stroke();
          }

          if (hover === cell && !marked) {
            ctx.beginPath();
            ctx.arc(x, y, radius * 0.52, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(126,180,255,0.3)';
            ctx.lineWidth = Math.max(1, radius * 0.06);
            ctx.stroke();
          }

          // A star that has arrived.
          if (starHere && bloom > 0) {
            const brightness = marked ? 1 : 0.62;
            const spark = age >= 0 && age < SPARK ? 1 - age / SPARK : 0;

            // A ring of light thrown outward on arrival. Without a moment of impact the eye
            // slides over a star that simply faded up, and seven of them become one event.
            if (spark > 0 && !reduceMotion) {
              const ring = radius * (0.3 + (1 - spark) * 2.1);
              ctx.strokeStyle = `rgba(255,244,214,${(spark * spark * 0.55 * brightness).toFixed(3)})`;
              ctx.lineWidth = Math.max(1, radius * 0.09 * spark);
              ctx.beginPath();
              ctx.arc(x, y, ring, 0, Math.PI * 2);
              ctx.stroke();
            }

            // Overshoot on landing, then settle.
            const punch = 1 + spark * spark * 0.7;
            const core = radius * (0.16 + 0.1 * bloom) * brightness * punch;

            const reach = radius * (1.4 * bloom + 0.5 * spark);
            const halo = ctx.createRadialGradient(x, y, 0, x, y, reach);
            halo.addColorStop(0, `rgba(255,248,220,${((0.5 + spark * 0.4) * bloom * brightness).toFixed(3)})`);
            halo.addColorStop(0.35, `rgba(255,214,140,${(0.22 * bloom * brightness).toFixed(3)})`);
            halo.addColorStop(1, 'rgba(255,214,140,0)');
            ctx.fillStyle = halo;
            ctx.beginPath();
            ctx.arc(x, y, reach, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(x, y, core, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,252,240,${Math.min(1, bloom * 1.2)})`;
            ctx.fill();

            // Four points of light, the way a bright star reads to the eye.
            const spike = radius * (0.9 + 0.25 * Math.sin(t * 3 + cell)) * bloom * brightness;
            ctx.strokeStyle = `rgba(255,240,200,${0.4 * bloom * brightness})`;
            ctx.lineWidth = Math.max(1, radius * 0.035);
            ctx.beginPath();
            ctx.moveTo(x - spike, y);
            ctx.lineTo(x + spike, y);
            ctx.moveTo(x, y - spike);
            ctx.lineTo(x, y + spike);
            ctx.stroke();
          }
        }
      }

      // Join the marked cells in reading order, so a shape looks like a constellation rather
      // than a scatter of rings.
      const marked = [];
      for (let cell = 0; cell < ROWS * COLUMNS; cell++) {
        if (isLit(marks, cell)) {
          const row = Math.floor(cell / COLUMNS);
          const column = cell % COLUMNS;
          marked.push({
            x: left + step * (column + 0.5) + drift(cell, 0) * step * 0.06,
            y: top + step * (row + 0.5) + drift(cell, 1) * step * 0.06,
          });
        }
      }
      if (marked.length > 1) {
        ctx.strokeStyle = 'rgba(126,180,255,0.22)';
        ctx.lineWidth = Math.max(1, radius * 0.05);
        ctx.beginPath();
        ctx.moveTo(marked[0].x, marked[0].y);
        for (const point of marked.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }

      // ---- atmosphere ----------------------------------------------------------------
      // Light falls off toward the frame, the way it does through any lens, which pushes the
      // eye to the middle where the board is.
      const vignette = ctx.createRadialGradient(
        w / 2, h * 0.44, Math.min(w, h) * 0.42,
        w / 2, h * 0.44, Math.max(w, h) * 0.85,
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      if (grainPattern) {
        ctx.save();
        ctx.globalAlpha = 0.035;
        ctx.globalCompositeOperation = 'overlay';
        // Shifting the tile each frame keeps it from reading as a fixed texture stuck to
        // the glass.
        const drift16 = reduceMotion ? 0 : Math.floor(t * 12) % 16;
        ctx.translate(drift16, (drift16 * 7) % 16);
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
      className="sky-canvas"
      role="img"
      aria-label={
        sky === null
          ? 'A five by five field of dark sky, waiting for the draw.'
          : 'Seven stars have lit across the field.'
      }
    />
  );
}

const phaseIdle = (phase: SkyPhase) => phase === 'idle';
