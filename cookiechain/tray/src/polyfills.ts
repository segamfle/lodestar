/**
 * @solana/web3.js is written against Node's Buffer, which browsers do not have.
 *
 * This lives in its own module and is imported first, because ES module imports are all
 * evaluated before any statement in the importing module's body - putting the assignment at
 * the top of main.tsx looks like it runs first and does not. Import order between modules is
 * preserved, so this is the only reliable place for it.
 */
import { Buffer } from 'buffer';

const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;
