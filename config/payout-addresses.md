# Payout Addresses

Receiving addresses only — public by nature. No private keys, seed phrases, or
exchange credentials belong in this repo, ever.

Owner: LO. Recorded 2026-09-05.

## Primary EVM identity

`0x54ae0851d4C2255a1F0E9237aC94b645f3997f54`

One address, every EVM chain we care about. This is also the address that will
accrue *reputation* — Talent Protocol builder score, Base builder rewards,
verified contract deploys, Farcaster identity. Reputation is not portable, so
once we start building on it, we do not switch.

| Chain    | Why it matters for payouts |
|----------|----------------------------|
| BASE     | Builder rewards, Farcaster mini-apps, USDC bounties. Highest priority. |
| ARB      | Audit contests and grants frequently settle USDC here. |
| OP       | Retro funding rounds, ecosystem grants. |
| ETH      | Immunefi and most protocol bug bounties settle on mainnet. |
| POL      | Gitcoin rounds, some grant programs. |
| LINEA    | Ecosystem incentive campaigns. |
| BSC      | Rarely used by our target platforms. Low priority. |
| AVAX     | Rarely used by our target platforms. Low priority. |

## Non-EVM

| Chain | Address |
|-------|---------|
| BTC   | `bc1qp7mcfj9xl4enhdt3cwsazz9v3fdjchaygfxy6t` |
| LTC   | `LcH1Byv2J4qyqq3KuiwQYPsn91frzu4LBX` |
| DOGE  | `DA38mV1PAYtrDaC9NCDXNAMmtoKVQHKyft` |
| BCH   | `qrcjp0zw870dlm2rmwv20mthzvz8yfpnggyjsakufe` |
| TRON  | `TYpewyhgooHxeE16PgZLgaUcxJPQvzqsX6` |

TRON is the one non-EVM chain here with real payout relevance — USDT-TRC20 is
still a common rail for freelance clients who want to avoid gas fees.

## Gap: no Solana address

This blocks a whole lane. Superteam Earn, Colosseum, and most Solana-ecosystem
bounties pay USDC on Solana and have no alternative rail. If that lane survives
the research pass, we need a SOL address before we can submit anything.

## Note on wallet hygiene

Whichever address we attach to a public builder handle becomes permanently
linked to that identity — every balance and transaction in its history readable
by anyone who looks. If `0x54ae...` currently holds funds LO would rather not
publish, generating a fresh wallet for the public-facing work costs nothing and
takes two minutes. His call; worth making it before the address goes anywhere
public.

## Solana

`HJm75xYkXvhE9qZKjuwPEoGM8ayUxGmyCja1BHdaw26L`

Verified 2026-09-05: 32-byte ed25519 pubkey, well-formed. Solana addresses carry no
checksum of their own, so length and a strict base58 alphabet is the whole of what can be
checked offline. This is the payout rail for Superteam Earn.

## Handles

- GitHub: `segamfle`
- Discord: `segamfle01` — required field on the Chain Jam submission form
