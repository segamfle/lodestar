/**
 * Wallet connection.
 *
 * Nightly is the wallet this is built for and tested against. Other injected Solana wallets
 * expose the same three methods, so they are offered too rather than blocked - a wallet that
 * can sign should be allowed to, and refusing one on the grounds that it was not on a list
 * helps nobody.
 *
 * No adapter framework. The surface actually used here is connect, signTransaction and
 * disconnect, and pulling in a wallet-adapter stack to reach three methods would cost more
 * bundle than the rest of the app together.
 */

import type { PublicKey, Transaction } from '@solana/web3.js';

export interface InjectedProvider {
  publicKey?: { toBase58(): string } | null;
  isConnected?: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface WalletChoice {
  id: string;
  name: string;
  provider: InjectedProvider;
  /** Where to get it, when it is not installed. */
  url: string;
}

interface WindowWithWallets {
  nightly?: { solana?: InjectedProvider };
  solana?: InjectedProvider & { isPhantom?: boolean };
  backpack?: InjectedProvider;
  solflare?: InjectedProvider;
}

const KNOWN = [
  {
    id: 'nightly',
    name: 'Nightly',
    url: 'https://nightly.app',
    find: (w: WindowWithWallets) => w.nightly?.solana,
  },
  {
    id: 'backpack',
    name: 'Backpack',
    url: 'https://backpack.app',
    find: (w: WindowWithWallets) => w.backpack,
  },
  {
    id: 'solflare',
    name: 'Solflare',
    url: 'https://solflare.com',
    find: (w: WindowWithWallets) => w.solflare,
  },
  {
    id: 'phantom',
    name: 'Phantom',
    url: 'https://phantom.app',
    find: (w: WindowWithWallets) => (w.solana?.isPhantom ? w.solana : undefined),
  },
] as const;

/**
 * Which wallets are actually present.
 *
 * Extensions inject themselves at different points in page load, so this is worth calling
 * again after a beat rather than once on mount - a wallet that was not there at first paint
 * is a wallet the player will swear they have installed.
 */
export function detectWallets(): WalletChoice[] {
  if (typeof window === 'undefined') return [];
  const w = window as unknown as WindowWithWallets;

  const found: WalletChoice[] = [];
  for (const candidate of KNOWN) {
    const provider = candidate.find(w);
    if (provider && typeof provider.connect === 'function') {
      found.push({ id: candidate.id, name: candidate.name, provider, url: candidate.url });
    }
  }
  return found;
}

/** Where to send someone who has no wallet at all. Nightly, because that is what is required. */
export const NIGHTLY_URL = 'https://nightly.app';

/**
 * Reconnect without prompting, if this wallet already trusts the site.
 *
 * Silent by design: a page that throws a wallet dialog at you before you have asked for
 * anything is a page people close.
 */
export async function reconnectSilently(choice: WalletChoice): Promise<string | null> {
  try {
    const result = await choice.provider.connect({ onlyIfTrusted: true });
    return result?.publicKey?.toBase58() ?? choice.provider.publicKey?.toBase58() ?? null;
  } catch {
    return null;
  }
}

export async function connect(choice: WalletChoice): Promise<string> {
  const result = await choice.provider.connect();
  const address = result?.publicKey?.toBase58() ?? choice.provider.publicKey?.toBase58();
  if (!address) throw new Error('The wallet connected but did not return an address.');
  return address;
}

export async function disconnect(choice: WalletChoice): Promise<void> {
  try {
    await choice.provider.disconnect();
  } catch {
    // Some wallets refuse to disconnect programmatically. Dropping our own reference to it is
    // the part that matters to the page.
  }
}

/** Shorten an address the way every explorer does, so it fits and stays recognisable. */
export const shortAddress = (address: string, edge = 4) =>
  address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`;
