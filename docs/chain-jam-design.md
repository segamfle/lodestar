# Chain Jam Vol. 1 — game design

Deadline: submissions close **2026-09-20**, judging 21–30 Sep, USDC paid **2026-10-01**.
Prizes: $500 / $350 / $150. Four entries in the gallery as of 2026-09-05.
Separately: 25% of lifetime revenue on any submission chain.wtf chooses to integrate,
whether or not it places.

## The constraint that shapes everything

Declared theoretical RTP must sit between 93% and 98% **and match the actual paytable**.
That is checked, and a mismatch is an eligibility failure, not a scoring deduction.

The trap: any game where player skill changes expected value has an RTP *range*, not an
RTP. A strong player pushing effective RTP past 98% breaks eligibility through no fault of
the paytable. So both games below are built on the same principle —

> **Every legal choice has identical expected value. The player chooses variance, never edge.**

Agency stays real (the shape of your risk is entirely yours), the declared number is exact
under every strategy, and there is nothing for an optimizer to extract.

## Game 1 — TIDELINE

**Shape:** instant. One session, one VRF draw, settle.

A harbour ladder stands in the water. Six rungs. The tide comes in to a level `L` drawn
uniformly from `{0,1,2,3,4,5,6}`. You spread your wager across any rungs you like before
the draw. **Every rung the water reaches or covers pays.** Rungs left dry pay nothing.

Because the payout condition is `L >= i` rather than `L == i`, the outcomes nest instead of
competing — a low rung is a near-certainty at a thin multiplier, the top rung is a long shot,
and a spread across both is a genuine portfolio rather than two unrelated bets. That nesting
is what separates this from betting several numbers on a wheel.

Multipliers at RTP 96%, `m_i = 0.96 / P(L >= i)`:

| Rung | Pays when | Probability | Multiplier |
|-----:|-----------|------------:|-----------:|
| 1 | L ≥ 1 | 6/7 | 1.12× |
| 2 | L ≥ 2 | 5/7 | 1.344× |
| 3 | L ≥ 3 | 4/7 | 1.68× |
| 4 | L ≥ 4 | 3/7 | 2.24× |
| 5 | L ≥ 5 | 2/7 | 3.36× |
| 6 | L ≥ 6 | 1/7 | 6.72× |

Each rung returns exactly 0.96 per unit staked, so any allocation of any size returns 0.96.
Declared RTP 96%, provably, with no strategy-dependent tail.

Max payout is 6.72× a full stake on rung 6 — far under the 100× heavy-tail threshold, so
this takes the ordinary reserve path and never touches the jackpot machinery.

**Why it holds attention:** the decision is a shape, not a number. Ladder-heavy-at-the-bottom
is a grind; everything on rung 6 is a lottery; a barbell is neither. Players will develop
house styles and argue about them.

**Senses:** water against stone, rope creak, the bell on the last rung when the tide crowns
it. Rising water is one of the few animations that stays tense on the thousandth viewing
because the eye tracks a line, not a spinner.

## Game 2 — CONSTELLATION

**Shape:** instant. One session, one VRF draw, settle.

A 5×5 field of dark sky. Before the draw you choose a **shape** from a small palette —
named forms of 3 to 6 cells, placed anywhere on the grid. The draw lights `K` stars at
random positions. You are paid on how much of your shape came alight.

Larger shapes are easier to partially hit and harder to complete; small shapes are the
reverse. Multipliers are solved per shape-size and per hit-count so that expected return is
identical across every shape in the palette. The player picks the silhouette of their
variance and nothing else.

Exact multiplier tables get solved from the hypergeometric distribution during
implementation and unit-tested against a Monte Carlo run, so the declared RTP is verified
by simulation before submission, not asserted.

**Why it holds attention:** placing a shape on a grid is a spatial decision, and spatial
decisions feel personal in a way that picking a number never does. Near-misses are legible
at a glance — four of five lit reads instantly as *almost*, which is the single most
replayable feeling in the medium.

**Senses:** near-silence, then single bell tones per star as they light, pitched to the
count. Full completion earns the only loud moment in the game.

## What is deliberately not here

The jam disqualifies classics (blackjack, roulette, baccarat) and existing originals
(plinko, dice, limbo, crash clones). It also scores novelty directly. Press-your-luck with
a cash-out button — the mines/crash family — is the obvious thing to reach for and the most
likely to read as derivative to a judge who has seen forty of them. Both games above settle
in a single draw with the entire decision made beforehand, which is a different genre of
tension: commitment rather than nerve.

## Build order

1. `TidelineGame.sol` against `ICasinoGameV2`, dropped into `simulator/contracts/` for
   hot reload. Unit-test the payout table and the RTP invariant first.
2. Tideline frontend from the coinflip example's bridge wiring, own visuals.
3. `ConstellationGame.sol` plus its solved multiplier tables and Monte Carlo verification.
4. Constellation frontend.
5. Both: `game.manifest.json`, jam widget script tag, standalone playability check,
   unhappy-path testing (slow indexer, stuck randomness, refresh mid-round).

## Verified environment

Local stack confirmed working 2026-09-05: Hardhat chain on `:8545`, VRF verify-network
router, casino host + vault + test token deployed, simulator on `:3300`, coinflip example
on `:3100`. A test bet completed the full `openSession → VRF → onRandomness → settle →
reveal` loop. Contracts dropped into `simulator/contracts/` compile, deploy and register
automatically within seconds.

Node v24.11.1 (SDK requires v22+).
