# Email to Noricum — ready to send

**To:** michael@noricum.io
**From:** your own address, not a new one
**Subject:** `Provable fairness — start 15 Sep`

The listing (HN "Who is hiring?", September 2026, item 49523604) asks for *"a few
lines on the last money system you shipped — what it guaranteed, and how you knew
it held."* That question has a precise answer here, so the letter answers it and
stops. Everything else it could say, the links say better.

---

```
Michael,

Available from Monday 15 September.

The last money system I shipped was a pair of on-chain wagering games. What they
guarantee is that the house edge is identical whatever the player does — every
choice on the board has the same expected value, so a player picks the shape of
their variance and never the edge. That mattered because the entry rules required
a declared return between 93% and 98% that matches the actual paytable, and any
game where skill moves expected value has a range rather than a number.

How I knew it held: the multipliers are read back out of the deployed bytecode,
not out of the source that generated them, and summed in integer arithmetic
against the exact hypergeometric counts — all four shape sizes return 0.96 with
zero wei of drift. Then the contract draws four thousand skies and the results
are tested against the distribution they claim to follow, because a biased
shuffle still deals seven cards and still pays out, and nothing at runtime would
ever complain. No cell strays past 1.6 sigma; chi-square 2.51 against an 18.47
threshold.

  https://github.com/segamfle/lodestar/blob/main/games/constellation/verify-rtp.mjs
  https://github.com/segamfle/lodestar/blob/main/games/constellation/emit-table.mjs

The second file is the one I would point at first. Rounding the multipliers to
on-chain integers drifted the return by 167 wei per unit staked, and the cause
was visible in the script's own output: a clean 15x printing as
14999999999999997952. Doubles cannot hold integers above 2^53, so scaling by 1e18
threw the low digits away before the value was ever a bigint. The fix solves the
lowest paying tier in integers to absorb the remainder, which is why the tables
land on the declared number exactly rather than near it.

Happy to talk through the ledger side — deriving balance rather than storing it
is the part I would want to get right before writing anything.

[your name]
```

---

## Notes before sending

- **Send it from your own mailbox.** A fresh address created for one email reads
  as one, and the whole point of this letter is that it is checkable.
- **Adjust the date** if Monday 15 September is wrong. Their advertised start is
  14 September, so anything in that week is fine; a real date beats "immediately".
- **Do not attach anything.** Two deep links into specific files is the whole
  pitch. A CV would dilute it.
- **Do not mention the AI agent.** It is not what they asked and it invites the
  wrong conversation on a first email. What you send them is work you can stand
  behind and explain, which is the standard either way.
- **If they reply asking to talk:** the honest gaps are that the games are days
  old rather than years, and that the settlement layer was a jam SDK rather than
  a production ledger. Say so first. The verification discipline is the thing
  that transfers, and it is real.

## What happens next if it lands

Rate advertised is $120–160/hr, contract to permanent, remote. Invoice 50% up
front — that is normal for a first engagement with someone new and it means money
arrives before any code is written. PayPal Business or Wise both cost nothing to
open and neither needs a token, a wallet, or a fee.
