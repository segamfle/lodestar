import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeMaxWager } from '@chain/casino-sdk/guest';
import { decodeAbiParameters, encodeAbiParameters, parseUnits } from 'viem';
import { Sky, type SkyPhase } from './components/Sky';
import { useCasinoHost } from './lib/useCasinoHost';
import { audio } from './lib/audio';
import { formatAmount } from './lib/money';
import {
  CELLS,
  COLUMNS,
  MAX_SHAPE,
  MIN_SHAPE,
  STARS,
  boardGrid,
  cellsOf,
  chanceOfAnyReturn,
  demoSky,
  isLit,
  multiplierWad,
  outcomesFor,
  payoutFor,
} from './lib/constellation';
const EMPTY_HEX = '0x' as const;
const SHAPE_ABI = [{ type: 'uint256' }] as const;
const STATE_ABI = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }] as const;
/**
 * Gap between stars arriving.
 *
 * At 300ms with a 450ms bloom each star was still growing when the next one started, so
 * seven arrivals overlapped into what read as a single flash. Every star now finishes
 * landing before the next begins, which is the difference between a reveal and a blink.
 */
const STAR_GAP_MS = 420;
type RoundStatus = 'opening' | 'waiting' | 'lighting' | 'done';
interface Round {
  sessionKey: string;
  sessionId?: string;
  shape: bigint;
  size: number;
  wager: bigint;
  status: RoundStatus;
  sky: bigint | null;
  knownBefore: string[];
  order: number[];
  payout: bigint | null;
}
const isTerminal = (phase: unknown) => phase === 3 || phase === 4 || phase === 5;
/** Where a cell sits across the stereo field, so the sky is heard as wide as it looks. */
const panFor = (cell: number) => ((cell % COLUMNS) / (COLUMNS - 1)) * 1.4 - 0.7;
/**
 * Find our round in the host's session list.
 *
 * The host publishes an optimistic row the moment a session opens, keyed by a pending id,
 * then replaces it with the indexed row once the chain catches up. Under indexer lag - which
 * the simulator can dial up on purpose, and which production has for real - the optimistic
 * row can vanish before the indexed one arrives, and a game that only ever matches the key it
 * was handed will sit on "waiting" forever while its round quietly settles behind it.
 *
 * So the key is tried first, and if it is gone we look for a session that did not exist when
 * the bet was placed. There can only be one, because a round is in flight at a time.
 */
function findOurSession<T extends { sessionKey: string; sessionId?: string }>(
  items: readonly T[],
  sessionKey: string,
  knownBefore: readonly string[],
): T | undefined {
  const byKey = items.find((item) => item.sessionKey === sessionKey);
  if (byKey) return byKey;
  return items.find(
    (item) => item.sessionId !== undefined && !knownBefore.includes(item.sessionId),
  );
}
/**
 * The order stars arrive in.
 *
 * The contract only records which cells ended up lit, not the sequence it drew them in, so
 * the reveal needs an order of its own. It is derived from the sky itself, which keeps it
 * stable across re-renders, and it is deliberately not sorted to put the player's cells last:
 * ordering for suspense would mean every round told the same lie about how close it came.
 */
function revealOrder(sky: bigint): number[] {
  return cellsOf(sky)
    .map((cell) => {
      const n = Math.sin(cell * 91.7 + Number(sky % 9973n) * 0.137) * 43758.5453;
      return { cell, key: n - Math.floor(n) };
    })
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.cell);
}
export function App() {
  const { hostApi, snapshot, standalone } = useCasinoHost();
  // Kept in the order they were placed. The bitmask the contract wants is derived from it;
  // the order is what lets a full shape drop its oldest mark to make room for a new one.
  const [marks, setMarks] = useState<number[]>([6, 8, 12, 18]);
  const shape = useMemo(() => marks.reduce((mask, cell) => mask | (1n << BigInt(cell)), 0n), [marks]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [amountText, setAmountText] = useState('1');
  const [round, setRound] = useState<Round | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(audio.muted);

  // The hit targets are laid out from the same function the canvas draws with, measured off
  // the board itself. A stylesheet guessing at the same square drifted apart from it.
  const boardRef = useRef<HTMLElement | null>(null);
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = boardRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBoardSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const grid = useMemo(
    () => boardGrid(boardSize.width, boardSize.height),
    [boardSize.width, boardSize.height],
  );
  const decimals = snapshot?.token.decimals ?? 18;
  const symbol = snapshot?.token.symbol ?? 'chUSD';
  const size = marks.length;
  const legalShape = size >= MIN_SHAPE && size <= MAX_SHAPE;
  const wager = useMemo(() => {
    try {
      const parsed = parseUnits(amountText || '0', decimals);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }, [amountText, decimals]);
  const outcomes = useMemo(() => (legalShape ? outcomesFor(size) : []), [legalShape, size]);
  const maxWager = useMemo<bigint | null>(() => {
    if (!snapshot || !legalShape) return null;
    try {
      const limit = computeMaxWager(snapshot, {
        maxMultiplierX: Number(multiplierWad(size, size)) / 1e18,
      });
      return limit === undefined ? null : BigInt(limit);
    } catch {
      return null;
    }
  }, [snapshot, size, legalShape]);
  const walletReady = standalone || snapshot?.wallet.status === 'ready';
  const busy = round !== null && round.status !== 'done';
  // The table limit was displayed but never checked, so an over-limit wager left the button
  // live and turned a chain revert into the player's error message.
  const withinLimit = maxWager === null || wager <= maxWager;
  const canBet = walletReady && wager > 0n && legalShape && withinLimit && !busy;
  const hits = useMemo(() => {
    if (!round?.sky) return 0;
    let count = 0;
    for (let i = 0; i < revealed; i++) {
      const cell = round.order[i];
      if (cell !== undefined && isLit(round.shape, cell)) count++;
    }
    return count;
  }, [round, revealed]);
  const toggle = useCallback(
    (cell: number) => {
      if (busy) return;
      audio.unlock();
      // Built from the latest state rather than a captured copy: two quick clicks used to
      // both compute from the same stale value, so the second discarded the first and a mark
      // the player had just placed vanished.
      // The sound belongs out here: React double-invokes updaters in development and may
      // re-run them during a concurrent render, and an updater that makes noise makes it
      // twice.
      audio.mark(!marks.includes(cell), panFor(cell));
      setMarks((current) => {
        if (current.includes(cell)) return current.filter((c) => c !== cell);
        // A full shape makes room by dropping its oldest mark rather than refusing the
        // click. Disabling the rest of the board once six were placed meant the shape could
        // only be dismantled, never moved, and a board that stops responding reads as broken.
        const next = current.length >= MAX_SHAPE ? current.slice(1) : current;
        return [...next, cell];
      });
    },
    [busy],
  );
  // Settle from host snapshots: once our row goes terminal, read the sky the chain drew.
  useEffect(() => {
    if (!round || round.status !== 'waiting' || !snapshot) return;
    const row = findOurSession(snapshot.sessions.items, round.sessionKey, round.knownBefore);
    if (!row || !(row.isSettled || isTerminal(row.phase))) return;
    if (!row.raw.gameState) return; // terminal but not synced yet
    let sky: bigint;
    try {
      const [, drawn] = decodeAbiParameters(STATE_ABI, row.raw.gameState as `0x${string}`);
      sky = drawn as bigint;
    } catch {
      setError('The round settled but its sky could not be read.');
      setRound(null);
      return;
    }

    // A forfeited or cancelled session carries the pre-draw state, so no sky was ever
    // written. There is nothing to reveal; say so and let the player start again rather than
    // leaving the button reading 'The sky is lighting' with no way out but a reload.
    if (sky === 0n) {
      setError('That round was cancelled on chain before the sky was drawn.');
      setRound(null);
      return;
    }
    setRevealed(0);
    setRound((current) =>
      current && current.sessionKey === round.sessionKey
        ? {
            ...current,
            status: 'lighting',
            sessionId: row.sessionId,
            sky,
            order: revealOrder(sky),
            payout: row.payout !== undefined ? BigInt(row.payout) : null,
          }
        : current,
    );
  }, [snapshot, round]);
  // Bring the stars in one at a time, sounding each as it lands.
  const hostApiRef = useRef(hostApi);
  hostApiRef.current = hostApi;
  useEffect(() => {
    if (!round || round.status !== 'lighting' || !round.sky) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let landed = 0;
    round.order.forEach((cell, index) => {
      const onShape = isLit(round.shape, cell);
      if (onShape) landed++;
      // Each star's sound fires from the same timer that reveals it, rather than being
      // queued ahead against the audio clock. A context that has only just been unlocked has
      // not started advancing yet, so pre-scheduled tones all landed on the same instant
      // while the stars kept their spacing - the sound and the sky came apart.
      timers.push(
        setTimeout(() => {
          setRevealed(index + 1);
          audio.star(index, onShape, panFor(cell));
        }, index * STAR_GAP_MS),
      );
    });
    const total = round.order.length * STAR_GAP_MS;
    if (landed === round.size) timers.push(setTimeout(() => audio.complete(), total + 150));
    else if (multiplierWad(round.size, landed) === 0n)
      timers.push(setTimeout(() => audio.dark(), total + 100));
    timers.push(
      setTimeout(() => {
        setRound((current) =>
          current && current.sessionKey === round.sessionKey
            ? { ...current, status: 'done' }
            : current,
        );
        if (round.sessionId) {
          void hostApiRef.current?.revealOutcome({ sessionId: round.sessionId }).catch(() => {
            // Reveal is presentation only; settlement is already final on chain.
          });
        }
      }, total + 400),
    );
    return () => timers.forEach(clearTimeout);
  }, [round]);
  const placeBet = useCallback(async () => {
    if (!canBet) return;
    audio.unlock();
    setError(null);
    setRevealed(0);
    // Sessions the host already knows about, so a new one can be told apart from them if the
    // optimistic row is dropped before the indexed one lands.
    const knownBefore = (snapshot?.sessions.items ?? [])
      .map((item) => item.sessionId)
      .filter((id): id is string => id !== undefined);
    if (standalone || !hostApi) {
      const sky = demoSky();
      let landed = 0;
      for (const cell of cellsOf(sky)) if (isLit(shape, cell)) landed++;
      setRound({
        // Unique per round: a fixed key would look like the same round to anything keyed on
        // it, including the board's record of which stars have already landed.
        sessionKey: `demo:${performance.now()}`,
        knownBefore,
        shape,
        size,
        wager,
        status: 'lighting',
        sky,
        order: revealOrder(sky),
        payout: payoutFor(wager, size, landed),
      });
      return;
    }
    const pendingKey = `pending:${performance.now()}`;
    setRound({
      sessionKey: pendingKey,
      knownBefore,
      shape,
      size,
      wager,
      status: 'opening',
      sky: null,
      order: [],
      payout: null,
    });
    try {
      const { sessionKey } = await hostApi.openSession({
        wager: wager.toString(),
        gameData: encodeAbiParameters(SHAPE_ABI, [shape]),
        randomnessRequestData: EMPTY_HEX,
      });
      setRound((current) =>
        current?.sessionKey === pendingKey ? { ...current, sessionKey, status: 'waiting' } : current,
      );
    } catch (cause) {
      setRound(null);
      setError(cause instanceof Error ? cause.message : 'Could not open the round.');
    }
  }, [canBet, hostApi, standalone, shape, size, wager, snapshot]);
  const phase: SkyPhase =
    round?.status === 'lighting' ? 'lighting' : round?.status === 'done' ? 'settled' : 'idle';
  const money = (value: bigint) => `${formatAmount(value, decimals)} ${symbol}`;
  // Only a round still in flight owns the board. Once it is done the player is choosing
  // again, and the board has to show what they are choosing - it used to stay frozen on the
  // finished round, so every mark placed afterwards was silent and invisible.
  const settling = round !== null && round.status !== 'opening' && round.status !== 'done';
  const boardShape = settling ? round.shape : shape;
  return (
    <main className="constellation">
      <section className="board" ref={boardRef}>
        <Sky
          shape={boardShape}
          sky={round?.sky ?? null}
          revealed={revealed}
          order={round?.order ?? []}
          phase={phase}
          hovered={hovered}
          roundKey={round?.sessionKey ?? 'none'}
        />
        <div
          className="cells"
          role="group"
          aria-label="The sky. Mark three to six cells."
          style={{ left: grid.left, top: grid.top, width: grid.size, height: grid.size }}
        >
          {Array.from({ length: CELLS }, (_, cell) => {
            const marked = isLit(boardShape, cell);
            const star = round?.sky ? isLit(round.sky, cell) : false;
            const arrived = star && round ? round.order.slice(0, revealed).includes(cell) : false;
            const row = Math.floor(cell / COLUMNS) + 1;
            const column = (cell % COLUMNS) + 1;
            return (
              <button
                key={cell}
                type="button"
                className={`cell${marked ? ' is-marked' : ''}${arrived ? ' is-star' : ''}`}
                onClick={() => toggle(cell)}
                onPointerEnter={() => setHovered(cell)}
                onPointerLeave={() => setHovered(null)}
                disabled={busy}
                aria-pressed={marked}
                aria-label={`Row ${row}, column ${column}${marked ? ', marked' : ''}${arrived ? ', star' : ''}`}
              />
            );
          })}
        </div>
      </section>
      <section className="controls">
        {round?.status === 'done' && (
          <div className={`result${round.payout && round.payout > 0n ? ' is-win' : ''}`} role="status">
            <span className="result-hits">
              {hits} of {round.size} lit
            </span>
            <strong>{round.payout && round.payout > 0n ? money(round.payout) : 'Dark'}</strong>
          </div>
        )}
        <label className="field">
          <span>Wager</span>
          <input
            inputMode="decimal"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value.replace(/[^\d.]/g, ''))}
            disabled={busy}
          />
          <span className="unit">{symbol}</span>
        </label>
        {maxWager !== null && (
          <p className="hint">
            Table limit {formatAmount(maxWager, decimals)} {symbol}
          </p>
        )}
        <div className="shape-state">
          <span className={legalShape ? 'ok' : 'warn'}>
            {size} of {MAX_SHAPE} marked
          </span>
          <span className="dim">
            {legalShape
              ? `pays ${(chanceOfAnyReturn(size) * 100).toFixed(0)}% of draws`
              : `mark ${MIN_SHAPE} to ${MAX_SHAPE}`}
          </span>
        </div>
        {legalShape && (
          <table className="paytable">
            <tbody>
              {outcomes.map((row) => (
                <tr key={row.hits} className={round?.status === 'done' && hits === row.hits ? 'is-hit' : ''}>
                  <th scope="row">
                    {row.hits} of {size}
                  </th>
                  <td>{row.multiplierX.toFixed(2)}×</td>
                  <td className="odds">{(row.chance * 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button type="button" className="bet" onClick={placeBet} disabled={!canBet}>
          {round?.status === 'opening'
            ? 'Opening…'
            : round?.status === 'waiting'
              ? 'Waiting on the draw…'
              : round?.status === 'lighting'
                ? 'The sky is lighting'
                : round?.status === 'done'
                  ? 'Again'
                  : 'Light the sky'}
        </button>
        {round?.status === 'done' && (
          <button type="button" className="reset" onClick={() => { setRound(null); setRevealed(0); }}>
            Clear
          </button>
        )}
        {error && <p className="error">{error}</p>}
        {standalone && <p className="hint standalone">Standalone demo — outcomes drawn locally.</p>}
        {!standalone && !walletReady && <p className="hint">Waiting for the host wallet.</p>}
        <div className="footer">
          <p className="rtp">
            {STARS} stars · return to player 96% · every shape, every size, identical
          </p>
          <button
            type="button"
            className="mute"
            onClick={() => {
              const next = !muted;
              audio.unlock();
              audio.setMuted(next);
              setMuted(next);
            }}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </section>
    </main>
  );
}
