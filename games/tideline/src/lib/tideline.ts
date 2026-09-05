/**
 * Tideline's rules, mirrored from `TidelineGame.sol`.
 *
 * Everything here must agree with the contract exactly. The contract is the authority; this
 * file exists so the UI can show a payout before the chain settles one, and so the numbers a
 * player reads while deciding are the numbers they actually get. Where the contract truncates
 * with integer division, so does this — a preview that rounds differently than the settlement
 * is worse than no preview.
 */

export const RUNGS = 6;

/** The tide level is uniform over {0..6}. Level 0 leaves the whole ladder dry. */
export const LEVELS = RUNGS + 1;

export const WAD = 10n ** 18n;

/** 96%, mid-band in the jam's required 93-98%. */
export const RTP_WAD = 960000000000000000n;

/**
 * Payout multiplier for a rung, in WAD.
 *
 * `m_i = RTP / P(L >= i)` where `P(L >= i) = (LEVELS - i) / LEVELS`.
 *
 * The consequence worth understanding: expected return on a stake at rung `i` is
 * `stake * m_i * P(L >= i) = stake * RTP`, independent of `i`. Every rung pays back exactly
 * RTP per unit staked, so the player picks the shape of their variance and never the edge.
 */
export function multiplierWad(rung: number): bigint {
  if (rung < 1 || rung > RUNGS) throw new Error(`rung ${rung} is off the ladder`);
  return (RTP_WAD * BigInt(LEVELS)) / BigInt(LEVELS - rung);
}

/** The paytable, rung 1 through 6, as human-readable multipliers. */
export const PAYTABLE = Array.from({ length: RUNGS }, (_, i) => {
  const rung = i + 1;
  return {
    rung,
    multiplierWad: multiplierWad(rung),
    multiplier: Number(multiplierWad(rung)) / 1e18,
    /** Chance the tide reaches this rung. */
    probability: (LEVELS - rung) / LEVELS,
  };
});

/** Payout for one allocation at one tide level, truncating exactly as the contract does. */
export function payoutAtLevel(stakes: readonly bigint[], level: number): bigint {
  let total = 0n;
  for (let i = 0; i < RUNGS; i++) {
    if (i + 1 <= level) total += (stakes[i] * multiplierWad(i + 1)) / WAD;
  }
  return total;
}

/** The whole ladder underwater — the best case, and the house's maximum exposure. */
export function maxPayout(stakes: readonly bigint[]): bigint {
  return payoutAtLevel(stakes, RUNGS);
}

export function totalStaked(stakes: readonly bigint[]): bigint {
  return stakes.reduce((sum, stake) => sum + stake, 0n);
}

/**
 * Spread a wager evenly across the chosen rungs, giving the remainder to the lowest one.
 *
 * The contract requires the stakes to sum to the wager exactly and reverts otherwise, so the
 * dust from an uneven division has to land somewhere rather than quietly vanishing. It goes
 * to the lowest selected rung because that is the least surprising place for a player to find
 * an extra wei.
 */
export function spreadEvenly(wager: bigint, selected: readonly number[]): bigint[] {
  const stakes = new Array<bigint>(RUNGS).fill(0n);
  if (selected.length === 0 || wager <= 0n) return stakes;

  const rungs = [...selected].sort((a, b) => a - b);
  const share = wager / BigInt(rungs.length);
  for (const rung of rungs) stakes[rung - 1] = share;
  stakes[rungs[0] - 1] += wager - share * BigInt(rungs.length);
  return stakes;
}

/** What the player can still win, and what it is worth on average, for the ladder they built. */
export function summarise(stakes: readonly bigint[]) {
  const staked = totalStaked(stakes);
  const outcomes = Array.from({ length: LEVELS }, (_, level) => ({
    level,
    payout: payoutAtLevel(stakes, level),
  }));

  const expected = outcomes.reduce((sum, o) => sum + o.payout, 0n) / BigInt(LEVELS);

  return {
    staked,
    outcomes,
    max: maxPayout(stakes),
    expected,
    /** Chance of getting anything back at all: any tide above level 0 that touches a stake. */
    chanceOfReturn:
      outcomes.filter((o) => o.level > 0 && o.payout > 0n).length / LEVELS,
  };
}
