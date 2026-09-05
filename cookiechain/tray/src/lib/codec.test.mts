/**
 * The encoding is the only record of the picture, so it gets tested harder than anything
 * else here. A stroke that cannot be read back is a cell lost from the tray permanently, and
 * a decoder that accepts something it should not paints somebody else's memo onto the board.
 *
 *     node src/lib/codec.test.mts
 */

import {
  GRID,
  PALETTE,
  TRAY_VERSION,
  decodeStroke,
  encodeStroke,
  replay,
  type PaintedCell,
} from './codec.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${label}${detail ? '  ' + detail : ''}`);
};

// ---------------------------------------------------------------- round trip

let roundTripped = 0;
let mismatch: string | null = null;
for (let x = 0; x < GRID; x++) {
  for (let y = 0; y < GRID; y++) {
    for (let colour = 0; colour < PALETTE.length; colour++) {
      const encoded = encodeStroke({ x, y, colour });
      const back = decodeStroke(encoded);
      if (!back || back.x !== x || back.y !== y || back.colour !== colour) {
        mismatch ??= `${x},${y},${colour} -> ${encoded} -> ${JSON.stringify(back)}`;
      } else {
        roundTripped++;
      }
    }
  }
}
check(
  roundTripped === GRID * GRID * PALETTE.length,
  `every cell and colour survives a round trip (${GRID * GRID * PALETTE.length} of them)`,
  mismatch ?? '',
);

// Fixed length matters: it is what lets the decoder reject a truncated memo outright.
const lengths = new Set([
  encodeStroke({ x: 0, y: 0, colour: 0 }).length,
  encodeStroke({ x: 63, y: 63, colour: 15 }).length,
  encodeStroke({ x: 7, y: 41, colour: 9 }).length,
]);
check(lengths.size === 1, 'every stroke encodes to the same length', `${[...lengths]}`);

// ---------------------------------------------------------------- rejection

const rejects: [string, string | null][] = [
  ['null memo', null],
  ['empty', ''],
  ['someone else entirely', 'gm'],
  ['another app on the same program', 'PROOFCRUMB:v1:eyJ0YXNrIjoibm90IG91cnMifQ'],
  ['our prefix, nothing after', `${TRAY_VERSION}:`],
  ['truncated payload', `${TRAY_VERSION}:0a1`],
  ['payload too long', `${TRAY_VERSION}:0a1b2c`],
  ['x past the edge', `${TRAY_VERSION}:1z00a`],
  ['y past the edge', `${TRAY_VERSION}:001za`],
  ['colour outside the palette', `${TRAY_VERSION}:0000z`],
  ['a future version', 'TRAY2:0000a'],
];
for (const [label, memo] of rejects) {
  check(decodeStroke(memo) === null, `rejects ${label}`);
}

// The RPC prefixes memos with their length; both shapes have to read the same.
const plain = encodeStroke({ x: 12, y: 34, colour: 5 });
check(
  JSON.stringify(decodeStroke(`[${plain.length}] ${plain}`)) === JSON.stringify(decodeStroke(plain)),
  'the RPC length prefix makes no difference',
);

// ---------------------------------------------------------------- replay

const cell = (x: number, y: number, colour: number, slot: number): PaintedCell => ({
  x,
  y,
  colour,
  slot,
  painter: 'someone',
  signature: `sig${slot}`,
  blockTime: null,
});

// Deliberately out of order: the wire does not promise to deliver history sorted.
const picture = replay([
  cell(3, 3, 8, 300),
  cell(3, 3, 2, 100),
  cell(3, 3, 5, 200),
  cell(0, 0, 1, 50),
]);
check(picture[3 * GRID + 3]?.colour === 8, 'the last write to a cell wins, whatever order it arrived in');
check(picture[0]?.colour === 1, 'an untouched cell keeps its own stroke');
check(picture.filter(Boolean).length === 2, 'replay paints only the cells that were painted');
check(picture.length === GRID * GRID, 'replay returns the whole tray');

console.log('');
console.log(failures === 0 ? 'The tray reads back what it wrote.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
