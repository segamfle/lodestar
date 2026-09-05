/**
 * How a painted cell is written into a memo, and read back out.
 *
 * The picture has no database behind it. Every cell anyone has ever painted is a transaction
 * on Cookie Chain, and the tray you see is those transactions replayed in order. That is the
 * whole design: the chain is the storage, and anyone can rebuild the same picture from a
 * public RPC without asking this app for anything.
 *
 * So the encoding has to survive being the only record. It is plain text rather than packed
 * bytes, because a human reading a raw transaction in an explorer should be able to see what
 * it did, and it is versioned, because a tray that outlives its first format is a tray whose
 * history breaks.
 */

export const TRAY_VERSION = 'TRAY1';

/** 64 x 64. Small enough to fill, big enough to draw something. */
export const GRID = 64;

/**
 * The palette, warm to cold. Sixteen colours fit in one hex digit, which keeps a memo short
 * enough that the fee stays in the fractions of a cent the chain is built for.
 */
export const PALETTE = [
  '#1a1210', // 0  burnt
  '#3d2a1e', // 1  dark chocolate
  '#6b4423', // 2  gingerbread
  '#a0682f', // 3  baked
  '#d19a4c', // 4  golden
  '#f0c987', // 5  dough
  '#fbe6c2', // 6  pale
  '#ffffff', // 7  icing
  '#e04f5f', // 8  cherry
  '#f2874a', // 9  apricot
  '#f7d354', // a  lemon
  '#7fb069', // b  pistachio
  '#3f9e8f', // c  mint
  '#3f7ea8', // d  blueberry
  '#6d5aa8', // e  blackcurrant
  '#b8578f', // f  raspberry
] as const;

export interface Stroke {
  x: number;
  y: number;
  colour: number;
}

const HEX = '0123456789abcdef';

/**
 * `TRAY1:xxyyc` — two base-36 digits for each coordinate, one hex digit for the colour.
 *
 * Base 36 keeps 0-63 inside a single character per axis... it does not, quite: 63 needs two
 * digits in any base under 64. Two fixed-width base-36 digits it is, which is still short,
 * still fixed length, and still readable in an explorer.
 */
export function encodeStroke({ x, y, colour }: Stroke): string {
  if (!Number.isInteger(x) || x < 0 || x >= GRID) throw new Error(`x out of range: ${x}`);
  if (!Number.isInteger(y) || y < 0 || y >= GRID) throw new Error(`y out of range: ${y}`);
  if (!Number.isInteger(colour) || colour < 0 || colour >= PALETTE.length) {
    throw new Error(`colour out of range: ${colour}`);
  }
  const pair = (value: number) => value.toString(36).padStart(2, '0');
  return `${TRAY_VERSION}:${pair(x)}${pair(y)}${HEX[colour]}`;
}

/**
 * Read a stroke out of a memo, or null if it is not one of ours.
 *
 * The memo field of a signature is shared with every other program on the chain, and it
 * arrives prefixed with a length in brackets. Anything that is not a well-formed stroke of a
 * version we know is skipped rather than guessed at - a tray that renders garbage because it
 * tried to interpret someone else's memo is worse than one that ignores it.
 */
export function decodeStroke(memo: string | null | undefined): Stroke | null {
  if (!memo) return null;

  // RPCs prefix the memo with "[<length>] ". Some do not. Handle both.
  const body = memo.replace(/^\[\d+\]\s*/, '').trim();
  if (!body.startsWith(`${TRAY_VERSION}:`)) return null;

  const payload = body.slice(TRAY_VERSION.length + 1);
  if (payload.length !== 5) return null;

  const x = parseInt(payload.slice(0, 2), 36);
  const y = parseInt(payload.slice(2, 4), 36);
  const colour = HEX.indexOf(payload[4].toLowerCase());

  if (!Number.isInteger(x) || x < 0 || x >= GRID) return null;
  if (!Number.isInteger(y) || y < 0 || y >= GRID) return null;
  if (colour < 0) return null;

  return { x, y, colour };
}

export const cellIndex = (x: number, y: number) => y * GRID + x;

export interface PaintedCell extends Stroke {
  /** Who painted it, base58. */
  painter: string;
  /** Slot it landed in - the chain's own ordering. */
  slot: number;
  signature: string;
  blockTime: number | null;
}

/**
 * Replay strokes into a picture.
 *
 * Ordered by slot, then by position within the slot, so two people painting the same cell in
 * the same block resolve the way the chain resolved them rather than the way they happened to
 * arrive over the wire. Later wins, which is the only rule the tray has.
 */
export function replay(cells: readonly PaintedCell[]): (PaintedCell | null)[] {
  const picture = new Array<PaintedCell | null>(GRID * GRID).fill(null);
  const ordered = [...cells].sort((a, b) => a.slot - b.slot);
  for (const cell of ordered) picture[cellIndex(cell.x, cell.y)] = cell;
  return picture;
}
