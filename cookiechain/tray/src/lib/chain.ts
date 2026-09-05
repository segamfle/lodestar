/**
 * Everything that talks to Cookie Chain.
 *
 * There is no server behind this app. Painting a cell is a transaction; reading the tray is a
 * public RPC call anyone can make. The consequence worth stating plainly: if this page
 * disappears tomorrow the picture does not, and anyone can rebuild it from the chain with the
 * decoder in `codec.ts` and nothing else.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type ConfirmedSignatureInfo,
} from '@solana/web3.js';
import { decodeStroke, type PaintedCell } from './codec';

export const RPC_URL = 'https://rpc.cookiescan.io';

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/**
 * The shared tray.
 *
 * Every stroke sends a token amount here, which is what makes the tray's whole history
 * readable with one `getSignaturesForAddress` call instead of by filtering every memo on the
 * chain.
 *
 * It is a program-derived address, so it is provably off the ed25519 curve and no private key
 * for it exists or can exist. Nobody - including whoever wrote this - can move what lands
 * there. Anyone can check that claim in one line:
 *
 *     PublicKey.findProgramAddressSync([new TextEncoder().encode('tray')], MEMO_PROGRAM)
 */
const utf8 = new TextEncoder();

export const [TRAY_ADDRESS] = PublicKey.findProgramAddressSync(
  [utf8.encode('tray')],
  MEMO_PROGRAM,
);

/**
 * What a stroke sends to the tray. One lamport - a billionth of a COOK - which exists only to
 * put the tray address into the transaction so the chain indexes it. It is not a fee and it
 * is not going anywhere: it settles on an address with no key.
 */
export const STROKE_LAMPORTS = 1;

export const connection = new Connection(RPC_URL, 'confirmed');

/** The memo instruction carrying the stroke. The payer signs; the memo program checks that. */
function memoInstruction(payer: PublicKey, text: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM,
    data: utf8.encode(text) as unknown as Buffer,
  });
}

/** A transaction that paints one cell: a token to the tray, and the stroke that says which. */
export async function buildPaintTransaction(
  payer: PublicKey,
  encodedStroke: string,
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const transaction = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  });

  transaction.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: TRAY_ADDRESS,
      lamports: STROKE_LAMPORTS,
    }),
    memoInstruction(payer, encodedStroke),
  );

  return transaction;
}

export interface TrayHistory {
  cells: PaintedCell[];
  /** Signatures seen in total, ours or not - the denominator for "how much of this is us". */
  scanned: number;
  /** True when we stopped at the page limit rather than at the end of the history. */
  truncated: boolean;
}

/**
 * Read the tray back off the chain.
 *
 * `getSignaturesForAddress` returns newest first and carries the memo inline, so the whole
 * picture comes back without a second round trip per transaction. Pages are walked backwards
 * until the history runs out or the cap is reached; the cap exists because a tray that has
 * been painted a hundred thousand times should still open, and the newest strokes are the
 * ones that survive `replay` anyway.
 */
export async function fetchTray(maxSignatures = 5000): Promise<TrayHistory> {
  const cells: PaintedCell[] = [];
  let before: string | undefined;
  let scanned = 0;
  let truncated = false;

  while (scanned < maxSignatures) {
    const page: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(
      TRAY_ADDRESS,
      { limit: Math.min(1000, maxSignatures - scanned), before },
      'confirmed',
    );
    if (page.length === 0) break;

    scanned += page.length;
    for (const entry of page) {
      // A failed transaction paid its fee and changed nothing. It is not part of the picture.
      if (entry.err) continue;
      const stroke = decodeStroke(entry.memo);
      if (!stroke) continue;
      cells.push({
        ...stroke,
        painter: '', // filled in below only when we need it; signatures do not carry the signer
        slot: entry.slot,
        signature: entry.signature,
        blockTime: entry.blockTime ?? null,
      });
    }

    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
    if (scanned >= maxSignatures) truncated = true;
  }

  return { cells, scanned, truncated };
}

/** Rough cost of one stroke in COOK, for showing the player what they are about to spend. */
export async function estimateStrokeCost(payer: PublicKey, encodedStroke: string) {
  const transaction = await buildPaintTransaction(payer, encodedStroke);
  const message = transaction.compileMessage();
  const { value } = await connection.getFeeForMessage(message, 'confirmed');
  return {
    feeLamports: value ?? null,
    totalLamports: value === null || value === undefined ? null : value + STROKE_LAMPORTS,
  };
}

export interface SendTiming {
  signature: string;
  /** Milliseconds from the wallet handing the signed transaction back to first confirmation. */
  confirmedMs: number;
  slot: number;
}

/**
 * Send a signed stroke and wait for the chain to take it.
 *
 * The elapsed time is measured from the moment the signed transaction leaves this app, not
 * from the click, because everything before that is the wallet's dialog and the player's own
 * hand. What is being timed is the chain.
 */
export async function sendStroke(signed: Transaction): Promise<SendTiming> {
  const startedAt = performance.now();
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  const blockhash = signed.recentBlockhash;
  const lastValidBlockHeight = signed.lastValidBlockHeight;
  if (!blockhash || lastValidBlockHeight === undefined) {
    throw new Error('The transaction lost its blockhash before it was sent.');
  }

  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (result.value.err) {
    throw new Error(`The chain rejected the stroke: ${JSON.stringify(result.value.err)}`);
  }

  return {
    signature,
    confirmedMs: Math.round(performance.now() - startedAt),
    slot: result.context.slot,
  };
}

export const explorerTx = (signature: string) => `https://cookiescan.io/tx/${signature}`;
export const explorerAddress = (address: string) => `https://cookiescan.io/address/${address}`;

/** Turn an RPC error into something a person can act on. */
export function readableError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (/insufficient|debit an account/i.test(message)) {
    return 'Not enough COOK to cover the fee. Bridge a little and try again.';
  }
  if (/blockhash not found|block height exceeded/i.test(message)) {
    return 'The transaction sat too long and expired. Paint the cell again.';
  }
  if (/User rejected|rejected the request|denied/i.test(message)) {
    return 'You cancelled the signature.';
  }
  if (/failed to fetch|network|timed? ?out/i.test(message)) {
    return 'Could not reach the Cookie Chain RPC. Check your connection and try again.';
  }
  return message;
}
