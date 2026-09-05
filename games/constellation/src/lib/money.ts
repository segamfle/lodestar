import { formatUnits } from 'viem';

/**
 * Format a token amount for a player to read, not for a machine to parse.
 *
 * `formatUnits` is exact, which means an eighteen-decimal payout renders as
 * 2.181592794895736072 — true, and unreadable. Amounts are shown to at most six decimals
 * with trailing zeros trimmed, which is finer than any wager anyone will place and still
 * short enough to take in at a glance.
 *
 * Rounding here is display only. Every number that decides anything stays a bigint.
 */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 6): string {
  const exact = formatUnits(value, decimals);
  const [whole, fraction = ''] = exact.split('.');
  if (fraction === '') return whole;

  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  if (trimmed === '') {
    // Something small but not zero should not read as zero.
    return value === 0n ? whole : `<0.${'0'.repeat(maxFractionDigits - 1)}1`;
  }
  return `${whole}.${trimmed}`;
}
