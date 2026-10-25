# Withdrawals to the business's own bank — v2 Phase 2 §4.4

Status: built 25 Oct 2026 on `v2/phase2-backend`. Brief: `SPLASH_SUI_V2_PROMPT.md`
§4.4 and §4.5. Decisions: D3, D4, D12, and Sky's decisions of 24 Oct 2026
on partner deposit addresses.

Code:
- `lib/payouts/partner.ts`: the payout-partner interface.
- `lib/payouts/hata-fiuu.ts`: the first adapter.
- `lib/payouts/registry.ts`: which adapter a server uses.
- `lib/payouts/withdrawal-rules.ts`: the rules, with no I/O.
- `lib/server/withdrawals.ts`: the service.
- `lib/server/withdrawals-store.ts`: the store (migration 0040).
- `lib/server/withdrawals-deps.ts`: the live wiring.
- `app/api/wallet/withdrawals/*` and `app/api/webhooks/payouts/[partner]`.

Tests: `tests/withdrawals.test.mjs`, and one case in
`tests/spend-rules.test.mjs`.

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

One interface for every payout route. pdax, durianpay and cctp_wallet move
onto it in §4.5; until then they answer `partner_not_built`.

| Method | What it does |
|---|---|
| `depositAddress` | The business's fixed Sui deposit address at the partner, and the partner's account ref. |
| `checkAccount` | Name enquiry: the holder name the bank itself has for an account. |
| `quote` | Rate (local per USDC ×1e6), the receive amount after the partner's fees, each fee as its own line, quote ref, 5-minute expiry. |
| `createPayout` | The instruction, before any deposit. The idempotency key is the intent id. |
| `postSettlement` | The Sui digest, after settlement. |
| `status` | The partner's view of a payout. |
| `verifyWebhook` | HMAC over the raw body, 5-minute window, then parse. |
| `returnOrReverse` | Cancel an instruction no deposit followed, or ask for a return to the business wallet. |

Outside production every adapter is a labelled sandbox (`sandbox: true`).
In production, without credentials, the adapter refuses with
`partner_not_configured`. The hata_fiuu credentials are `HATA_API_KEY`,
`HATA_WEBHOOK_SECRET`, `FIUU_MERCHANT_ID` and `FIUU_VERIFY_KEY`. With
credentials it refuses with `partner_not_connected` until the APIs are
wired. Only `isProductionRuntime` decides which adapter runs, so
`USE_MOCK_APIS` never brings the sandbox into production.

## Setting up

1. **The business's own bank account** (`POST /destinations`, owners only).
   The account is stored only when both checks pass:
   - the holder name given matches the business's registered legal name;
   - the bank's own holder name, from the partner's name enquiry, matches it
     too.

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
   - an address Splash controls (operator, sponsor, treasury);
   - the wallet itself;
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

- `POST /quotes {destinationId, amountMinor}` (owners only). The quote is
  given only once the wallet holds the principal plus Splash's fee outside
  every hold (`insufficient_funds`, `funds_on_hold`). It shows the
  partner's rate and receive amount, each partner fee as its own line, and
  Splash's kind 4 fee from the live `FeeConfig` (`fee_unavailable` if it
  cannot be read). `maxFeeMinor` is exactly the fee shown. Refused when
  local-currency payouts are outside the launch scope.
- `POST / {destinationId, amountMinor, acceptedReceiveMinor, maxFeeMinor,
  contentHash, walrusBlobId}` with `Idempotency-Key` (owners only). It is
  refused when:
  - the fresh quote is worse than the accepted one (`quote_changed`, with
    the new quote);
  - the fee is above the one shown (`fee_above_shown`);
  - the shown fee is over 1% (`bad_fee`).

  Then:
  1. A random payment reference is drawn. The intent id is derived from it
     as `create_for_wallet` will claim it: `derived_object` over
     `PaymentRef(payment_ref)` under splash_core's original package id
     (`SPLASH_CORE_ORIGINAL_PACKAGE_ID`, else `SPLASH_CORE_PACKAGE_ID`).
  2. The sealed account is opened, its commitment recomputed and compared
     with the destination's `beneficiary_ref` (`beneficiary_mismatch`).
  3. **The instruction goes to the partner first** (`createPayout`). It is
     keyed by the intent id and the expected USDC amount, with the
     receive amount, the beneficiary, purpose `INTC` and the business
     wallet as the return address.
  4. The owners are asked to sign the composed PTB under purpose
     `withdrawal`. That purpose accepts only a kind 4 payout to the
     verified deposit address, carrying that `beneficiary_ref`, for that
     amount, with `max_fee` the fee shown and `settle_by` the quote's
     expiry. When the request cannot be opened (for example the dry run
     fails), the instruction is reversed and the withdrawal cancelled.
- When it executes, the withdrawal is `sent` and the digest is posted to the
  partner. This runs on the signing layer's executed hook, and again on any
  read until posted.
- When the signing request expires, is cancelled or fails, the withdrawal is
  `cancelled` and its instruction reversed.

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
  - A return counts only when the chain shows USDC back in the business
    wallet.
- `test_deposit.received`: as above, in step 3 of setting up.

## The trail

`withdrawal_events` is append-only (a trigger refuses UPDATE and DELETE). It
records every destination, deposit-address and withdrawal change: who
(a user, `system` or `partner:<id>`), what, and references only.

## Open

- The live Hata and Fiuu APIs, their webhook payloads and their deposit
  networks, from their contracts.
- A scheduled run that posts unposted digests. Today the post happens on the
  executed hook and on every read.
- Rotation of `WITHDRAWAL_ACCOUNT_KEY`. Today there is one key, and its loss
  makes stored accounts unusable, so they are added again.
- §4.5 moves pdax, durianpay and cctp_wallet onto the interface.
- Every withdrawal is owner-signed. Staff asking owners to withdraw is not
  wired.
