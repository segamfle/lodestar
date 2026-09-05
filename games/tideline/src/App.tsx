import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeMaxWager } from '@chain/casino-sdk/guest';
import { decodeAbiParameters, encodeAbiParameters, parseUnits } from 'viem';
import { Ladder, type LadderPhase } from './components/Ladder';
import { useCasinoHost } from './lib/useCasinoHost';
import { LEVELS, PAYTABLE, RUNGS, spreadEvenly, summarise, totalStaked } from './lib/tideline';
import { rungCrossings, rungY, waterlineFor } from './lib/tide';
import { audio } from './lib/audio';
import { formatAmount } from './lib/money';

const EMPTY_HEX = '0x' as const;
const STAKES_ABI = [{ type: 'uint256[6]' }] as const;
const STATE_ABI = [{ type: 'uint256[6]' }, { type: 'uint256' }, { type: 'bool' }] as const;

/** How long the water takes to climb before the payout is revealed. */
const RISE_MS = 2200;

type RoundStatus = 'opening' | 'waiting' | 'rising' | 'done';

interface Round {
  sessionKey: string;
  sessionId?: string;
  stakes: bigint[];
  wager: bigint;
  status: RoundStatus;
  level: number | null;
  knownBefore: string[];
  payout: bigint | null;
}

const isTerminal = (phase: unknown) =>
  phase === 3 || phase === 4 || phase === 5; // SETTLED / FORFEITED / CANCELLED

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
 * Draw a tide level locally for the standalone demo, using the same rejection sampling the
 * contract uses. Never used when a host is present — the chain owns every real outcome — but
 * the jam requires the page to be playable when opened directly, and a demo that draws with
 * a different distribution than the game would be a lie about how the game behaves.
 */
function demoLevel(): number {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  for (const b of bytes) if (b < 252) return b % LEVELS;
  return demoLevel();
}

export function App() {
  const { hostApi, snapshot, standalone } = useCasinoHost();

  const [selected, setSelected] = useState<number[]>([1, 3, 6]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [amountText, setAmountText] = useState('1');
  const [round, setRound] = useState<Round | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Rungs the water has actually reached so far, so the labels do not run ahead of it. */
  const [submerged, setSubmerged] = useState(0);
  const [muted, setMuted] = useState(audio.muted);

  const decimals = snapshot?.token.decimals ?? 18;
  const symbol = snapshot?.token.symbol ?? 'chUSD';

  const wager = useMemo(() => {
    try {
      const parsed = parseUnits(amountText || '0', decimals);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }, [amountText, decimals]);

  const stakes = useMemo(() => spreadEvenly(wager, selected), [wager, selected]);
  const preview = useMemo(() => summarise(stakes), [stakes]);

  // The steepest rung in the selection sets the exposure the house has to price, so that is
  // what the table limit has to be computed against. Undefined means the host has not sent
  // enough risk data yet, which is a normal early state rather than a failure.
  const maxWager = useMemo<bigint | null>(() => {
    if (!snapshot) return null;
    try {
      const steepest = selected.length ? Math.max(...selected) : 1;
      const limit = computeMaxWager(snapshot, {
        maxMultiplierX: PAYTABLE[steepest - 1].multiplier,
      });
      return limit === undefined ? null : BigInt(limit);
    } catch {
      return null;
    }
  }, [snapshot, selected]);

  const walletReady = standalone || snapshot?.wallet.status === 'ready';
  const busy = round !== null && round.status !== 'done';
  // Displayed but never checked, so an over-limit wager left the button live and turned a
  // chain revert into the player's error message.
  const withinLimit = maxWager === null || wager <= maxWager;
  const canBet = walletReady && wager > 0n && selected.length > 0 && withinLimit && !busy;

  const toggleRung = useCallback(
    (rung: number) => {
      if (busy) return;
      audio.unlock();
      audio.knock(rung);
      setSelected((current) =>
        current.includes(rung)
          ? current.filter((r) => r !== rung)
          : [...current, rung].sort((a, b) => a - b),
      );
    },
    [busy],
  );

  // Settle from host snapshots: once our session row goes terminal, read the tide level the
  // chain actually drew and start the climb.
  useEffect(() => {
    if (!round || round.status !== 'waiting' || !snapshot) return;
    const row = findOurSession(snapshot.sessions.items, round.sessionKey, round.knownBefore);
    if (!row || !(row.isSettled || isTerminal(row.phase))) return;

    if (!row.raw.gameState) return; // terminal but not yet synced — wait for the next push

    let level: number;
    try {
      const [, drawn] = decodeAbiParameters(STATE_ABI, row.raw.gameState as `0x${string}`);
      level = Number(drawn);
    } catch {
      setError('The round settled but its state could not be read.');
      setRound(null);
      return;
    }

    const payout = row.payout !== undefined ? BigInt(row.payout) : null;
    setRound((current) =>
      current && current.sessionKey === round.sessionKey
        ? { ...current, status: 'rising', sessionId: row.sessionId, level, payout }
        : current,
    );
  }, [snapshot, round]);

  // Score the climb. Crossing times come from the same curve the canvas animates, so a rung
  // chimes at the moment the water covers it rather than on a guessed offset.
  useEffect(() => {
    if (!round || round.status !== 'rising' || round.level === null) return;
    const from = waterlineFor(0);
    const to = waterlineFor(round.level);

    // The wash is scaled by the tide, so how far the water climbs is audible and not just
    // visible. It used to play at one level whatever happened.
    audio.startSwell(round.level);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const crossings = rungCrossings(from, to);

    for (const { rung, at } of crossings) {
      audio.bell(rung, at, round.stakes[rung - 1] > 0n ? 1 : 0.45);
      // The label darkens when the water gets there, not when the result arrives. Marking
      // every rung the tide would eventually reach gave the answer away before the climb.
      timers.push(setTimeout(() => setSubmerged(rung), at * 1000));
    }

    // The crown used to fire at a hardcoded 1.1s while the water actually crowns at about
    // 1.59s, so the loudest sound in the game landed half a second before the thing it was
    // celebrating.
    const crownAt = crossings.find((c) => c.rung === RUNGS)?.at;
    if (crownAt !== undefined) {
      audio.crown(crownAt);
      // Pull the wash down under it. The bells were fighting a constant bed of noise, which
      // is why a jackpot measured barely louder than a bust.
      audio.duckSwell(crownAt - 0.1);
    }
    if (round.level === 0) audio.ebb();

    timers.push(setTimeout(() => audio.stopSwell(), RISE_MS));
    return () => {
      timers.forEach(clearTimeout);
      audio.stopSwell();
    };
  }, [round]);

  // Let the water finish climbing, then tell the host to reveal — until that call the host
  // hides the payout so its own balance display cannot spoil the result.
  const hostApiRef = useRef(hostApi);
  hostApiRef.current = hostApi;
  useEffect(() => {
    if (!round || round.status !== 'rising') return;
    const timer = setTimeout(() => {
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
    }, RISE_MS);
    return () => clearTimeout(timer);
  }, [round]);

  const placeBet = useCallback(async () => {
    if (!canBet) return;
    audio.unlock();
    setError(null);
    setSubmerged(0);

    // Sessions the host already knows about, so a new one can be told apart from them if the
    // optimistic row is dropped before the indexed one lands.
    const knownBefore = (snapshot?.sessions.items ?? [])
      .map((item) => item.sessionId)
      .filter((id): id is string => id !== undefined);

    const staked = totalStaked(stakes);
    if (staked !== wager) {
      setError('Allocation does not add up to the wager.');
      return;
    }

    if (standalone || !hostApi) {
      const level = demoLevel();
      setRound({
        // Unique per round: a constant key looks like one continuous round to anything keyed
        // on it, including the water's memory of where it started.
        sessionKey: `demo:${performance.now()}`,
        knownBefore,
        stakes,
        wager,
        status: 'rising',
        level,
        payout: summarise(stakes).outcomes[level].payout,
      });
      return;
    }

    const pendingKey = `pending:${performance.now()}`;
    setRound({
      sessionKey: pendingKey,
      knownBefore,
      stakes,
      wager,
      status: 'opening',
      level: null,
      payout: null,
    });

    try {
      const { sessionKey } = await hostApi.openSession({
        wager: wager.toString(),
        gameData: encodeAbiParameters(STAKES_ABI, [stakes as readonly bigint[] as never]),
        randomnessRequestData: EMPTY_HEX,
      });
      setRound((current) =>
        current?.sessionKey === pendingKey
          ? { ...current, sessionKey, status: 'waiting' }
          : current,
      );
    } catch (cause) {
      setRound(null);
      setError(cause instanceof Error ? cause.message : 'Could not open the round.');
    }
  }, [canBet, hostApi, standalone, stakes, wager, snapshot]);

  const phase: LadderPhase =
    round?.status === 'rising' ? 'rising' : round?.status === 'done' ? 'settled' : 'idle';

  const money = (value: bigint) => `${formatAmount(value, decimals)} ${symbol}`;

  return (
    <main className="tideline">
      <section className="scene">
        <Ladder
          stakes={round && round.status !== 'opening' ? round.stakes : stakes}
          level={round?.status === 'rising' || round?.status === 'done' ? round.level : null}
          phase={phase}
          hovered={hovered}
          roundKey={round?.sessionKey ?? 'none'}
        />

        <div className="rung-hits" aria-hidden={busy}>
          {Array.from({ length: RUNGS }, (_, i) => RUNGS - i).map((rung) => {
            const active = selected.includes(rung);
            const covered = rung <= submerged;
            return (
              <button
                key={rung}
                type="button"
                className={`rung-hit${active ? ' is-staked' : ''}${covered ? ' is-covered' : ''}`}
                // Positioned from rungY, the same function the canvas draws the rung with.
                // Letting CSS approximate it is how the labels drifted off the timber.
                style={{ top: `${rungY(rung) * 100}%` }}
                onClick={() => toggleRung(rung)}
                onPointerEnter={() => setHovered(rung)}
                onPointerLeave={() => setHovered(null)}
                disabled={busy}
                aria-pressed={active}
                aria-label={`Rung ${rung}, pays ${PAYTABLE[rung - 1].multiplier.toFixed(3)} times, reached ${Math.round(PAYTABLE[rung - 1].probability * 100)} percent of tides`}
              >
                <span className="rung-index">{rung}</span>
                <span className="rung-mult">{PAYTABLE[rung - 1].multiplier.toFixed(2)}×</span>
                <span className="rung-odds">{Math.round(PAYTABLE[rung - 1].probability * 100)}%</span>
              </button>
            );
          })}
        </div>

        {round?.status === 'done' && (
          <div className={`result${round.payout && round.payout > 0n ? ' is-win' : ''}`} role="status">
            <span className="result-level">Tide {round.level}</span>
            <strong>{round.payout && round.payout > 0n ? money(round.payout) : 'Dry ladder'}</strong>
          </div>
        )}
      </section>

      <section className="controls">
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

        <dl className="readout">
          <div>
            <dt>Rungs</dt>
            <dd>{selected.length ? selected.join(' · ') : 'none'}</dd>
          </div>
          <div>
            <dt>If the tide crowns</dt>
            <dd>{money(preview.max)}</dd>
          </div>
          <div>
            <dt>Chance of any return</dt>
            <dd>{Math.round(preview.chanceOfReturn * 100)}%</dd>
          </div>
        </dl>

        <button type="button" className="bet" onClick={placeBet} disabled={!canBet}>
          {round?.status === 'opening'
            ? 'Opening…'
            : round?.status === 'waiting'
              ? 'Waiting on the draw…'
              : round?.status === 'rising'
                ? 'The tide is coming in'
                : round?.status === 'done'
                  ? 'Again'
                  : 'Let the tide in'}
        </button>

        {round?.status === 'done' && (
          <button
            type="button"
            className="reset"
            onClick={() => {
              setRound(null);
              setSubmerged(0);
            }}
          >
            Clear
          </button>
        )}

        {error && <p className="error">{error}</p>}
        {standalone && <p className="hint standalone">Standalone demo — outcomes drawn locally.</p>}
        {!standalone && !walletReady && <p className="hint">Waiting for the host wallet.</p>}

        <div className="footer">
          <p className="rtp">Return to player 96% · every rung, every spread, identical</p>
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
