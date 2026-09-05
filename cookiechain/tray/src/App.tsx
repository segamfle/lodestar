import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tray } from './components/Tray';
import {
  GRID,
  PALETTE,
  encodeStroke,
  replay,
  type PaintedCell,
} from './lib/codec';
import {
  RPC_URL,
  STROKE_LAMPORTS,
  TRAY_ADDRESS,
  buildPaintTransaction,
  connection,
  explorerAddress,
  explorerTx,
  fetchTray,
  readableError,
  sendStroke,
} from './lib/chain';
import {
  NIGHTLY_URL,
  connect as connectWallet,
  detectWallets,
  disconnect as disconnectWallet,
  reconnectSilently,
  shortAddress,
  type WalletChoice,
} from './lib/wallet';

/** How often the tray re-reads the chain when nobody is painting. */
const REFRESH_MS = 12000;

type Status =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'sending' }
  | { kind: 'landed'; ms: number; signature: string; slot: number }
  | { kind: 'error'; message: string };

export function App() {
  const [wallets, setWallets] = useState<WalletChoice[]>(detectWallets);
  const [wallet, setWallet] = useState<WalletChoice | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  const [cells, setCells] = useState<PaintedCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [colour, setColour] = useState(8);
  const [pending, setPending] = useState<{ x: number; y: number; colour: number } | null>(null);
  const [justLanded, setJustLanded] = useState<{ x: number; y: number; at: number } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [inspecting, setInspecting] = useState<PaintedCell | null>(null);

  const picture = useMemo(() => replay(cells), [cells]);

  // Extensions inject themselves at different points in page load, so a wallet missing at
  // first paint is not necessarily missing.
  useEffect(() => {
    const timers = [300, 900, 2000].map((ms) =>
      setTimeout(() => setWallets((current) => (current.length ? current : detectWallets())), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  // Reconnect a wallet that already trusts this page, without a dialog nobody asked for.
  useEffect(() => {
    if (wallet || wallets.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const choice of wallets) {
        const found = await reconnectSilently(choice);
        if (found && !cancelled) {
          setWallet(choice);
          setAddress(found);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallets, wallet]);

  const refresh = useCallback(async () => {
    try {
      const history = await fetchTray();
      setCells(history.cells);
    } catch (cause) {
      setStatus({ kind: 'error', message: readableError(cause) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Balance, so someone with an empty wallet learns that before signing rather than after.
  const addressRef = useRef(address);
  addressRef.current = address;
  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const { PublicKey } = await import('@solana/web3.js');
        const lamports = await connection.getBalance(new PublicKey(address), 'confirmed');
        if (!cancelled) setBalance(lamports);
      } catch {
        // A balance we cannot read is not worth interrupting anyone over.
      }
    };
    void read();
    const timer = setInterval(read, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address]);

  const paint = useCallback(
    async (x: number, y: number) => {
      if (!wallet || !address || pending) return;
      setStatus({ kind: 'signing' });
      setPending({ x, y, colour });

      try {
        const { PublicKey } = await import('@solana/web3.js');
        const payer = new PublicKey(address);
        const transaction = await buildPaintTransaction(payer, encodeStroke({ x, y, colour }));

        const signed = await wallet.provider.signTransaction(transaction);
        setStatus({ kind: 'sending' });

        const { signature, confirmedMs, slot } = await sendStroke(signed);
        setStatus({ kind: 'landed', ms: confirmedMs, signature, slot });
        setJustLanded({ x, y, at: performance.now() });

        // Show it immediately rather than waiting for the next poll; the poll will replace it
        // with the chain's own copy.
        setCells((current) => [
          ...current,
          { x, y, colour, painter: address, slot, signature, blockTime: null },
        ]);
      } catch (cause) {
        setStatus({ kind: 'error', message: readableError(cause) });
      } finally {
        setPending(null);
      }
    },
    [wallet, address, colour, pending],
  );

  const painted = picture.filter(Boolean).length;
  const painters = useMemo(() => new Set(cells.map((c) => c.painter).filter(Boolean)).size, [cells]);
  const recent = useMemo(() => [...cells].sort((a, b) => b.slot - a.slot).slice(0, 8), [cells]);

  const cook = (lamports: number) => (lamports / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  const busy = status.kind === 'signing' || status.kind === 'sending';

  return (
    <main className="tray-app">
      <header className="masthead">
        <div>
          <h1>Tray</h1>
          <p className="tagline">
            A shared baking tray on Cookie Chain. One cell, one transaction, and the picture is
            the chain itself.
          </p>
        </div>

        <div className="wallet">
          {address ? (
            <>
              <span className="addr" title={address}>
                {shortAddress(address, 5)}
              </span>
              <span className="bal">
                {balance === null ? '…' : `${cook(balance)} COOK`}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  if (wallet) void disconnectWallet(wallet);
                  setWallet(null);
                  setAddress(null);
                }}
              >
                Disconnect
              </button>
            </>
          ) : wallets.length > 0 ? (
            wallets.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className="connect"
                onClick={async () => {
                  try {
                    const found = await connectWallet(choice);
                    setWallet(choice);
                    setAddress(found);
                    setStatus({ kind: 'idle' });
                  } catch (cause) {
                    setStatus({ kind: 'error', message: readableError(cause) });
                  }
                }}
              >
                Connect {choice.name}
              </button>
            ))
          ) : (
            <a className="connect" href={NIGHTLY_URL} target="_blank" rel="noreferrer">
              Install Nightly
            </a>
          )}
        </div>
      </header>

      <section className="board">
        <Tray
          picture={picture}
          colour={colour}
          pending={pending}
          justLanded={justLanded}
          disabled={!address || busy}
          onPaint={(x, y) => void paint(x, y)}
          onHover={setInspecting}
        />
        {loading && <p className="loading">Reading the tray off the chain…</p>}
      </section>

      <aside className="side">
        <div className="palette" role="group" aria-label="Colour">
          {PALETTE.map((swatch, index) => (
            <button
              key={swatch}
              type="button"
              className={`swatch${index === colour ? ' is-held' : ''}`}
              style={{ background: swatch }}
              onClick={() => setColour(index)}
              aria-pressed={index === colour}
              aria-label={`Colour ${index + 1}`}
            />
          ))}
        </div>

        <div className={`status is-${status.kind}`} role="status">
          {status.kind === 'idle' && !address && <span>Connect a wallet, then click a cell.</span>}
          {status.kind === 'idle' && address && <span>Pick a colour and click a cell.</span>}
          {status.kind === 'signing' && <span>Waiting for your signature…</span>}
          {status.kind === 'sending' && <span>Sending to Cookie Chain…</span>}
          {status.kind === 'landed' && (
            <span>
              Landed in <strong>{status.ms} ms</strong>, slot {status.slot.toLocaleString()} ·{' '}
              <a href={explorerTx(status.signature)} target="_blank" rel="noreferrer">
                receipt
              </a>
            </span>
          )}
          {status.kind === 'error' && <span className="bad">{status.message}</span>}
        </div>

        <dl className="stats">
          <div>
            <dt>Cells painted</dt>
            <dd>
              {painted.toLocaleString()} <span className="of">of {(GRID * GRID).toLocaleString()}</span>
            </dd>
          </div>
          <div>
            <dt>Strokes on chain</dt>
            <dd>{cells.length.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Painters</dt>
            <dd>{painters || '—'}</dd>
          </div>
          <div>
            <dt>Cost per cell</dt>
            <dd>~{cook(STROKE_LAMPORTS)} COOK + fee</dd>
          </div>
        </dl>

        <div className="inspector">
          {inspecting ? (
            <>
              <span className="label">
                Cell {inspecting.x}, {inspecting.y}
              </span>
              <a href={explorerTx(inspecting.signature)} target="_blank" rel="noreferrer">
                {shortAddress(inspecting.signature, 6)}
              </a>
              <span className="slot">slot {inspecting.slot.toLocaleString()}</span>
            </>
          ) : (
            <span className="label">Hover a painted cell to see the transaction that made it.</span>
          )}
        </div>

        <div className="feed">
          <h2>Latest strokes</h2>
          {recent.length === 0 ? (
            <p className="empty">Nothing on the tray yet. The first cell is yours.</p>
          ) : (
            <ul>
              {recent.map((entry) => (
                <li key={entry.signature}>
                  <span className="chip" style={{ background: PALETTE[entry.colour] }} />
                  <span className="where">
                    {entry.x}, {entry.y}
                  </span>
                  <a href={explorerTx(entry.signature)} target="_blank" rel="noreferrer">
                    {shortAddress(entry.signature, 4)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="colophon">
          <p>
            Every cell is a transaction. There is no database — the tray is rebuilt by reading{' '}
            <a href={explorerAddress(TRAY_ADDRESS.toBase58())} target="_blank" rel="noreferrer">
              one address
            </a>{' '}
            from <code>{RPC_URL.replace('https://', '')}</code>. Close this page and the picture
            survives; anyone can rebuild it from the chain.
          </p>
          <p className="fine">
            The tray address is program-derived, so no private key for it exists. What lands
            there stays there.
          </p>
        </footer>
      </aside>
    </main>
  );
}
