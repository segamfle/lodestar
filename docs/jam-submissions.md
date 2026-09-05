# Chain Jam submissions — ready to paste

Two entries, submitted separately at <https://jam.chain.wtf/#submit>.

Submissions close **2026-09-20**. The jam explicitly says *"Submit early, update
until the deadline. Same URL, newest build counts"* — so submitting now costs
nothing and every later push improves the entry in place.

The form checks the entry automatically the second you submit: it will fetch the
URL, look for the jam widget, and reject it if anything is missing. Both pages
carry the widget and both run standalone.

---

## Entry 1 — Tideline

| Field | Value |
|---|---|
| **Game title** | `Tideline` |
| **Game URL** | `https://segamfle.github.io/lodestar/tideline/` |
| **Declared RTP** | `96` |
| **Discord** | `segamfle01` |
| **X** | *(leave blank, or your handle)* |
| **Telegram** | *(leave blank, or your handle)* |
| **Source access** | `https://github.com/segamfle/lodestar` |

**Pitch / info:**

```
Six rungs stand above the waterline. The tide comes in to a level drawn uniformly
from 0 to 6, and every rung the water reaches or covers pays out. You spread your
wager across the ladder before the draw.

The payout condition is "at or below the tide", not "exactly at it", so the
outcomes nest instead of competing: the lowest rung is a near-certainty at 1.12x,
the top rung is 6.72x, and a spread across both is a genuine portfolio rather than
two unrelated bets. That nesting is what separates it from backing several numbers
on a wheel.

Multipliers are defined as RTP divided by the chance of reaching that rung, so
expected return per unit staked is identical on every rung: exactly 0.96,
whatever you build. The player chooses the shape of their variance and never
touches the edge. That is deliberate — a game where skill moves expected value has
an RTP range rather than an RTP, and a strong player could push effective return
past 98% through no fault of the paytable.

Instant: one session, one VRF draw, settle. The whole decision is made before the
draw, which is a different tension from press-your-luck — commitment rather than
nerve.

No images and no audio files. The harbour wall, the ladder, the bell and the water
are drawn to canvas; the bells are struck metal synthesised from inharmonic
partials, and each one is solved to ring at the moment the water actually reaches
that rung rather than on a guessed offset. The rungs are real buttons over the
canvas, so it plays from the keyboard and reads to a screen reader.

verify-rtp.mjs in the repo proves the 96% against the deployed bytecode rather
than the source: it reads the paytable out of the contract, walks all seven tide
levels across eight allocation shapes including both corners, and compares the
measured expectation to what quoteRiskParams promises the house. Nine checks, zero
wei of drift.
```

---

## Entry 2 — Constellation

| Field | Value |
|---|---|
| **Game title** | `Constellation` |
| **Game URL** | `https://segamfle.github.io/lodestar/constellation/` |
| **Declared RTP** | `96` |
| **Discord** | `segamfle01` |
| **X** | *(leave blank, or your handle)* |
| **Telegram** | *(leave blank, or your handle)* |
| **Source access** | `https://github.com/segamfle/lodestar` |

**Pitch / info:**

```
Twenty-five cells of dark sky. Before the draw you mark a shape of three to six
cells anywhere on the grid. Seven stars then light at random, and you are paid on
how much of your shape came alight.

Placing a shape is a spatial decision, and near-misses are legible at a glance —
four of five lit reads instantly as "almost", which is the most replayable feeling
the form has. Bigger shapes are easier to clip and harder to complete; small ones
are the reverse.

Every shape size returns exactly the same 96%. The multipliers were never chosen
by hand: a weight profile sets the shape of each size's curve and one scale factor
per size is solved to force the expectation onto RTP, so a player cannot improve
their edge by always picking one size. Each size then gets its own threshold and
its own steepness, tuned so the sizes agree on how often they pay and form a
rising ladder of completion prizes — 15x, 22x, 32x, 48x — without disturbing the
return.

The stored multipliers are exact integers, not rounded decimals. Completion prizes
are whole numbers by choice, middle tiers round at six decimals where doubles are
still exact, and the lowest paying tier of each size is solved in integer
arithmetic to absorb the remainder. All four sizes land on 0.96 with zero wei of
drift, not near it.

The sky is drawn with a partial Fisher-Yates over the 25 cells, each index taken
by rejection sampling, so all 480,700 possible skies are equally likely — drawing
seven independent cells and keeping collisions would quietly light fewer than
seven.

Instant: one session, one VRF draw, settle. Nothing to cash out and no button to
press at the right moment; the whole decision is made before the sky lights.

No images and no audio files. Stars arrive one at a time, each with a struck tone
rising through a pentatonic ladder and panned to where it sits on the board, so a
round is a phrase rather than a noise. Completing a shape is the only loud moment
in the game. The reveal order is derived from the sky itself rather than sorted to
put the player's cells last — ordering for suspense would mean every round told
the same lie about how close it came.

verify-rtp.mjs in the repo checks two claims separately, against the deployed
bytecode. The tables are read out of the live contract and summed in integer
arithmetic against the real hypergeometric counts. Then the contract draws four
thousand skies and the results are tested against the distribution they claim to
follow — a biased shuffle would still light seven cells and still pay out with
nothing complaining at runtime, so the only way to catch one is to count. No cell
strays beyond 1.6 sigma; chi-square 2.51 against an 18.47 threshold.
```

---

## Before pressing Submit

- [ ] Open both URLs directly in a fresh tab. Each must be playable on its own —
      that is an eligibility gate, and one entry in the current field documented
      its own failure of it in its pitch.
- [ ] Check the Chain Jam badge appears at the bottom right of both. That is the
      widget proving the entry.
- [ ] Play a few rounds of each with the sound on.

Two separate submissions. The source link is the same repository for both.
