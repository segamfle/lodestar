import { useEffect, useRef, useState } from 'react';
import { GRID, PALETTE, type PaintedCell } from '../lib/codec';

interface TrayProps {
  /** The tray, replayed. One entry per cell, null where nobody has painted. */
  picture: readonly (PaintedCell | null)[];
  /** The colour the player is holding, previewed under the cursor. */
  colour: number;
  /** A cell painted locally and not yet confirmed, drawn dimmed until the chain agrees. */
  pending: { x: number; y: number; colour: number } | null;
  /** Newest confirmed signature, so the cell it painted can be flashed. */
  justLanded: { x: number; y: number; at: number } | null;
  disabled: boolean;
  onPaint(x: number, y: number): void;
  onHover(cell: PaintedCell | null): void;
}

/** Unpainted tray. Not black - an empty baking tray is metal, and metal has a sheen. */
const EMPTY = '#0f0c0a';

export function Tray({ picture, colour, pending, justLanded, disabled, onPaint, onHover }: TrayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const stateRef = useRef({ picture, colour, pending, justLanded, hover, disabled });
  stateRef.current = { picture, colour, pending, justLanded, hover, disabled };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let size = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      size = Math.min(rect.width, rect.height);
      if (size < 1) return;
      canvas.width = Math.round(size * ratio);
      canvas.height = Math.round(size * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (size < 1) return;
      const {
        picture: cells,
        colour: held,
        pending: waiting,
        justLanded: landed,
        hover: over,
        disabled: locked,
      } = stateRef.current;

      const cell = size / GRID;

      ctx.fillStyle = EMPTY;
      ctx.fillRect(0, 0, size, size);

      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const painted = cells[y * GRID + x];
          if (!painted) continue;
          ctx.fillStyle = PALETTE[painted.colour];
          ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
        }
      }

      // The stroke in flight. Half-there on purpose: it is a promise, not a fact, until the
      // chain confirms it, and drawing it solid would be the app claiming something it does
      // not yet know.
      if (waiting) {
        ctx.save();
        ctx.globalAlpha = 0.45 + 0.25 * Math.sin(now / 180);
        ctx.fillStyle = PALETTE[waiting.colour];
        ctx.fillRect(waiting.x * cell, waiting.y * cell, cell + 0.5, cell + 0.5);
        ctx.restore();
      }

      // A ring thrown out from a cell the chain has just taken.
      if (landed) {
        const age = (now - landed.at) / 1000;
        if (age < 1.1) {
          const fade = 1 - age / 1.1;
          ctx.strokeStyle = `rgba(255,244,214,${(fade * 0.9).toFixed(3)})`;
          ctx.lineWidth = Math.max(1, cell * 0.35 * fade);
          const spread = cell * (0.6 + (1 - fade) * 4);
          ctx.strokeRect(
            landed.x * cell + cell / 2 - spread / 2,
            landed.y * cell + cell / 2 - spread / 2,
            spread,
            spread,
          );
        }
      }

      // A grid, but only once the cells are big enough for it to help rather than buzz.
      if (cell > 6) {
        ctx.strokeStyle = 'rgba(255,255,255,0.045)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < GRID; i++) {
          const at = Math.round(i * cell) + 0.5;
          ctx.moveTo(at, 0);
          ctx.lineTo(at, size);
          ctx.moveTo(0, at);
          ctx.lineTo(size, at);
        }
        ctx.stroke();
      }

      if (over && !locked) {
        ctx.fillStyle = PALETTE[held];
        ctx.globalAlpha = 0.55;
        ctx.fillRect(over.x * cell, over.y * cell, cell, cell);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = Math.max(1, cell * 0.12);
        ctx.strokeRect(over.x * cell + 0.5, over.y * cell + 0.5, cell - 1, cell - 1);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  /** Which cell a pointer is over. Derived from the box the canvas actually occupies. */
  const cellAt = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const side = Math.min(rect.width, rect.height);
    const x = Math.floor(((event.clientX - rect.left) / side) * GRID);
    const y = Math.floor(((event.clientY - rect.top) / side) * GRID);
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return null;
    return { x, y };
  };

  return (
    <canvas
      ref={canvasRef}
      className={`tray-canvas${disabled ? ' is-locked' : ''}`}
      role="img"
      aria-label={`A ${GRID} by ${GRID} tray. ${picture.filter(Boolean).length} cells painted.`}
      onPointerMove={(event) => {
        const at = cellAt(event);
        setHover(at);
        onHover(at ? picture[at.y * GRID + at.x] : null);
      }}
      onPointerLeave={() => {
        setHover(null);
        onHover(null);
      }}
      onClick={(event) => {
        if (disabled) return;
        const at = cellAt(event);
        if (at) onPaint(at.x, at.y);
      }}
    />
  );
}
