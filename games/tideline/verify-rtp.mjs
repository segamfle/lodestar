/**
 * Prove the RTP invariant against the deployed TidelineGame bytecode.
 *
 * The jam's eligibility check is that declared RTP sits in 93-98% AND matches the actual
 * paytable. Asserting that in a comment is worth nothing; this reads the multipliers out of
 * the live contract, walks all seven tide levels for a wide spread of allocations, and
 * compares the measured expectation against what `quoteRiskParams` promises the house.
 *
 * Run the SDK stack first (`npm start` in the SDK package), then:
 *     node games/tideline/verify-rtp.mjs
 */

import { createPublicClient, http, encodeAbiParameters, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';

const RPC = 'http://127.0.0.1:8545';
const DEPLOYMENT =
  '../../vendor/casino-sdk/casino-sdk/simulator/local-node/deployed.json';

const WAD = 10n ** 18n;
const RUNGS = 6;
const LEVELS = 7;
const DECLARED_RTP_WAD = 960000000000000000n; // 0.96

const abi = parseAbi([
  'function multiplierWad(uint256 rung) pure returns (uint256)',
  'function quoteRiskParams(uint256 wager, bytes gameData) pure returns (uint256 maxPayout, uint256 probabilityWad, uint256 expectedPayout, uint256 subJackpotVarianceScaled)',
  'function quoteCaps(uint256 wager, bytes gameData) pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit)',
]);

function resolveAddress() {
  const url = new URL(DEPLOYMENT, import.meta.url);
  const deployment = JSON.parse(readFileSync(url, 'utf8'));
  const game = deployment.games.find((g) => g.name === 'TidelineGame');
  if (!game) {
    throw new Error(
      'TidelineGame is not in the local deployment. Drop the .sol into simulator/contracts and wait for the hot reload.',
    );
  }
  return game.address;
}

const encodeStakes = (stakes) =>
  encodeAbiParameters([{ type: 'uint256[6]' }], [stakes.map(BigInt)]);

/** Payout the contract's rules produce for a given tide level. */
function payoutAtLevel(stakes, multipliers, level) {
  let total = 0n;
  for (let i = 0; i < RUNGS; i++) {
    if (i + 1 <= level) total += (BigInt(stakes[i]) * multipliers[i]) / WAD;
  }
  return total;
}

/**
 * Allocations chosen to probe the corners, not just the comfortable middle: everything on
 * the safest rung, everything on the longest shot, a flat spread, a barbell, and a few
 * lopsided shapes a real player might actually build.
 */
function allocations(wager) {
  const unit = wager / 6n;
  const half = wager / 2n;

  // A flat spread rarely divides evenly. The contract requires the stakes to sum to the
  // wager exactly and reverts otherwise, so the remainder has to land somewhere — the
  // frontend will have to do this same thing rather than leaving dust unallocated.
  const flat = Array(6).fill(unit);
  flat[0] += wager - unit * 6n;

  return [
    { name: 'all on rung 1 (grind)', stakes: [wager, 0n, 0n, 0n, 0n, 0n] },
    { name: 'all on rung 6 (lottery)', stakes: [0n, 0n, 0n, 0n, 0n, wager] },
    { name: 'flat across all six', stakes: flat },
    { name: 'barbell 1 and 6', stakes: [half, 0n, 0n, 0n, 0n, half] },
    { name: 'bottom heavy', stakes: [half, wager / 4n, wager / 8n, wager / 8n, 0n, 0n] },
    { name: 'top heavy', stakes: [0n, 0n, wager / 8n, wager / 8n, wager / 4n, half] },
    { name: 'single middle rung', stakes: [0n, 0n, wager, 0n, 0n, 0n] },
    { name: 'awkward primes', stakes: [7n, 13n, 101n, 3n, 61n, wager - 185n] },
  ];
}

const client = createPublicClient({ transport: http(RPC) });
const address = resolveAddress();

console.log('TidelineGame at', address);
console.log('RPC', RPC);
console.log();

const multipliers = [];
for (let rung = 1; rung <= RUNGS; rung++) {
  multipliers.push(
    await client.readContract({ address, abi, functionName: 'multiplierWad', args: [BigInt(rung)] }),
  );
}

console.log('Paytable read from the deployed contract');
multipliers.forEach((m, i) => {
  const probability = `${LEVELS - (i + 1)}/${LEVELS}`;
  console.log(
    `  rung ${i + 1}  pays when L >= ${i + 1}  P=${probability}  ${(Number(m) / 1e18).toFixed(4)}x`,
  );
});
console.log();

let failures = 0;
const wager = 1_000_000n;

for (const { name, stakes } of allocations(wager)) {
  const staked = stakes.reduce((a, b) => a + BigInt(b), 0n);
  if (staked !== wager) {
    console.log(`SKIP  ${name} — stakes sum to ${staked}, not ${wager}`);
    continue;
  }

  // Measured: average payout over every equally likely tide level.
  let summed = 0n;
  for (let level = 0; level < LEVELS; level++) {
    summed += payoutAtLevel(stakes, multipliers, level);
  }
  const measuredRtpWad = (summed * WAD) / (BigInt(LEVELS) * wager);

  const gameData = encodeStakes(stakes);
  const [maxPayout, probabilityWad, expectedPayout] = await client.readContract({
    address,
    abi,
    functionName: 'quoteRiskParams',
    args: [wager, gameData],
  });

  // The contract's own promise to the house risk engine.
  const declaredRtpWad = (expectedPayout * WAD) / wager;

  // Integer division inside the contract truncates per rung, so allow a floor of one wei
  // per rung per level rather than demanding bit-exactness.
  const drift =
    measuredRtpWad > declaredRtpWad
      ? measuredRtpWad - declaredRtpWad
      : declaredRtpWad - measuredRtpWad;
  const tolerance = (BigInt(RUNGS * LEVELS) * WAD) / wager;

  const inBand =
    declaredRtpWad >= 930000000000000000n && declaredRtpWad <= 980000000000000000n;
  const matchesDeclaration = drift <= tolerance;
  const matchesTarget = declaredRtpWad === DECLARED_RTP_WAD;
  const ok = inBand && matchesDeclaration && matchesTarget;
  if (!ok) failures++;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(
    `      measured ${(Number(measuredRtpWad) / 1e18 * 100).toFixed(4)}%  ` +
      `declared ${(Number(declaredRtpWad) / 1e18 * 100).toFixed(4)}%  ` +
      `drift ${drift} wei  max payout ${(Number(maxPayout) / Number(wager)).toFixed(3)}x  ` +
      `P(max) ${(Number(probabilityWad) / 1e18).toFixed(4)}`,
  );
}

console.log();

// A monotonicity check the paytable would be broken without: a higher tide must never pay
// less than a lower one, for any allocation.
const probe = [3n, 5n, 11n, 23n, 47n, 911n];
let previous = -1n;
let monotone = true;
for (let level = 0; level < LEVELS; level++) {
  const p = payoutAtLevel(probe, multipliers, level);
  if (p < previous) monotone = false;
  previous = p;
}
console.log(`${monotone ? 'PASS' : 'FAIL'}  payout is monotone in tide level`);
if (!monotone) failures++;

console.log();
console.log(
  failures === 0
    ? 'RTP invariant holds on the deployed bytecode. Declared 96% is exact under every allocation tested.'
    : `${failures} check(s) FAILED — do not submit.`,
);
process.exit(failures === 0 ? 0 : 1);
