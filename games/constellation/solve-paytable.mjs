/**
 * Solve Constellation's payout tables.
 *
 * The board is 25 cells. The draw lights K of them. The player picks a shape of s cells
 * beforehand and is paid on h, how many of their cells came up lit. h is hypergeometric:
 *
 *     P(h | s, K) = C(s,h) * C(25-s, K-h) / C(25, K)
 *
 * The requirement that shapes everything: expected return must be identical for every shape
 * size, or a player who always picks the best size earns a better edge than the declared RTP
 * and the entry fails the jam's eligibility check. So multipliers are never chosen by hand.
 * A weight profile decides the *shape* of each size's curve, and one scale factor per size is
 * solved to force the expectation onto RTP:
 *
 *     M(s,h) = c_s * w(s,h),   c_s = RTP / sum_h P(h|s) * w(s,h)
 *
 * Fairness is then true by construction rather than by luck, whatever weights are chosen.
 *
 * That freedom is what makes the rest solvable. Each shape size gets two dials of its own -
 * the threshold it starts paying at, and how steeply its prizes climb - so the sizes can be
 * tuned to agree on how often they pay and to form a rising ladder of top prizes, without
 * any of it disturbing the return. An earlier version shared one steepness across all sizes
 * and could not satisfy both: of 25,200 combinations, 85 produced a rising ladder and none
 * of those kept the win rates within twelve points of each other.
 *
 *     node games/constellation/solve-paytable.mjs
 */

const CELLS = 25;
const RTP = 0.96;
const SIZES = [3, 4, 5, 6];

/** How often each size should pay something. Equal across sizes, so the choice is variance. */
const TARGET_WIN_RATE = 0.25;

/**
 * What completing a shape pays. Rising, because a bigger shape is rarer to complete and a
 * table where the small shape crowns higher reads to a player as a lie even though the
 * arithmetic is sound.
 */
const TARGET_TOP = { 3: 15, 4: 22, 5: 32, 6: 48 };

/** Exact binomial coefficient. */
function choose(n, k) {
  if (k < 0 || k > n) return 0n;
  let result = 1n;
  const big = BigInt(n);
  for (let i = 0n; i < BigInt(k); i++) {
    result = (result * (big - i)) / (i + 1n);
  }
  return result;
}

function hypergeometric(size, lit, hits) {
  const denominator = choose(CELLS, lit);
  if (denominator === 0n) return 0;
  return Number(choose(size, hits) * choose(CELLS - size, lit - hits)) / Number(denominator);
}

/**
 * Weight profile: nothing below the threshold, then a geometric climb to the full shape.
 * `ratio` is how much more a complete shape is worth than the first paying tier.
 */
function weights(size, threshold, ratio) {
  const tiers = size - threshold;
  const row = [];
  for (let hits = 0; hits <= size; hits++) {
    if (hits < threshold) {
      row.push(0);
      continue;
    }
    row.push(tiers === 0 ? 1 : Math.pow(ratio, (hits - threshold) / tiers));
  }
  return row;
}

function build(size, lit, threshold, ratio) {
  const probabilities = Array.from({ length: size + 1 }, (_, h) =>
    hypergeometric(size, lit, h),
  );
  const w = weights(size, threshold, ratio);

  const weighted = probabilities.reduce((sum, p, h) => sum + p * w[h], 0);
  if (weighted === 0) return null;
  const scale = RTP / weighted;
  const multipliers = w.map((value) => value * scale);

  return {
    size,
    threshold,
    ratio,
    probabilities,
    multipliers,
    expected: probabilities.reduce((sum, p, h) => sum + p * multipliers[h], 0),
    winChance: probabilities.reduce((sum, p, h) => sum + (multipliers[h] > 0 ? p : 0), 0),
    top: multipliers[size],
  };
}

/**
 * Find the steepness that lands the completion prize on its target.
 *
 * The top prize rises monotonically with the ratio, so bisection is enough and needs no
 * derivative. A threshold equal to the size has only one paying tier and therefore a fixed
 * prize; there is nothing to solve, and the caller checks how close it landed.
 */
function solveRatio(size, lit, threshold, targetTop) {
  if (threshold >= size) return build(size, lit, threshold, 1);

  let low = 1;
  let high = 5000;
  let result = null;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    result = build(size, lit, threshold, mid);
    if (!result) return null;
    if (result.top < targetTop) low = mid;
    else high = mid;
  }
  return result;
}

/** The threshold whose win rate lands closest to the shared target. */
function bestThreshold(size, lit) {
  let best = null;
  for (let threshold = 1; threshold <= size; threshold++) {
    const winChance = Array.from({ length: size + 1 }, (_, h) =>
      hypergeometric(size, lit, h),
    )
      .slice(threshold)
      .reduce((sum, p) => sum + p, 0);
    const distance = Math.abs(winChance - TARGET_WIN_RATE);
    if (!best || distance < best.distance) best = { threshold, winChance, distance };
  }
  return best;
}

console.log('Solving each shape size independently: threshold for how often it pays,');
console.log('steepness for what completing it is worth. Return is forced to ' + RTP + ' either way.');
console.log('');

let chosen = null;
for (const lit of [5, 6, 7, 8, 9, 10, 11, 12, 13]) {
  const rows = SIZES.map((size) => {
    const { threshold } = bestThreshold(size, lit);
    return solveRatio(size, lit, threshold, TARGET_TOP[size]);
  });
  if (rows.some((r) => r === null)) continue;

  const chances = rows.map((r) => r.winChance);
  const spread = Math.max(...chances) - Math.min(...chances);
  const topError = Math.max(...rows.map((r) => Math.abs(r.top - TARGET_TOP[r.size])));
  const tops = rows.map((r) => r.top);

  const fair = rows.every((r) => Math.abs(r.expected - RTP) < 1e-12);
  const stepwise = rows.every((r) =>
    r.multipliers.every((m, i) => i === 0 || m >= r.multipliers[i - 1]),
  );
  const rising = tops.every((t, i) => i === 0 || t > tops[i - 1]);

  const ladder = rows
    .map((r) => 's' + r.size + ':' + r.top.toFixed(1) + 'x@' + (r.winChance * 100).toFixed(0) + '%')
    .join('  ');
  const flags =
    (fair ? '' : ' UNFAIR') + (stepwise ? '' : ' NON-MONOTONE') + (rising ? '' : ' TOPS-FALL');
  console.log(
    '  K=' + String(lit).padStart(2) +
      '  win spread ' + (spread * 100).toFixed(1).padStart(5) + 'pp' +
      '  top error ' + topError.toFixed(2).padStart(6) + 'x' +
      '  [' + ladder + ']' + flags,
  );

  if (!fair || !stepwise || !rising) continue;
  if (topError > 0.01) continue;
  if (!chosen || spread < chosen.spread) chosen = { lit, rows, spread, topError };
}

if (!chosen) {
  console.log('');
  console.log('No star count met every requirement.');
  process.exit(1);
}

console.log('');
console.log('');
console.log('CHOSEN - ' + chosen.lit + ' stars lit on a 25-cell board');
console.log('');

for (const row of chosen.rows) {
  console.log(
    'Shape of ' + row.size + ' cells - pays from ' + row.threshold + ' hits, ' +
      'steepness ' + row.ratio.toFixed(4),
  );
  for (let h = 0; h <= row.size; h++) {
    const p = row.probabilities[h];
    const m = row.multipliers[h];
    console.log(
      '  ' + h + ' hit' + (h === 1 ? ' ' : 's') +
        '  P=' + p.toFixed(8) +
        '  M=' + (m === 0 ? '-' : m.toFixed(6) + 'x').padStart(12) +
        '  contributes ' + (p * m).toFixed(8),
    );
  }
  console.log(
    '  expected return ' + row.expected.toFixed(12) +
      '   paid on ' + (row.winChance * 100).toFixed(2) + '% of rounds',
  );
  console.log('');
}

const worstDrift = Math.max(...chosen.rows.map((r) => Math.abs(r.expected - RTP)));
console.log('Every shape size returns ' + RTP + ' (worst drift ' + worstDrift.toExponential(2) + ').');
console.log(
  'Win rates within ' + (chosen.spread * 100).toFixed(1) + ' points of each other; ' +
    'top prizes rise ' + chosen.rows.map((r) => r.top.toFixed(0) + 'x').join(' -> ') + '.',
);
