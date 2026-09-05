/**
 * Turn Constellation's solved paytable into exact on-chain integers, and prove the rounding
 * did not break it.
 *
 * The solver works in floating point, which is fine for choosing a design and useless for a
 * contract. Multipliers are stored as WAD integers (1e18 = 1.0) and the jam checks that
 * declared RTP matches the actual paytable, so "it was 0.96 before we rounded" is not an
 * answer.
 *
 * The first attempt here rounded each float multiplier straight to WAD with
 * Math.round(value * 1e18) and drifted 167 wei per unit staked. The reason is visible in its
 * own output: a clean 15x came out as 14999999999999997952. Anything above 2^53 cannot be
 * represented exactly as a double, so scaling by 1e18 in floating point throws away the low
 * three digits before the value is ever a BigInt.
 *
 * So the float curve is used only for its *shape*. Completion prizes are exact integers by
 * definition. Middle tiers are rounded at six decimals, which stays well inside double
 * precision. And the lowest paying tier is not rounded at all - it is solved in integers to
 * absorb whatever the others left over:
 *
 *     M(t) = (RTP_WAD * TOTAL - sum over higher tiers of ways(h) * M(h)) / ways(t)
 *
 * That leaves a remainder smaller than the number of possible draws, so the error is under
 * one wei per unit staked, and it lands on the most common paying outcome where it distorts
 * the game least.
 *
 *     node games/constellation/emit-table.mjs
 */

const CELLS = 25;
const STARS = 7;
const WAD = 10n ** 18n;
const RTP_WAD = 960000000000000000n;

/** Solved in solve-paytable.mjs: where each shape size starts paying. */
const THRESHOLD = { 3: 2, 4: 2, 5: 3, 6: 3 };

/** Solved in solve-paytable.mjs: what completing each shape is worth. Exact by choice. */
const TOP = { 3: 15n, 4: 22n, 5: 32n, 6: 48n };

function choose(n, k) {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  const big = BigInt(n);
  for (let i = 0n; i < BigInt(k); i++) result = (result * (big - i)) / (i + 1n);
  return result;
}

/** Unnormalised hypergeometric count: how many of the possible draws give exactly `hits`. */
const ways = (size, hits) => choose(size, hits) * choose(CELLS - size, STARS - hits);

const TOTAL = choose(CELLS, STARS);

/** Geometric climb from the first paying tier to a complete shape. */
function shape(size, threshold, ratio) {
  const tiers = size - threshold;
  return Array.from({ length: size + 1 }, (_, hits) =>
    hits < threshold ? 0 : tiers === 0 ? 1 : Math.pow(ratio, (hits - threshold) / tiers),
  );
}

/** Steepness that lands the completion prize on its target, by bisection. */
function solveRatio(size, threshold, targetTop) {
  const probabilities = Array.from(
    { length: size + 1 },
    (_, h) => Number(ways(size, h)) / Number(TOTAL),
  );
  let low = 1;
  let high = 5000;
  for (let i = 0; i < 300; i++) {
    const mid = (low + high) / 2;
    const w = shape(size, threshold, mid);
    const scale = 0.96 / probabilities.reduce((sum, p, h) => sum + p * w[h], 0);
    if (w[size] * scale < targetTop) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Six decimal places, taken as an integer before it ever meets 1e18. */
function toWad(value) {
  return BigInt(Math.round(value * 1e6)) * 10n ** 12n;
}

console.log('Constellation paytable as on-chain integers');
console.log(CELLS + ' cells, ' + STARS + ' lit per draw, C(25,7) = ' + TOTAL + ' equally likely draws');
console.log('');

const solidity = [];
let worstDrift = 0n;
let broken = false;

for (const size of [3, 4, 5, 6]) {
  const threshold = THRESHOLD[size];
  const ratio = solveRatio(size, threshold, Number(TOP[size]));
  const curve = shape(size, threshold, ratio);

  const probabilities = Array.from(
    { length: size + 1 },
    (_, h) => Number(ways(size, h)) / Number(TOTAL),
  );
  const scale = 0.96 / probabilities.reduce((sum, p, h) => sum + p * curve[h], 0);

  const multipliers = new Array(size + 1).fill(0n);
  multipliers[size] = TOP[size] * WAD;
  for (let h = threshold + 1; h < size; h++) multipliers[h] = toWad(curve[h] * scale);

  // Solve the lowest paying tier in integers so the whole table lands on RTP.
  let committed = 0n;
  for (let h = threshold + 1; h <= size; h++) committed += ways(size, h) * multipliers[h];
  const remaining = RTP_WAD * TOTAL - committed;
  multipliers[threshold] = remaining / ways(size, threshold);

  let numerator = 0n;
  for (let h = 0; h <= size; h++) numerator += ways(size, h) * multipliers[h];
  const drift = (RTP_WAD * TOTAL - numerator) / TOTAL;
  const absDrift = drift < 0n ? -drift : drift;
  if (absDrift > worstDrift) worstDrift = absDrift;

  const stepwise = multipliers.every((m, i) => i === 0 || m >= multipliers[i - 1]);
  if (!stepwise) broken = true;

  console.log('Shape of ' + size + ' cells, pays from ' + threshold + ' hits:');
  for (let h = 0; h <= size; h++) {
    const count = ways(size, h);
    const share = ((Number(count) / Number(TOTAL)) * 100).toFixed(4);
    console.log(
      '  ' + h + ' hits  ' + String(count).padStart(7) + ' draws (' + share.padStart(8) + '%)  ' +
        (multipliers[h] === 0n
          ? 'no pay'
          : (Number(multipliers[h]) / 1e18).toFixed(6) + 'x = ' + multipliers[h]),
    );
  }
  console.log(
    '  return ' + (absDrift === 0n ? 'is exactly 0.96' : 'is 0.96 to within ' + absDrift + ' wei per unit staked') +
      (stepwise ? '' : '   NON-MONOTONE'),
  );
  console.log('');

  solidity.push(
    '    if (size == ' + size + ') {\n' +
      multipliers
        .map((m, h) => (m === 0n ? null : '      if (hits == ' + h + ') return ' + m + ';'))
        .filter(Boolean)
        .reverse()
        .join('\n') +
      '\n      return 0;\n    }',
  );
}

console.log('Worst drift after rounding: ' + worstDrift + ' wei per unit staked.');
const ok = worstDrift <= 2n && !broken;
console.log(
  ok
    ? 'Inside the wei or two the jam tolerates, and every table is non-decreasing. Safe to ship.'
    : 'NOT SAFE - do not write this into the contract.',
);
console.log('');
console.log('--- Solidity ---');
console.log('');
console.log('  function multiplierWad(uint256 size, uint256 hits) internal pure returns (uint256) {');
console.log(solidity.join('\n'));
console.log('    return 0;');
console.log('  }');

process.exit(ok ? 0 : 1);
