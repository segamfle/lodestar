# Lodestar

Two on-chain wagering games built against the [Chain casino SDK](https://sdk.chain.wtf/casino/GETTING_STARTED.md)
for [Chain Jam Vol. 1](https://jam.chain.wtf).

- **[Tideline](https://segamfle.github.io/lodestar/tideline/)** — a harbour ladder against a rising tide.
- **[Constellation](https://segamfle.github.io/lodestar/constellation/)** — mark a shape on the dark and wait for the stars.

Both are instant games: one session, one VRF draw, settle. The entire decision is
made before the draw, which is a different kind of tension from press-your-luck —
commitment rather than nerve.

---

## The idea both games are built on

The jam requires declared RTP to sit between 93% and 98% **and to match the actual
paytable**. That is an eligibility gate, not a scoring criterion.

There is a trap in it. Any game where player skill moves expected value has an RTP
*range* rather than an RTP, and a strong player pushing effective return past 98%
breaks eligibility through no fault of the table.

So both games are built on one rule:

> **Every legal choice has identical expected value. The player chooses variance,
> never edge.**

The freedom is real — the shape of your risk is entirely yours — the declared
number is exact under every strategy, and there is nothing for an optimiser to
extract.

### Tideline

Six rungs above the waterline. The tide comes in to a level `L` drawn uniformly
from `{0..6}`. You spread your wager across any rungs before the draw, and every
rung the water reaches or covers pays.

The payout condition is `L >= rung`, not `L == rung`, so outcomes nest instead of
competing: the lowest rung is a near-certainty at a thin multiplier, the top rung
is a long shot, and a spread across both is a genuine portfolio rather than two
unrelated bets.

Multipliers are `m_i = RTP / P(L >= i)`, so expected return on a stake at rung `i`
is `stake · m_i · P(L >= i) = stake · RTP`, independent of `i`.

| Rung | Pays when | Probability | Multiplier |
|-----:|-----------|------------:|-----------:|
| 1 | L ≥ 1 | 6/7 | 1.12× |
| 2 | L ≥ 2 | 5/7 | 1.344× |
| 3 | L ≥ 3 | 4/7 | 1.68× |
| 4 | L ≥ 4 | 3/7 | 2.24× |
| 5 | L ≥ 5 | 2/7 | 3.36× |
| 6 | L ≥ 6 | 1/7 | 6.72× |

Every rung returns exactly 0.96 per unit staked, so any allocation of any size
returns exactly 0.96. Max payout 6.72×, well under the 100× heavy-tail threshold.

### Constellation

Twenty-five cells of dark sky. Before the draw you mark a shape of three to six
cells anywhere on the grid. Seven stars light at random, and you are paid on how
many of your marks came alight. Hits follow the hypergeometric distribution.

Multipliers were never chosen by hand. A weight profile sets the shape of each
size's curve and one scale factor per size is solved to force the expectation onto
RTP, so fairness across shape sizes is true by construction. Each size then gets
two dials of its own — the threshold it starts paying at, and how steeply its
prizes climb — tuned so the sizes agree on how often they pay and form a rising
ladder of top prizes, without disturbing the return.

Seven stars on twenty-five cells, `C(25,7) = 480,700` equally likely skies:

| Shape | Pays from | Completion prize | Pays at all |
|------:|----------:|-----------------:|------------:|
| 3 cells | 2 hits | 15× | 17.96% |
| 4 cells | 2 hits | 22× | 30.66% |
| 5 cells | 3 hits | 32× | 11.30% |
| 6 cells | 3 hits | 48× | 19.37% |

All four sizes return exactly 0.96 with **zero wei of drift**. The multipliers are
exact integers: completion prizes are whole numbers by choice, middle tiers round
at six decimals where doubles are still exact, and the lowest paying tier of each
size is solved in integer arithmetic to absorb the remainder.

---

## Verifying the claims

Neither game asks you to take the RTP on trust. Both verifiers read the paytable
out of the **deployed bytecode** rather than from the script that generated it,
and check it in integer arithmetic.

```bash
# Terminal 1 — the SDK's local stack (chain, VRF node, simulator)
cd vendor/casino-sdk/casino-sdk && npm install && npm start

# Terminal 2
npm install
node games/tideline/verify-rtp.mjs        # 9 checks
node games/constellation/verify-rtp.mjs   # tables, then 4,000 drawn skies
```

`games/constellation/verify-rtp.mjs` checks two claims that can fail
independently. The tables are summed against the real hypergeometric counts. Then
the contract draws four thousand skies and the results are tested against the
distribution they claim to follow — a biased shuffle would still light seven cells
and still pay out, with nothing complaining at runtime, so the only way to catch
one is to count.

Unit tests run without a chain:

```bash
node games/tideline/src/lib/tide.test.mts            # bell timing, 44 cases
node games/constellation/src/lib/constellation.test.mts
```

Regenerate Constellation's paytable — it refuses to print if rounding moved the
return by more than a wei:

```bash
node games/constellation/solve-paytable.mjs   # explores the design space
node games/constellation/emit-table.mjs       # emits exact WAD integers
```

---

## Building

Node 22+.

```bash
# Fetch the SDK (not vendored: it is someone else's code)
mkdir -p vendor && curl -fsSL https://sdk.chain.wtf/sdk/casino-sdk.zip -o vendor/casino-sdk.zip
unzip -q vendor/casino-sdk.zip -d vendor/casino-sdk
npm install --prefix vendor/casino-sdk/casino-sdk --omit=dev --workspaces=false

cd games/tideline && npm install && npm run dev      # :5180
cd games/constellation && npm install && npm run dev # :5181
```

Point the simulator at a game and pick its contract in the setup panel:
`http://localhost:3300/?game=http://localhost:5180`

Drop `games/*/contracts/*.sol` into `vendor/casino-sdk/casino-sdk/simulator/contracts/`
and the local node compiles, deploys and registers them within a couple of
seconds. Both contracts are self-contained — the SDK interface is inlined, because
the hot-reload compiler builds each file standalone.

## Layout

```
games/tideline/          contract, frontend, RTP verifier
games/constellation/     contract, frontend, paytable solver, RTP verifier
.github/workflows/       builds both, runs their tests, deploys to Pages
```

Deployed by GitHub Actions on every push to `main`. Each game gets its own
directory so it keeps a standalone URL, which is what the jam treats as the entry.

## Notes on the build

Both games are static, load fast, and run standalone as playable demos outside the
host iframe — the standalone draw uses the same rejection sampling the contract
does, because a demo whose odds differ from the game would misrepresent it.

No audio files and no images. Everything is synthesised or drawn: struck metal
from inharmonic partials through a generated room, canvas art with grain and a
vignette over it. The rungs and the cells are real buttons over the canvas, so both
games work from the keyboard and read to a screen reader without the canvas having
to fake either.

## Licence

MIT.
