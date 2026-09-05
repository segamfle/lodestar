/**
 * The tide's geometry and timing, shared by everything that needs to know where the water is.
 *
 * The canvas draws from this, and the audio schedules bell strikes from it, so a rung chimes
 * at the moment the water actually covers it rather than at a guessed offset. Two copies of
 * this curve would drift apart within a week.
 */

import { RUNGS } from './tideline.ts';

/** Where each rung sits vertically, as a fraction of the scene height from the top. */
export const RUNG_TOP = 0.12;
export const RUNG_BOTTOM = 0.82;

/** Waterline when the ladder is dry — below the lowest rung, still visible. */
export const WATER_REST = 0.94;

/**
 * Time constant of the climb, in seconds. The water covers most of the distance in about a
 * second and a half and keeps creeping after, which is the shape that makes a rise feel like
 * it might stop just short of your rung.
 */
export const TIDE_TAU = 0.42;

export const rungY = (rung: number) =>
  RUNG_TOP + ((RUNGS - rung) / (RUNGS - 1)) * (RUNG_BOTTOM - RUNG_TOP);

/** Waterline for a tide level. Level 0 sits below the ladder; level 6 drowns the top rung. */
export function waterlineFor(level: number): number {
  if (level <= 0) return WATER_REST;
  // Settle a little above the rung it covers, so a covered rung reads as submerged rather
  // than merely touched.
  return rungY(Math.min(level, RUNGS)) - 0.018;
}

/** Waterline `seconds` into a climb from `from` toward `to`. */
export function waterlineAt(from: number, to: number, seconds: number): number {
  return from + (to - from) * (1 - Math.exp(-Math.max(seconds, 0) / TIDE_TAU));
}

/**
 * When the rising water crosses each rung, in seconds from the start of the climb.
 *
 * Solved rather than sampled: the curve is `from + (to - from)(1 - e^(-t/tau))`, so the
 * crossing time for a rung at height y is `-tau * ln((to - y) / (to - from))`. Rungs the
 * water never reaches are left out.
 */
export function rungCrossings(from: number, to: number): { rung: number; at: number }[] {
  const crossings: { rung: number; at: number }[] = [];
  const span = to - from;
  if (span >= 0) return crossings; // the water is falling or still; nothing gets covered

  for (let rung = 1; rung <= RUNGS; rung++) {
    const y = rungY(rung);
    if (y <= to || y >= from) continue; // already wet, or never reached
    const ratio = (to - y) / span;
    if (ratio <= 0 || ratio >= 1) continue;
    crossings.push({ rung, at: -TIDE_TAU * Math.log(ratio) });
  }
  return crossings.sort((a, b) => a.at - b.at);
}
