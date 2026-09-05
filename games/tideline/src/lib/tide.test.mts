/**
 * Check that the bell strikes land when the water actually arrives.
 *
 * The sound is scheduled ahead of time from a solved crossing formula rather than by watching
 * the animation, so nothing at runtime would notice if the formula were wrong - the bells
 * would simply ring at the wrong moments and the game would feel subtly broken with no error
 * anywhere. This is the only place that mistake can be caught.
 *
 *     node src/lib/tide.test.mts
 */

import { RUNGS } from './tideline.ts';
import { rungCrossings, rungY, waterlineAt, waterlineFor } from './tide.ts';

let failures = 0;

function check(label: string, condition: boolean, detail = '') {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

const rest = waterlineFor(0);

for (let level = 0; level <= RUNGS; level++) {
  const target = waterlineFor(level);
  const crossings = rungCrossings(rest, target);

  // Exactly the rungs the tide covers should chime, and no others.
  const chimed = crossings.map((c) => c.rung);
  const expected = Array.from({ length: level }, (_, i) => i + 1);
  check(
    `level ${level}: chimes rungs [${expected.join(',')}]`,
    JSON.stringify(chimed) === JSON.stringify(expected),
    `got [${chimed.join(',')}]`,
  );

  // Times must be strictly increasing — the water covers the bottom rung first.
  const ordered = crossings.every((c, i) => i === 0 || c.at > crossings[i - 1].at);
  check(`level ${level}: strikes are in order`, ordered);

  // Every strike must land while the climb is still visibly happening, not after it.
  const last = crossings.at(-1);
  check(
    `level ${level}: last strike inside the animation`,
    last === undefined || last.at < 2.2,
    last ? `${last.at.toFixed(2)}s` : '',
  );

  // The claim under test: at the scheduled moment, the water really is at that rung.
  for (const { rung, at } of crossings) {
    const water = waterlineAt(rest, target, at);
    const y = rungY(rung);
    check(
      `level ${level}: rung ${rung} strike matches the waterline`,
      Math.abs(water - y) < 1e-9,
      `water ${water.toFixed(6)} vs rung ${y.toFixed(6)}`,
    );
  }
}

// A falling or motionless tide covers nothing and must stay silent.
check('a still tide chimes nothing', rungCrossings(rest, rest).length === 0);
check('a falling tide chimes nothing', rungCrossings(waterlineFor(6), rest).length === 0);

console.log();
console.log(failures === 0 ? 'Bell timing is sound.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
