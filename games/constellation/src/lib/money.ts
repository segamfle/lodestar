
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
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 4): string {
  if (value === 0n) return '0';

  // Round rather than cut. Slicing the decimal string left every headline number trailing a
  // run of 9s or 3s - 274.399999 for a true 274.4, 2.743999 for 2.744 - which reads as a
  // floating-point bug in a game whose whole pitch is that its arithmetic is exact.
  const scale = 10n ** BigInt(decimals);
  const unit = 10n ** BigInt(Math.max(decimals - maxFractionDigits, 0));
  const rounded = ((value + unit / 2n) / unit) * unit;
  if (rounded === 0n) return `<0.${'0'.repeat(maxFractionDigits - 1)}1`;

  const whole = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(decimals, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}
