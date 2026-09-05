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
  ROWS,
  STARS,
  cellsOf,
  chanceOfAnyReturn,
  countCells,
  demoSky,
  isLit,
  multiplierWad,
  outcomesFor,
  payoutFor,
  toggleCell,
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

  const [shape, setShape] = useState<bigint>((1n << 6n) | (1n << 12n) | (1n << 18n) | (1n << 8n));
  const [hovered, setHovered] = useState<number | null>(null);
  const [amountText, setAmountText] = useState('1');
  const [round, setRound] = useState<Round | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(audio.muted);

  const decimals = snapshot?.token.decimals ?? 18;
  const symbol = snapshot?.token.symbol ?? 'chUSD';

  const size = countCells(shape);
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

  const full = size >= MAX_SHAPE;
  const walletReady = standalone || snapshot?.wallet.status === 'ready';
  const busy = round !== null && round.status !== 'done';
  const canBet = walletReady && wager > 0n && legalShape && !busy;

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
      // both compute from the same stale shape, so the second silently discarded the first
      // and a mark the player had just placed vanished.
      setShape((current) => {
        const next = toggleCell(current, cell);
        // Let them drop below the minimum while rearranging, but never build past the
        // maximum - ignoring the click is clearer than an error they have to dismiss.
        if (countCells(next) > MAX_SHAPE) return current;
        audio.mark(!isLit(current, cell), panFor(cell));
        return next;
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
        sessionKey: 'demo',
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
  const boardShape = round && round.status !== 'opening' ? round.shape : shape;

  return (
    <main className="constellation">
      <section className="board">
        <Sky
          shape={boardShape}
          sky={round?.sky ?? null}
          revealed={revealed}
          order={round?.order ?? []}
          phase={phase}
          hovered={hovered}
        />

        <div className="cells" role="group" aria-label="The sky. Mark three to six cells.">
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
                disabled={busy || (full && !marked)}
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
            {size} of {ROWS * COLUMNS} marked
          </span>
          <span className={full ? 'warn' : 'dim'}>
            {/* A click that does nothing and says nothing reads as a broken game. When the
                shape is full the empty cells are disabled and this says why. */}
            {full
              ? `${MAX_SHAPE} is the most — clear one to move it`
              : legalShape
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
