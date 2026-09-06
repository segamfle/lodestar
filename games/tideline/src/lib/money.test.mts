import { formatAmount } from './money.ts';
let bad = 0;
const check = (label: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got ${got}  want ${want}`);
};
const wad = (n: string) => BigInt(n);
check('zero', formatAmount(0n, 18), '0');
check('a whole one', formatAmount(10n ** 18n, 18), '1');
// The old slice turned these into 274.399999 and 2.743999.
check('274.4 exactly', formatAmount(wad('274399999999999999900'), 18), '274.4');
check('2.744 exactly', formatAmount(wad('2743999999999999999'), 18), '2.744');
check('3.959244 rounds to 4dp', formatAmount(wad('3959243994117647058'), 18), '3.9592');
check('rounds up at the halfway point', formatAmount(wad('1000050000000000000'), 18), '1.0001');
check('dust does not read as zero', formatAmount(1n, 18), '<0.0001');
check('trailing zeros trimmed', formatAmount(wad('1500000000000000000'), 18), '1.5');
console.log('');
console.log(bad === 0 ? 'Amounts read true.' : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
