# Funding the Business Splash Wallet ("Add funds") — v2 Phase 2 §4.3

Status: built 25 Oct 2026 on `v2/phase2-backend`. Brief: `SPLASH_SUI_V2_PROMPT.md`
§4.3, decisions D1, D3, D6, D7, D8. Code: `lib/funding/wallet-funding.ts` (rules),
`lib/funding/providers.ts`, `lib/funding/swap-routes.ts`, `lib/compliance/kyt.ts`,
`lib/server/funding-conversion.ts`, `lib/server/wallet-funding.ts` (service),
`lib/server/wallet-funding-store.ts` (Postgres, migration 0038),
`app/api/wallet/funding/*`, `app/api/webhooks/funding/[provider]`. Tests:
`tests/wallet-funding.test.mjs`.

## One destination

Every way of adding funds delivers to **the business wallet**: the multisig
address the business's `BusinessAccount` names on chain, read for each request
(`fundingDestination`). The request never names it. If the business has no
wallet yet, nothing is quoted or made (`no_business_wallet`). An address Splash
controls (the operator, the gas sponsor, the treasury address) is refused as a
destination and as a funding source, even though a registered multisig can
never be one. Splash never receives the funds (D1, D3).

The Phase 1 refusals stay as they were: the old ledger-funding path
(`lib/server/funding-sessions.ts`) gives out no deposit address on mainnet, and
production on mainnet refuses the keys that made them. The new path never
derives or configures a deposit address; it uses the business wallet.

## Channels

| Channel | What happens | Quote |
|---|---|---|
| `provider` | A funding partner (Halliday, Stripe, TransFi; Bridge stubbed and off) takes a bank transfer or card payment and delivers USDC on Sui to the wallet. | The partner's quote: what it delivers, what the business pays, the partner's fee as its own line. |
| `wallet` | Any Sui wallet sends USDC, or USDT / USDsui, to the wallet. | USDC: none needed. USDT / USDsui: the conversion quote, peg-guarded. |
| `cctp` | USDC burned on another chain with CCTP V2 and minted to the wallet (`planFunding`, `mintRecipient` = the wallet, checked). | Circle's fast-transfer fee bound as its own line (0 for standard). |
| `swap` | A non-USDC token on another chain, routed by Li.Fi or deBridge to USDC on Sui at the wallet. | The route's estimate, its floor (the route reverts below it) and its fee line. USDT routes are peg-guarded. |

Splash adds no fee line to a top-up. A partner's, a route's or Circle's fee is
theirs, from their quote, shown as its own line, never marked up (A1).

## The API (Transfer step 3 reuses it)

All under `/api/wallet/funding`, behind the wallet route's gate (session,
`requireSessionAccount`, own membership, the org's live wallet context):

- `GET /` — options: channels, partners (named only when in `SIGNED_PARTNERS`,
  by role otherwise), the business's sources, and USDC on hold.
- `POST /quotes` — the quote, first. Nothing is stored.
- `POST /intents` — one top-up. `Idempotency-Key` header (or `clientKey`)
  required: the same key returns the same top-up, a key reused for a different
  request is refused (`idempotency_key_reused`). `acceptedArrivesMinMinor` is
  the least the accepted quote said would arrive; a fresh quote below it is
  refused (`quote_changed`, with the new quote) and nothing is made. Transfer's
  step 3 sends `purpose: 'transfer_top_up'` and `transferRef`.
- `GET /intents`, `GET /intents/:id`, `DELETE /intents/:id` (cancel while
  waiting for funds).
- `POST /deposits { digest, intentId? }` — record what a Sui transaction
  delivered. Only the digest is taken; amount, coin and sender come from the
  chain. `GET /deposits`; `POST /deposits/:id` looks at a held deposit again.
- `GET|POST /sources`, `DELETE /sources/:id`, `POST /sources/:id/challenge`,
  `POST /sources/:id/verify` — owners only for changes.
- `POST /api/webhooks/funding/:provider` — a partner's signed status update.

Viewers read only. A partner order's idempotency key is the funding intent's id.

## Funding sources

- **Bank account in the company's name.** Added with the holder name, which
  must be the business's registered (legal) name after folding case,
  punctuation and the usual legal suffixes (`Sdn. Bhd.` = `Sendirian Berhad`).
  Kept as a SHA-256 fingerprint of country + bank code + number and the last
  four digits; the number itself is never stored. Pending until its first
  deposit.
- **Card.** Added as the funding partner identifies it (its fingerprint and
  last four), holder in the company's name. Pending until its first deposit.
- **Wallet the business controls.** Sui, Solana or EVM. Pending until an owner
  signs Splash's message with it: business name, chain, address, a single-use
  nonce and a 15-minute expiry. The challenge is spent before the signature is
  checked, so a wrong signature burns it. Sui signatures are checked with the
  SDK's personal-message verifier, Solana ones as ed25519 over the message.
  **EVM proofs are not built** (they need secp256k1 recovery, which the repo
  has no direct dependency for); an EVM source stays pending and its deposits
  are held.

**First use is checked once** (`first_use_at` is written once): a bank account
or card passes when the partner's reported payer is that source and in the
company's name, which also verifies it; a proven wallet passes when its
address screens clear. A failed first use holds the deposit.

## Deposits: screened, held or cleared

Each `(transaction, wallet, coin type)` is recorded once (unique index), from
the chain's balance changes for the business wallet only, in USDC, USDT or
USDsui. Every deposit's origin is screened on arrival (`lib/compliance/kyt.ts`):

- `BLOCK` (a sanctions hit) → **blocked**, for good.
- Held, with reasons, when the source is unknown, not verified, revoked,
  failed its first use, is not the payer the top-up named, or screening gave
  no verdict or asked for review.
- Otherwise **cleared**.

Origin: the Sui sender; for a CCTP mint, the burner decoded from the
BurnMessageV2 body in Circle's own `MessageReceived` event (only from Circle's
MessageTransmitterV2 package id, recorded in `docs/mainnet-checks-2026-10.md`
§5); for a partner, the payer it reports in its verified webhook; for a swap,
the wallet the business proved and named for that top-up (a route's solver
delivers on Sui, so the Sui sender is not the business).

**Held funds are not spent.** `requestWalletPayment` and
`requestOpenIntentPayment` refuse (`funds_on_hold`) when the wallet's USDC less
held and blocked USDC does not cover principal plus the fee bound. Splash has
no key to the wallet and cannot freeze it: this stops every payment Splash
builds, sponsors or routes. A staff member's own allowance spend, signed on
their device, is bounded by their spending rule, not by holds (see Open).

A held deposit is looked at again when its wallet is proven, or on request; a
blocked one never changes, and nothing clears without a provider's verdict.

## USDT and USDsui

They arrive as they are and are recorded as such (never counted as USDC). The
conversion quote reads the coin's **own** DeepBook pool (`USDT_USDC`,
`USDSUI_USDC`, `getDeepbookPairBook`) and refuses (`off_peg`) when the mid or
the bid the swap would take is more than 30 bps from 1, `peg_monitor`'s own
`MAX_DEVIATION_PPM` (3,000 ppm). No reading, or a book wider than 1%, refuses
(`peg_unverified`). The quote holds for 5 minutes; an expired quote is refused,
never refreshed. The on-chain `PegState` is not read: no v2 path pushes it
(there is no dollar oracle), so it is stale by design.

**The conversion itself is not built**: the swap runs in the business's own
wallet, so its quorum signs it, and the signing request needs a DeepBook swap
command the transaction reader does not accept yet. `executeConversion` refuses
(`conversion_not_built`); the coins stay in the wallet untouched.

## Partners and routes fail closed

Outside production every partner and route is a sandbox, labelled `sandbox:
true` on everything it returns. In production, without credentials a partner
refuses with `provider_not_configured` (a route with `route_not_configured`);
with credentials it still refuses (`provider_not_connected`), because no
partner's or route's API is wired yet and a guessed integration would be a
fabricated quote or reference. No sandbox result is reachable in production,
and none of these keys is required at boot.

Screening: Chainalysis's free sanctions list while Elliptic is not connected
(D8); Elliptic configured answers no verdict; production with neither answers
no verdict; development uses a labelled sandbox.

## Partner webhooks

`POST /api/webhooks/funding/:provider`: the raw body's HMAC-SHA256 signature
(`x-splash-funding-signature: t=…,v1=…` over `t.body`) is checked first, inside
a 5-minute window. The event must name its intent and the partner's own order
reference for it, or it is acknowledged and ignored. Each event id counts once
(`funding_provider_events`). Statuses never go backwards; `arrived` is proven
on chain and reachable from any status, and nothing leaves it. A delivery is
recorded only from the chain by the digest the partner names; if the chain has
not seen it yet the webhook answers 503 and the retry counts.

## Open

- Live partner and route APIs (Halliday, Stripe, TransFi, Bridge, Li.Fi,
  deBridge) and Elliptic: each needs its contract and docs.
- The conversion signing request (a DeepBook swap command in
  `wallet-tx-describe.ts`, reviewed like every other command).
- EVM wallet proofs.
- A chain watcher for deposits nobody reports (today a deposit is recorded
  when the business, a partner or the Transfer flow names its digest).
- The CCTP `MessageReceived` field names and the BurnMessageV2 offsets are
  from Circle's V2 message format; confirm on a real testnet mint.
- Holds do not bind a staff member's own allowance spend.
