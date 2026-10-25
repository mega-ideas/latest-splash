# Withdrawals to the business's own bank — v2 Phase 2 §4.4

Status: built 25 Oct 2026 on `v2/phase2-backend`; revised the same day
after review (migration 0041). Brief: `SPLASH_SUI_V2_PROMPT.md`
§4.4 and §4.5. Decisions: D3, D4, D12, and Sky's decisions of 24 Oct 2026
on partner deposit addresses.

Code:
- `lib/payouts/partner.ts`: the payout-partner interface.
- `lib/payouts/hata-fiuu.ts`: the first adapter.
- `lib/payouts/registry.ts`: which adapter a server uses.
- `lib/payouts/withdrawal-rules.ts`: the rules, with no I/O.
- `lib/server/withdrawals.ts`: the service.
- `lib/server/withdrawals-store.ts`: the store (migrations 0040 and 0041).
- `lib/server/withdrawals-deps.ts`: the live wiring.
- `app/api/wallet/withdrawals/*`, `app/api/webhooks/payouts/[partner]` and
  the sweep, `app/api/cron/withdrawals`.

Tests: `tests/withdrawals.test.mjs`, one case in
`tests/spend-rules.test.mjs`, and two Move tests in
`move/splash_core/tests/intent_v2_tests.move` that pin the intent id
derivation.

## The route

MYR: **business wallet → Hata (exchange partner) → Fiuu (bank-transfer
partner) → the business's own bank account.**

The USDC goes from the business wallet straight to the business's own
deposit address at Hata. Hata converts it, and Fiuu pays the MYR into the
business's account. Splash never receives the MYR, and no Splash address
is on the path (D3).

Copy names the partners only when they are in `SIGNED_PARTNERS`. Otherwise
the route reads "our Malaysia exchange partner, then our Malaysia
bank-transfer partner".

## The payout-partner interface (§4.5)

One interface for every payout route; pdax, durianpay and cctp_wallet joined
it in §4.5 (`docs/v2/phase2-payout-partners.md`), and supplier payouts share
these rails.

| Method | What it does |
|---|---|
| `depositAddress` | The business's fixed Sui deposit address at the partner, and the partner's account ref. |
| `checkAccount` | Name enquiry: the holder name the bank itself has for an account. |
| `quote` | Rate (local per USDC ×1e6), the receive amount after the partner's fees, each fee as its own line, quote ref, 5-minute expiry. |
| `createPayout` | The instruction, before any deposit. The idempotency key is the intent id. It carries the least receive amount, the deadline and the beneficiary salt. |
| `postSettlement` | The Sui digest, after settlement. |
| `status` | The partner's view of a payout. |
| `handleWebhook` | HMAC over the raw body, 5-minute window, then parse. |
| `returnOrReverse` | Cancel an instruction no deposit followed, or ask for a return to the business wallet. |

Outside production every adapter is a labelled sandbox (`sandbox: true`).
In production, without credentials, the adapter refuses with
`partner_not_configured`. The hata_fiuu credentials are `HATA_API_KEY`,
`HATA_WEBHOOK_SECRET`, `FIUU_MERCHANT_ID` and `FIUU_VERIFY_KEY`. With
credentials it refuses with `partner_not_connected` until the APIs are
wired. Only `isProductionRuntime` decides which adapter runs, so
`USE_MOCK_APIS` never brings the sandbox into production. The sandbox also
refuses (`partner_not_configured`) on a server pointed at mainnet
(`SUI_NETWORK`, `NEXT_PUBLIC_SUI_NETWORK`, or an RPC or GraphQL URL naming
mainnet): its deposit address is a hash nobody holds a key to, so a real
test deposit to it would be lost.

## Setting up

1. **The business's own bank account** (`POST /destinations`, owners only).
   The account is stored only when both checks pass:
   - the holder name given matches the business's registered legal name;
   - the bank's own holder name, from the partner's name enquiry, matches it
     too.

   The registered legal name counts only once KYB has verified it
   (`kyb_status` basic or full); before that no account can be added
   (`no_company_name`). Only an owner may save the business profile
   (`owner_only`), and once KYB is under way (anything but `REGISTERED` or
   `REJECTED`) the legal name is fixed (`legal_name_locked`; support corrects
   it). A change of name before that revokes every bank account and cancels
   any withdrawal to them not yet sent. A bank account whose holder no longer
   matches the current name is revoked when it is next used
   (`destination_name_changed`).

   Names are folded as for funding sources, so `Sdn. Bhd.` equals
   `Sendirian Berhad`. The trading name is not accepted. When a check
   fails, nothing about the account is kept; the attempt is recorded with
   the last four digits.

   The account number and a per-destination salt are sealed: AES-256-GCM
   under `WITHDRAWAL_ACCOUNT_KEY`, with the org and row as associated
   data. The fingerprint is the funding sources' keyed HMAC. The
   destination's `beneficiary_ref` is the stable `splash:beneficiary:v1`
   commitment over (partner, country, bank code, number, holder name).
2. **The deposit address** (`POST /deposit-address {action: 'request'}`).
   The partner gives one fixed address per business. Splash refuses it when
   it is:
   - an address Splash controls: the operator, the sponsor, the treasury,
     the test recipient, and `FeeConfig`'s fee recipient and pending
     recipient, read live (`splash_address`; `splash_addresses_unreadable`
     when they cannot be read);
   - the wallet itself;
   - another business's wallet as Splash knows it (the deposit watcher's
     wallets and the wallets withdrawals came from; `business_wallet`);
   - an address another business already holds (`address_conflict`).
3. **The test deposit** (`{action: 'test_deposit'}`). The owners sign a
   1 USDC plain transfer to that address. It is sponsored; the gasless lane
   moves only whole balances. The signing purpose is
   `partner_test_deposit`, bound to that recipient and amount. When it
   executes the address is `test_sent`. The partner then confirms with a
   signed `test_deposit.received` webhook naming the digest. The address is
   verified only when that is the digest Splash sent and the chain shows
   exactly 1 USDC to the address from the wallet. When the signing request
   lapses, the owners may ask again.
4. **Spending rules.** A beneficiary is bound (`verify_beneficiary`) only
   to a verified deposit address of this business
   (`partner_address_unverified` otherwise).

## Withdrawing

- `POST /quotes {destinationId, amountMinor}` (an owner, or a staff member
  about to ask the owners). The quote is
  given only once the wallet holds the principal plus Splash's fee outside
  every hold (`insufficient_funds`, `funds_on_hold`). It shows the
  partner's rate and receive amount, each partner fee as its own line, and
  Splash's kind 4 fee from the live `FeeConfig` (`fee_unavailable` if it
  cannot be read). `maxFeeMinor` is exactly the fee shown. Refused when
  local-currency payouts are outside the launch scope.
- `POST / {destinationId, amountMinor, acceptedReceiveMinor, maxFeeMinor,
  contentHash, walrusBlobId}` with `Idempotency-Key`. An owner or a staff
  member (maker or approver) may ask; a viewer may not (Sky's decision:
  staff may ask owners to approve). Asking opens the owners' signing request;
  only their quorum signs. `acceptedReceiveMinor` is the least the owners
  accept; it may be below the quote. It is refused when:
  - the fresh quote is worse than the accepted one (`quote_changed`, with
    the new quote);
  - the fee is above the one shown (`fee_above_shown`);
  - the shown fee is over 1% (`bad_fee`).

  Then:
  1. A random payment reference is drawn. The intent id is derived from it
     as `create_for_wallet` will claim it: `derived_object` over
     `PaymentRef(payment_ref)` under splash_core's original package id
     (`SPLASH_CORE_ORIGINAL_PACKAGE_ID`). Production requires it to be set
     explicitly and refuses withdrawals without it (`no_core_package`).
     Outside production `SPLASH_CORE_PACKAGE_ID` stands in. The derivation
     is pinned by two Move tests: the id `create_for_wallet` gives equals
     `derived_object::derive_address` of the account and reference, and a
     fixed pair gives the value `withdrawalIntentId` gives.
  2. The sealed account is opened (with the current key or a previous one),
     its commitment recomputed and compared with the destination's
     `beneficiary_ref` (`beneficiary_mismatch`).
  3. **The instruction goes to the partner first** (`createPayout`). It is
     keyed by the intent id and the expected USDC amount, with the quoted
     and least receive amounts, the deadline, the beneficiary, the
     beneficiary salt (so the partner can recompute `beneficiary_ref` from
     the account it pays), purpose `INTC` and the business wallet as the
     return address. If the partner's answer is lost (anything but a clear
     refusal), the instruction is reversed (`instruction_unconfirmed`) and
     the withdrawal cancelled.
  4. The owners are asked to sign the composed PTB under purpose
     `withdrawal`. That purpose accepts only a kind 4 payout to the
     verified deposit address, carrying that `beneficiary_ref`, for that
     amount, with `max_fee` the fee shown and `settle_by` the signing
     deadline. The request carries what the signers are shown: bank code,
     last four digits, holder, quoted and least receive amounts, rate and
     deadline. When the request cannot be opened (for example the dry run
     fails), the instruction is reversed and the withdrawal cancelled.
- Before each signature the server checks the withdrawal is still waiting,
  its bank account and deposit address are still verified, and they are the
  ones the bytes commit to (`withdrawal_changed` otherwise). Removing a bank
  account cancels its withdrawals not yet sent: their requests close, and
  their instructions are reversed.
- When it executes, the withdrawal is `sent`. The executed transaction is
  read, and the digest is posted to the partner only when its
  `IntentCreated` event (under the original package id) names the
  withdrawal's intent id. A mismatch is held (`settlement_hold =
  intent_id_mismatch`), logged as an alert and never posted: ops must look.
- Reads never call the partner. The sweep, `/api/cron/withdrawals` (every
  five minutes, `CRON_SECRET`), posts digests not posted yet, reverses the
  instruction and cancels the withdrawal when its signing request expired,
  was cancelled or failed, and records or frees a test deposit whose request
  closed.

### The rate and the signing window

The partner's quote holds five minutes; a multisig quorum, or owners in
other time zones, cannot be held to that. So `settle_by` is the signing
deadline, 24 hours (`WITHDRAWAL_SIGNING_WINDOW_MS`, the intent's lifetime),
not the quote's expiry. The quote is a display figure. The owners accept a
least receive amount (`acceptedReceiveMinor`); the partner is told it
(`minReceiveMinor`) and the deadline. When the deposit lands, the partner
converts at its rate then and pays at least that amount, or does not pay
out and returns the USDC to the business wallet. Whether Hata and Fiuu
accept this (or hold a rate for the window instead) is a question for their
contracts.

Statuses:
- preparing → awaiting_signatures → sent → partner_received → paid_out;
- sent or partner_received → failed → returned;
- preparing or awaiting_signatures → cancelled.

Nothing moves backwards. Paid out, returned and cancelled are final.

## Partner webhooks

`POST /api/webhooks/payouts/:partner`, header `x-splash-payout-signature:
t=…,v1=…`, which is HMAC-SHA256 over `t.body`. The signature is checked
first, inside a 5-minute window. The sandbox accepts a webhook only with
`PAYOUT_SANDBOX_WEBHOOKS_ENABLED=true` and a random
`PAYOUT_SANDBOX_WEBHOOK_SECRET` of at least 32 characters.

- `payout.status`: `funds_received`, `paid_out` (with Fiuu's `bankRef`),
  `failed` or `returned` (with `returnDigest`).
  - An event must name both the intent id and the partner's reference, or
    it is ignored.
  - Each event id counts once (`payout_partner_events`), and a status that
    would go backwards is ignored.
  - An event before the deposit is recorded answers 503, and the retry
    counts.
  - A failure asks the partner to return the USDC to the business wallet.
  - A return counts only when the chain shows the transaction sent by the
    deposit address, it is not the withdrawal's own digest, and it puts
    USDC back into the business wallet. A return digest closes one
    withdrawal (and a unique index holds it). Only the whole amount closes
    the withdrawal as `returned`, with `returned_minor`. A short return is
    recorded (`returned_minor`, `return_short` in the trail) and the
    withdrawal stays `failed` for ops. A return sent from a partner address
    other than the deposit address is not accepted until the contracts name
    one.
- `test_deposit.received`: as above, in step 3 of setting up.

## The trail

`withdrawal_events` is append-only (a trigger refuses UPDATE and DELETE). It
records every destination, deposit-address and withdrawal change: who
(a user, `system` or `partner:<id>`), what, and references only.

## Key rotation

`WITHDRAWAL_ACCOUNT_KEY` seals; `WITHDRAWAL_ACCOUNT_KEY_PREVIOUS`
(comma-separated) only opens. To rotate: set the new key, move the old one
to `_PREVIOUS`. A bank account opened with an old key is sealed again under
the new one when it is next paid (`resealed` in the trail). Clear
`_PREVIOUS` once nothing opens with it. Losing every key still strands the
stored accounts; the owners then add them again.

## Open

- The live Hata and Fiuu APIs, their webhook payloads and their deposit
  networks, from their contracts; whether they accept a least receive
  amount over a 24-hour window; a partner return address, if returns do not
  come from the deposit address.
- `paid_out` is the partner's signed word (`bankRef` is stored); there is no
  reconciliation against bank evidence yet.
- No testnet dry run has compared a created intent with
  `withdrawals.intent_id`; the Move tests pin the derivation, and the
  executed transaction's event is checked before every post.
- The UI for withdrawals (and its copy, accessibility and 390px layout) is
  not built in this section.
- §4.5 put pdax, durianpay and cctp_wallet on the interface (docs/v2/phase2-payout-partners.md).
