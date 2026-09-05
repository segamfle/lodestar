/**
 * Check the rules the interface believes in.
 *
 * The contract is the authority, and `verify-rtp.mjs` proves the contract against a running
 * chain. This checks the copy the browser reads from - because if the two drift, the odds a
 * player sees while choosing a shape stop matching the odds they actually get, and nothing
 * anywhere throws.
 *
 *     node src/lib/constellation.test.mts
 */

import {
  CELLS,
  MAX_SHAPE,
  MIN_SHAPE,
  RTP_WAD,
  STARS,
  TOTAL_SKIES,
  countCells,
  chanceOfAnyReturn,
  demoSky,
  multiplierWad,
  outcomesFor,
  waysToHit,
} from './constellation.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
};

// ---------------------------------------------------------------- the tables

console.log('--- return, computed from the tables the browser uses ---');

for (let size = MIN_SHAPE; size <= MAX_SHAPE; size++) {
  let numerator = 0n;
  for (let hits = 0; hits <= size; hits++) {
    numerator += waysToHit(size, hits) * multiplierWad(size, hits);
  }
  const target = RTP_WAD * TOTAL_SKIES;
  const drift = numerator > target ? numerator - target : target - numerator;

  check(
    drift / TOTAL_SKIES <= 2n,
    `size ${size} returns 0.96`,
    `drift ${drift / TOTAL_SKIES} wei per unit staked`,
  );

  const multipliers = Array.from({ length: size + 1 }, (_, hits) => multiplierWad(size, hits));
  check(
    multipliers.every((m, i) => i === 0 || m >= multipliers[i - 1]),
    `size ${size} never pays less for more hits`,
  );

  const top = Number(multipliers[size]) / 1e18;
  check(top < 100, `size ${size} stays under the 100x heavy-tail ceiling`, `${top.toFixed(0)}x`);
}

// A completion prize that fell as the shape grew would be arithmetically fine and read to a
// player as a lie, so the ladder is part of the contract with them.
const tops = Array.from({ length: MAX_SHAPE - MIN_SHAPE + 1 }, (_, i) =>
  multiplierWad(MIN_SHAPE + i, MIN_SHAPE + i),
);
check(
  tops.every((t, i) => i === 0 || t > tops[i - 1]),
  'a bigger shape always crowns higher',
  tops.map((t) => `${Number(t) / 1e18}x`).join(' -> '),
);

console.log('');
console.log('--- what each shape size offers ---');
for (let size = MIN_SHAPE; size <= MAX_SHAPE; size++) {
  const rows = outcomesFor(size)
    .map((r) => `${r.hits}/${size} pays ${r.multiplierX.toFixed(2)}x at ${(r.chance * 100).toFixed(2)}%`)
    .join(', ');
  console.log(`  ${size} cells: ${rows}`);
  console.log(`            pays at all ${(chanceOfAnyReturn(size) * 100).toFixed(2)}% of the time`);
}

// ---------------------------------------------------------------- the demo draw

console.log('');
console.log('--- the standalone demo sky ---');

const DRAWS = 20000;
const cellCounts = new Array(CELLS).fill(0);
let wrongCount = 0;

for (let i = 0; i < DRAWS; i++) {
  const sky = demoSky();
  if (countCells(sky) !== STARS) wrongCount++;
  for (let cell = 0; cell < CELLS; cell++) {
    if ((sky >> BigInt(cell)) & 1n) cellCounts[cell]++;
  }
}

check(wrongCount === 0, `every demo draw lights exactly ${STARS} distinct cells`, wrongCount ? `${wrongCount} bad` : '');

// Each cell should turn up in 7 of every 25 draws. A biased shuffle would still light seven
// cells and still pay out, so the only way to catch one is to count.
const expected = (DRAWS * STARS) / CELLS;
const sigma = Math.sqrt(DRAWS * (STARS / CELLS) * (1 - STARS / CELLS));
const worst = cellCounts.reduce(
  (acc, count, cell) => {
    const z = Math.abs(count - expected) / sigma;
    return z > acc.z ? { cell, count, z } : acc;
  },
  { cell: -1, count: 0, z: 0 },
);
check(
  worst.z < 5,
  'no cell is favoured by the demo draw',
  `worst is cell ${worst.cell}, ${worst.count} vs ${expected.toFixed(0)} expected, ${worst.z.toFixed(2)} sigma`,
);

console.log('');
console.log(failures === 0 ? 'The board tells the truth.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
