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
export const WATER_REST = 0.9;

/**
 * How long the tide takes to reach the top of the ladder. Shorter climbs take proportionally
 * less time, because the water moves at one speed.
 */
export const TIDE_FULL_RISE = 1.6;

/**
 * Seconds spent easing into the stop, so the water settles rather than halting like a lift.
 *
 * Deliberately short. The waterline comes to rest 0.018 of the scene above the rung it
 * covers, and the eased stretch has to stay inside that gap: any longer and it reaches back
 * across the last rung, so the moment the water crosses it is no longer a straight division
 * and every bell after it rings early. Held under the gap, every crossing stays linear and
 * exactly solvable.
 */
export const TIDE_SETTLE = 0.03;

export const rungY = (rung: number) =>
  RUNG_TOP + ((RUNGS - rung) / (RUNGS - 1)) * (RUNG_BOTTOM - RUNG_TOP);

/** Waterline for a tide level. Level 0 sits below the ladder; level 6 drowns the top rung. */
export function waterlineFor(level: number): number {
  if (level <= 0) return WATER_REST;
  // Settle a little above the rung it covers, so a covered rung reads as submerged rather
  // than merely touched.
  return rungY(Math.min(level, RUNGS)) - 0.018;
}

/**
 * Waterline `seconds` into a climb from `from` toward `to`.
 *
 * Constant speed, not an exponential approach.
 *
 * An exponential is fastest at the very start and only decays, so two different tides
 * separated visibly almost immediately - at 0.42 seconds a level-5 and a level-6 rise were
 * already sixty pixels apart on a normal screen, which told the player the answer a full
 * 1.8 seconds before the game admitted it. There was no suspense mechanism at all. Rising at
 * one speed means every tide looks identical until the one it is going to stop at, and the
 * question stays open until the water stops.
 *
 * The last fraction of a second eases, so it settles instead of halting.
 */
export function waterlineAt(from: number, to: number, seconds: number): number {
  const distance = from - to;
  if (distance <= 0) return to;

  const speed = (WATER_REST - waterlineFor(RUNGS)) / TIDE_FULL_RISE;
  const travel = Math.max(seconds, 0) * speed;
  const remaining = distance - travel;
  if (remaining <= 0) return to;

  // Ease only the final stretch: cubic on the last TIDE_SETTLE seconds of travel.
  const settleDistance = speed * TIDE_SETTLE;
  if (remaining < settleDistance) {
    const progress = 1 - remaining / settleDistance;
    return to + settleDistance * Math.pow(1 - progress, 3);
  }
  return to + remaining;
}

/**
 * When the rising water crosses each rung, in seconds from the start of the climb.
 *
 * Solved rather than sampled, so a bell rings at the moment the water arrives rather than on
 * a guessed offset. At constant speed the crossing time is simply the distance travelled
 * divided by the speed, with the settle stretch ignored - it applies only past the last rung
 * the tide reaches. Rungs the water never gets to are left out.
 */
export function rungCrossings(from: number, to: number): { rung: number; at: number }[] {
  const crossings: { rung: number; at: number }[] = [];
  const span = to - from;
  if (span >= 0) return crossings; // the water is falling or still; nothing gets covered

  const speed = (WATER_REST - waterlineFor(RUNGS)) / TIDE_FULL_RISE;
  for (let rung = 1; rung <= RUNGS; rung++) {
    const y = rungY(rung);
    if (y <= to || y >= from) continue; // already wet, or never reached
    crossings.push({ rung, at: (from - y) / speed });
  }
  return crossings.sort((a, b) => a.at - b.at);
}
