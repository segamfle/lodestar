/**
 * Prove Constellation's fairness against the deployed bytecode.
 *
 * Two separate claims, checked separately, because they can fail independently:
 *
 *   1. Every shape size returns exactly 96%. Checked in integer arithmetic against the real
 *      hypergeometric counts, reading the multipliers out of the live contract rather than
 *      from the script that generated them - otherwise this only proves the emitter agrees
 *      with itself.
 *
 *   2. The draw is uniform over all C(25,7) skies. A biased partial Fisher-Yates would still
 *      light seven cells and still pay out, and nothing at runtime would ever complain; the
 *      house edge would just quietly drift away from the declared number. So the contract is
 *      asked to draw thousands of skies and the results are tested against the distribution
 *      they are supposed to follow.
 *
 * Run the SDK stack first, then:
 *     node games/constellation/verify-rtp.mjs
 */

import { createPublicClient, http, encodeAbiParameters, decodeAbiParameters, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const RPC = 'http://127.0.0.1:8545';
const DEPLOYMENT = '../../vendor/casino-sdk/casino-sdk/simulator/local-node/deployed.json';

const CELLS = 25;
const STARS = 7;
const WAD = 10n ** 18n;
const RTP_WAD = 960000000000000000n;
const SIZES = [3, 4, 5, 6];
const DRAWS = 4000;

const abi = parseAbi([
  'function multiplierWad(uint256 size, uint256 hits) pure returns (uint256)',
  'function quoteRiskParams(uint256 wager, bytes gameData) pure returns (uint256 maxPayout, uint256 probabilityWad, uint256 expectedPayout, uint256 subJackpotVarianceScaled)',
  'function onRandomness((uint256,address,address,uint256,uint256,uint256,uint32,bytes,bytes) ctx, bytes32 randomness) pure returns ((bytes,int256,int256,uint8,bool,uint256))',
]);

function choose(n, k) {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  const big = BigInt(n);
  for (let i = 0n; i < BigInt(k); i++) result = (result * (big - i)) / (i + 1n);
  return result;
}

const ways = (size, hits) => choose(size, hits) * choose(CELLS - size, STARS - hits);
const TOTAL = choose(CELLS, STARS);

const deployment = JSON.parse(readFileSync(new URL(DEPLOYMENT, import.meta.url), 'utf8'));
const game = deployment.games.find((g) => g.name === 'ConstellationGame');
if (!game) throw new Error('ConstellationGame is not deployed locally. Drop the .sol into simulator/contracts.');

const client = createPublicClient({ transport: http(RPC) });
const address = game.address;

console.log('ConstellationGame at', address);
console.log(CELLS + ' cells, ' + STARS + ' lit, C(25,7) = ' + TOTAL + ' possible skies');
console.log('');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
};

// ---------------------------------------------------------------- 1. the tables

console.log('--- return, read from the deployed tables ---');
for (const size of SIZES) {
  const multipliers = [];
  for (let hits = 0; hits <= size; hits++) {
    multipliers.push(
      await client.readContract({ address, abi, functionName: 'multiplierWad', args: [BigInt(size), BigInt(hits)] }),
    );
  }

  let numerator = 0n;
  for (let hits = 0; hits <= size; hits++) numerator += ways(size, hits) * multipliers[hits];
  const drift = numerator - RTP_WAD * TOTAL;
  const absDrift = (drift < 0n ? -drift : drift) / TOTAL;

  const stepwise = multipliers.every((m, i) => i === 0 || m >= multipliers[i - 1]);
  const top = Number(multipliers[size]) / 1e18;

  check(absDrift <= 2n, `size ${size} returns 0.96`, `drift ${absDrift} wei, top ${top.toFixed(2)}x`);
  check(stepwise, `size ${size} never pays less for more hits`);
  check(top < 100, `size ${size} stays under the 100x heavy-tail ceiling`, `${top.toFixed(2)}x`);
}

// ---------------------------------------------------------------- 2. the draw

console.log('');
console.log('--- the sky, drawn ' + DRAWS + ' times by the contract ---');

const shape = 0b11111n; // five cells in the bottom row; any shape of the same size behaves alike
const shapeSize = 5;
const gameData = encodeAbiParameters([{ type: 'uint256' }], [shape]);
const wager = 10n ** 18n;

const ctx = (data) => [0n, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', wager, wager, 0n, 0, data, '0x'];

const hitCounts = new Array(shapeSize + 1).fill(0);
const cellCounts = new Array(CELLS).fill(0);
let wrongStarCount = 0;

// Seeds must look like VRF output, not like a counter. A first pass used
// 0x000...00i, whose leading bytes are all zero - the contract dutifully read a zero,
// picked cell `picked` every time, and lit cells 0 through 6 on all four thousand draws.
// The contract was right; the test was feeding it something no VRF would ever produce.
for (let i = 0; i < DRAWS; i++) {
  const seed = ('0x' + randomBytes(32).toString('hex'));
  const result = await client.readContract({
    address,
    abi,
    functionName: 'onRandomness',
    args: [ctx(gameData), seed],
  });

  const [, lit, hits] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
    result[0],
  );

  let bits = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    if ((lit >> BigInt(cell)) & 1n) {
      bits++;
      cellCounts[cell]++;
    }
  }
  if (bits !== STARS) wrongStarCount++;
  hitCounts[Number(hits)]++;
}

check(wrongStarCount === 0, 'every draw lights exactly ' + STARS + ' distinct cells', wrongStarCount ? `${wrongStarCount} bad draws` : '');

// Each cell should appear in 7/25 of draws. With 4000 draws the standard deviation of the
// count is about 26, so a cell more than five sigma out is a real bias, not variance.
const expectedPerCell = (DRAWS * STARS) / CELLS;
const sigma = Math.sqrt(DRAWS * (STARS / CELLS) * (1 - STARS / CELLS));
const worstCell = cellCounts.reduce(
  (worst, count, cell) => {
    const z = Math.abs(count - expectedPerCell) / sigma;
    return z > worst.z ? { cell, count, z } : worst;
  },
  { cell: -1, count: 0, z: 0 },
);
check(
  worstCell.z < 5,
  'no cell is favoured',
  `worst is cell ${worstCell.cell} at ${worstCell.count} vs ${expectedPerCell.toFixed(0)} expected, ${worstCell.z.toFixed(2)} sigma`,
);

// And the hit counts should follow the hypergeometric the paytable was built on.
console.log('');
console.log('  hits   observed   expected');
let chiSquare = 0;
for (let hits = 0; hits <= shapeSize; hits++) {
  const probability = Number(ways(shapeSize, hits)) / Number(TOTAL);
  const expected = probability * DRAWS;
  const observed = hitCounts[hits];
  if (expected >= 5) chiSquare += ((observed - expected) ** 2) / expected;
  console.log(
    '  ' + hits + '      ' + String(observed).padStart(6) + '     ' + expected.toFixed(1).padStart(8),
  );
}
// Four degrees of freedom at most here; 18.47 is the 0.1% critical value, well clear of noise.
check(chiSquare < 18.47, 'hit distribution matches the hypergeometric', `chi-square ${chiSquare.toFixed(2)}`);

// ---------------------------------------------------------------- 3. what the house is told

console.log('');
console.log('--- what the contract promises the risk engine ---');
for (const size of SIZES) {
  const cells = (1n << BigInt(size)) - 1n;
  const [maxPayout, probabilityWad, expectedPayout] = await client.readContract({
    address,
    abi,
    functionName: 'quoteRiskParams',
    args: [wager, encodeAbiParameters([{ type: 'uint256' }], [cells])],
  });

  const declared = (expectedPayout * WAD) / wager;
  const completions = ways(size, size);
  const trueProbability = (completions * WAD) / TOTAL;

  check(declared === RTP_WAD, `size ${size} declares 0.96 to the house`, `${(Number(declared) / 1e16).toFixed(2)}%`);
  check(
    probabilityWad === trueProbability,
    `size ${size} states the true completion chance`,
    `1 in ${(Number(TOTAL) / Number(completions)).toFixed(0)}`,
  );
  check(maxPayout < wager * 100n, `size ${size} max payout under 100x`, `${(Number(maxPayout) / Number(wager)).toFixed(1)}x`);
}

console.log('');
console.log(
  failures === 0
    ? 'Constellation holds: every shape size returns 96% exactly, and the sky is uniform.'
    : `${failures} check(s) FAILED — do not submit.`,
);
process.exit(failures === 0 ? 0 : 1);
