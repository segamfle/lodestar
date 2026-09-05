/**
 * Constellation's rules, mirrored from `ConstellationGame.sol`.
 *
 * The contract is the authority. This exists so the board can show what a shape is worth
 * before the chain settles anything, and so the odds a player reads while choosing are the
 * odds they actually face. Where the contract truncates with integer division, so does this.
 */

export const COLUMNS = 5;
export const ROWS = 5;
export const CELLS = COLUMNS * ROWS;

/** How many cells light on every draw. */
export const STARS = 7;

export const MIN_SHAPE = 3;
export const MAX_SHAPE = 6;

export const WAD = 10n ** 18n;
export const RTP_WAD = 960000000000000000n;

/**
 * The paytable, copied verbatim from the contract.
 *
 * These are exact integers, not rounded decimals. `games/constellation/emit-table.mjs`
 * derives them: completion prizes are whole numbers by choice, middle tiers are rounded at
 * six decimals where doubles are still exact, and the lowest paying tier of each size is
 * solved in integer arithmetic to absorb the remainder. That is why every shape size returns
 * exactly 96% rather than approximately. Do not hand-edit - regenerate.
 */
const PAYTABLE: Record<number, Record<number, bigint>> = {
  3: { 2: 4452380952380952380n, 3: 15000000000000000000n },
  4: { 2: 2181592794895736072n, 3: 6927845000000000000n, 4: 22000000000000000000n },
  5: { 3: 7568349333333333333n, 4: 15562364000000000000n, 5: 32000000000000000000n },
  6: {
    3: 3959243994117647058n,
    4: 9095402000000000000n,
    5: 20894481000000000000n,
    6: 48000000000000000000n,
  },
};

export function multiplierWad(size: number, hits: number): bigint {
  return PAYTABLE[size]?.[hits] ?? 0n;
}

/** Exact binomial coefficient. */
function choose(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  const big = BigInt(n);
  for (let i = 0n; i < BigInt(k); i++) result = (result * (big - i)) / (i + 1n);
  return result;
}

/** How many of the possible skies light exactly `hits` cells of a shape of `size`. */
export const waysToHit = (size: number, hits: number) =>
  choose(size, hits) * choose(CELLS - size, STARS - hits);

/** C(25,7) — every equally likely sky. */
export const TOTAL_SKIES = choose(CELLS, STARS);

export const chanceOf = (size: number, hits: number) =>
  Number(waysToHit(size, hits)) / Number(TOTAL_SKIES);

/** What a shape of this size can do: the odds and prize at every outcome that pays. */
export function outcomesFor(size: number) {
  const rows = [];
  for (let hits = 0; hits <= size; hits++) {
    const multiplier = multiplierWad(size, hits);
    if (multiplier === 0n) continue;
    rows.push({
      hits,
      multiplier,
      multiplierX: Number(multiplier) / 1e18,
      chance: chanceOf(size, hits),
    });
  }
  return rows.reverse(); // best first, the way a paytable is read
}

/** Chance a shape of this size pays anything at all. */
export function chanceOfAnyReturn(size: number): number {
  let total = 0;
  for (let hits = 0; hits <= size; hits++) {
    if (multiplierWad(size, hits) > 0n) total += chanceOf(size, hits);
  }
  return total;
}

export const payoutFor = (wager: bigint, size: number, hits: number) =>
  (wager * multiplierWad(size, hits)) / WAD;

// ---------------------------------------------------------------- board helpers

export const cellIndex = (row: number, column: number) => row * COLUMNS + column;

export const isLit = (mask: bigint, cell: number) => ((mask >> BigInt(cell)) & 1n) === 1n;

export function toggleCell(mask: bigint, cell: number): bigint {
  return mask ^ (1n << BigInt(cell));
}

export function countCells(mask: bigint): number {
  let count = 0;
  let value = mask;
  while (value > 0n) {
    value &= value - 1n;
    count++;
  }
  return count;
}

export const cellsOf = (mask: bigint): number[] =>
  Array.from({ length: CELLS }, (_, cell) => cell).filter((cell) => isLit(mask, cell));

/**
 * Draw a sky locally for the standalone demo, using the same partial Fisher-Yates the
 * contract uses. Never used when a host is present - the chain owns every real outcome - but
 * the jam requires the page to be playable when opened directly, and a demo whose odds
 * differ from the game would misrepresent how the game behaves.
 */
export function demoSky(): bigint {
  const cells = Array.from({ length: CELLS }, (_, i) => i);
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);

  let cursor = 0;
  const nextByte = () => {
    if (cursor >= bytes.length) {
      crypto.getRandomValues(bytes);
      cursor = 0;
    }
    return bytes[cursor++];
  };

  let sky = 0n;
  for (let picked = 0; picked < STARS; picked++) {
    const remaining = CELLS - picked;
    const limit = Math.floor(256 / remaining) * remaining;
    let index = picked;
    for (;;) {
      const b = nextByte();
      if (b < limit) {
        index = picked + (b % remaining);
        break;
      }
    }
    const chosen = cells[index];
    cells[index] = cells[picked];
    cells[picked] = chosen;
    sky |= 1n << BigInt(chosen);
  }
  return sky;
}
