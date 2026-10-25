# Funding the Business Splash Wallet ("Add funds") — v2 Phase 2 §4.3

Status: built 25 Oct 2026 on `v2/phase2-backend`. Brief: `SPLASH_SUI_V2_PROMPT.md`
§4.3, decisions D1, D3, D6, D7, D8. Code: `lib/funding/wallet-funding.ts` (rules),
`lib/funding/providers.ts`, `lib/funding/swap-routes.ts`, `lib/compliance/kyt.ts`,
`lib/server/funding-conversion.ts`, `lib/server/wallet-funding.ts` (service),
`lib/server/wallet-funding-store.ts` (Postgres, migrations 0038 and 0039),
`app/api/wallet/funding/*`, `app/api/webhooks/funding/[provider]`. Tests:
`tests/wallet-funding.test.mjs`, and the independent review's regressions in
`tests/wallet-funding-review.test.mjs` (SECURITY.md, "Independent review of
§4.3").

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
  the least the accepted quote said would arrive, **required** for a partner, a
  swap route, a USDT or USDsui conversion and USDT over CCTP
  (`accepted_quote_required`): the server never prices a top-up at a quote
  nobody was shown. A fresh quote below it is refused (`quote_changed`, with
  the new quote) and nothing is made. Slippage and the accepted floor are part
  of the idempotent request. Transfer's step 3 sends
  `purpose: 'transfer_top_up'` and `transferRef`, and reads `status` and
  `progress` (`expectedMinMinor`, `clearedMinor`, `heldMinor`): it goes on
  only at `arrived`.
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
  Kept as an HMAC-SHA256 fingerprint of country + bank code + number under a
  server key (`FUNDING_SOURCE_FINGERPRINT_KEY`, at least 32 random
  characters; `FUNDING_SOURCE_FINGERPRINT_KEY_PREVIOUS` still matched after a
  rotation) and the last four digits; the number itself is never stored, and
  without the key a fingerprint cannot be brute-forced back to it. No key, no
  bank account (`fingerprint_key_missing`). Pending until its first deposit.
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

**The trail.** Every change to a source (added, verified, revoked, first use
passed or failed) is a row in `funding_source_events`, append-only (a trigger
refuses UPDATE and DELETE): who, what, and the evidence hash for a wallet
proof. A revoked source can be added again: a new pending row that needs its
proof or first use afresh.

**The payer-matching contract with partners.** A partner's `delivered`
webhook reports who paid: for a bank transfer, the paying account itself
(`country`, `bankCode`, `accountNumber`, `holderName`), which Splash keys into
its fingerprint on receipt and does not keep (only the event id and status are
stored); for a card, the partner's own card fingerprint and last four, the
values the business added the card with. Each partner's live adapter maps its
own payload to this when it is wired.

## Deposits: screened, held or cleared

Each `(transaction, wallet, coin type, part)` is recorded once (unique index),
from the chain's balance changes for the business wallet only, in USDC, USDT or
USDsui. Every deposit's origin is screened on arrival (`lib/compliance/kyt.ts`):

- `BLOCK` (a sanctions hit) → **blocked**, for good.
- Held, with reasons, when the source is unknown, not verified, revoked,
  failed its first use, is not the payer the top-up named, or screening gave
  no verdict or asked for review.
- Otherwise **cleared**.

Origin: the Sui sender; for a partner, the payer it reports in its verified
webhook, and only for a transaction sent from the partner's own Sui address
(`FUNDING_PROVIDER_<ID>_SUI_SENDERS`; none configured, none accepted:
`not_partner_delivery`); for a swap, the wallet the business proved and named
for that top-up (a route's solver delivers on Sui, so the Sui sender is not
the business), always held until the route confirms the origin.

**CCTP mints.** Circle's event is recognised by its **type**,
`<MessageTransmitterV2 original id>::receive_message::MessageReceived` (ids in
`docs/mainnet-checks-2026-10.md` §5). The package that emitted it is no
signal: on testnet Circle's own mints are emitted from TokenMessengerMinter's
`handle_receive_message` module, and an upgrade or wrapper changes it again.
Read from testnet on 25 Oct 2026: the struct is `{caller, source_domain,
nonce, sender, finality_threshold_executed, message_body}`, and the
BurnMessageV2 offsets (version, burnToken, mintRecipient, amount,
messageSender, maxFee, feeExecuted) match the recipient and minted amount of
real mints. A mint credits its burner only when the transaction carries
exactly one, its burn names the business wallet, and its body reads, and only
up to what Circle minted (`amount - feeExecuted`). Any other USDC the
transaction moved in is a separate `remainder` deposit, the sender's, screened
as the sender's: a relayer cannot pass its own money off as the burner's. The
relayer of a pure mint is recorded, not screened against the mint: anyone can
relay a business's mint (`destinationCaller` is zero), and holding the
business's money for the relayer's listing would let any listed address
freeze it.

**Nobody has to report a deposit.** The deposit watcher
(`syncWalletDeposits`) reads every transaction that touched the business
wallet, oldest first, from Sui GraphQL (`address.transactions`, relation
`AFFECTED`; `SUI_GRAPHQL_URL` or Mysten's endpoint), each read in full from the
fullnode, and records every arrival exactly as a report would: screened, held
or cleared. Its cursor and the net USDC it has seen move in or out are in
`wallet_deposit_sync`; a page counts only for the watcher that moves the
cursor from where it read it, so concurrent runs count each transaction once.

**Held funds are not spent.** Before Splash builds, sponsors or routes a
payment from the wallet, it reads the wallet's USDC, runs the watcher, and
withholds every held or blocked USDC deposit of the business plus anything the
balance shows beyond the net the watcher has seen (an arrival the indexer has
not listed yet). If the watcher cannot read the chain, nothing is built
(`holds_unreadable`). `requestWalletPayment`, `requestOpenIntentPayment` and
the owners' second approval of a rule payment (`openSecondApproval`) refuse
(`funds_on_hold`) when the rest does not cover principal plus the fee bound.
Holds count by **business**, not address: after a rotation the held USDC that
moved to the new wallet stays held, and the rotation transfer (sent by an
earlier wallet of the business) is not a deposit (`own_wallet_transfer`).
Splash has no key to the wallet and cannot freeze it. A staff member's own
allowance spend, signed on their device, is bounded by their spending rule,
not by holds (see Open).

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

Screening: Elliptic, the contracted provider (D8), decides when configured
(today it answers no verdict, so deposits are held); with Chainalysis's free
sanctions list also configured, a listing still blocks, and its CLEAR ("not
listed") is never taken for a verdict. Chainalysis alone is the fallback until
Elliptic is contracted. Production with neither answers no verdict;
development uses a labelled sandbox.

## Partner webhooks

`POST /api/webhooks/funding/:provider`: the raw body's HMAC-SHA256 signature
(`x-splash-funding-signature: t=…,v1=…` over `t.body`) is checked first, inside
a 5-minute window. The sandbox accepts one only with
`FUNDING_SANDBOX_WEBHOOKS_ENABLED=true` and a random
`FUNDING_SANDBOX_WEBHOOK_SECRET` of at least 32 characters; there is no
fallback secret, and the sandbox's order reference is an HMAC of the intent id
under a per-process key, so it cannot be worked out from the id. The event
must name its intent and the partner's own order reference for it, or it is
acknowledged and ignored. Each event id counts once
(`funding_provider_events`). Statuses never go backwards: `arriving` (money
came, cleared USDC does not cover the quote's floor yet) and `arrived`
(cleared USDC covers it) are proven on chain and reachable from any earlier
status; `arriving` only moves on to `arrived`, and nothing leaves `arrived`. A
delivery is recorded only from the chain by the digest the partner names, and
only when that transaction came from the partner's own address; a row
recorded earlier (by the watcher or a report) is re-read with the partner's
payer only while held, only if first read as a plain transfer or this
partner's delivery, and only when it covers the order. If the chain has not
seen it yet the webhook answers 503 and the retry counts.

## Open

- Live partner and route APIs (Halliday, Stripe, TransFi, Bridge, Li.Fi,
  deBridge) and Elliptic: each needs its contract and docs.
- The conversion signing request (a DeepBook swap command in
  `wallet-tx-describe.ts`, reviewed like every other command).
- EVM wallet proofs.
- Each partner's Sui delivery addresses and payer payload, from its contract.
- The watcher runs when a payment is about to be built (and so on every
  spend path); a scheduled run, so the dashboard shows unreported deposits
  before anyone pays, is not wired yet.
- The mainnet MessageTransmitterV2 id is from Circle's page; the testnet one
  was checked against real mints.
- Holds do not bind a staff member's own allowance spend.
