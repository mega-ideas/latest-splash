# Payout partners behind one interface — v2 Phase 2 §4.5

Status: built 25 Oct 2026 on `v2/phase2-backend` (migrations 0042 to 0044). Brief:
`SPLASH_SUI_V2_PROMPT.md` §4.5. Decisions: D3, D4, D5(c), D12, D13, and
Sky's decisions of 24 Oct 2026 on partner deposit addresses.

Code:
- `lib/payouts/partner.ts`: the interface (`lib/server/pdax.ts` exports it
  as `PayoutPartnerAdapter`).
- `lib/payouts/bank-adapter.ts`: the sandbox and live halves every bank
  route shares, and the instruction check.
- `lib/payouts/pdax.ts`, `lib/payouts/durianpay.ts`, `lib/payouts/hata-fiuu.ts`,
  `lib/payouts/cctp-wallet.ts`: the four routes.
- `lib/payouts/registry.ts`: which adapter a server runs.
- `lib/payments/iso20022.ts`: the ISO 20022 mapping.
- `lib/server/partner-payouts.ts`: supplier payouts (PH, ID).
- `lib/server/withdrawals.ts`: the shared bank-payout core
  (`openBankPayout`), deposit addresses, settlement, webhooks and the sweep.
- `app/api/wallet/payouts/*`; `app/api/wallet/withdrawals/deposit-address`
  takes `partner`; `app/api/webhooks/payouts/[partner]` and
  `/api/cron/withdrawals` serve both kinds.

Tests: `tests/payout-partners.test.mjs` (the adapters and the mapping, no
database) and `tests/partner-payouts.test.mjs` (the service on PGlite).

## The interface

| Verb | Bank routes (pdax, durianpay, hata_fiuu) | cctp_wallet |
|---|---|---|
| `quote` | Rate (local per USDC ×1e6), what the account receives after the partner's fees, each fee its own line, 5-minute expiry. | Circle's fee from Sui (a standard transfer) as its own line, and what arrives. |
| `createPayout` | The instruction, before any deposit, keyed by the intent id and the expected USDC amount, with its ISO 20022 message. Idempotent: a retry names the same order; the intent id with another amount, deposit address, account, rate, quote reference or ISO 20022 message is refused (`instruction_conflict`, 409), and no reversal is sent for it (it would cancel the payout already held). | Checks chain, domain and the mint recipient (re-derived from the address), keyed by the intent id. Circle takes no instruction before a burn. |
| `status` | The partner's view of the payout, asked by the sweep (below): a paid-out answer may carry the bank's reference and a failed one the partner's reason, checked as a webhook's are. The sandbox answers only for an order it took, under its own reference (`payout_not_found` otherwise). | The attestation and mint, polled. |
| `handleWebhook` | HMAC over the raw body, 5-minute window, then parse. | Circle sends none: live refuses every webhook. |
| `returnOrReverse` | Cancel an instruction no deposit followed, or ask for a return to the business wallet. Only for the partner's own order under its reference, or by the intent id alone when the answer to the instruction was lost (`partnerRef` ''), and only back to the return address the instruction named. The sandbox answers so: `payout_not_found` for an order it never took, `bad_instruction` for another return address, and a reversed instruction is not taken again (`instruction_conflict`). A reversal by the intent id alone for an order the partner does not hold is accepted and kept against the intent id with the return address asked for, so an instruction that arrives after it is refused (`instruction_conflict`) and never goes live. Live partners must contract to the same; an adapter never maps a partner's "not found" to accepted. | Accepted only before the burn; a burn cannot be undone. The same order and address checks. |
| `depositAddress`, `checkAccount`, `postSettlement` | The fixed deposit address, the bank's name enquiry, the Sui digest after settlement. | No deposit address and no bank account (`not_on_this_route`); the burn's digest. |

Every adapter is a labelled sandbox (`sandbox: true`) outside production.
In production, only `isProductionRuntime` decides, so `USE_MOCK_APIS` never
brings the sandbox back. Each live adapter refuses:

| Route | Credentials | Without them | With them |
|---|---|---|---|
| `pdax` | `PDAX_API_KEY`, `PDAX_API_SECRET`, `PDAX_WEBHOOK_SECRET` | `partner_not_configured` | `partner_not_connected` |
| `durianpay` | `DURIANPAY_API_KEY`, `DURIANPAY_WEBHOOK_SECRET`, `DURIANPAY_EXCHANGE_API_KEY` | `partner_not_configured` | `partner_not_connected` |
| `hata_fiuu` | `HATA_API_KEY`, `HATA_WEBHOOK_SECRET`, `FIUU_MERCHANT_ID`, `FIUU_VERIFY_KEY` | `partner_not_configured` | `partner_not_connected` |
| `cctp_wallet` | `CCTP_IRIS_API_URL`, `CCTP_BRIDGE_ADAPTER_TYPE` | `partner_not_configured` | `partner_not_connected` (no bridge adapter is registered on chain) |

No quote, name check, deposit address, payout reference or screening result
is made up. The sandbox numbers are fixed and labelled; they are not a
partner's. Each route can be switched off (`PAYOUT_PARTNER_*_ENABLED`).

Fees: the partner's lines are its own, from its quote, never marked up, and
never Splash's. The Indonesia route has two: the exchange partner's
conversion fee (quoted by DurianPay, labelled as the exchange partner's
until the agreement names the exchange) and the disbursement fee. Circle's
fee is Circle's own line on the cross-chain route. Splash's fee is the
chain's, from the derived kind (bank payout, kind 4), bounded by the
`max_fee` the UI showed (A1). There is no penalty or late fee.

`lib/server/pdax.ts` used to pick its mock whenever `PDAX_API_KEY` was
unset, in production too, and that mock returned a `DEMO_PDAX_…` payout
reference. It now serves the interface. The v1 sweep (custody path only)
refuses in production and names a `sandbox_pdax_…` reference outside it.

## The money path

Supplier payouts (PH, ID) use the withdrawal rails (§4.4), so the rules are
the same:

1. **The deposit address.** One fixed address per business per partner
   (`POST /api/wallet/withdrawals/deposit-address {action, partner}`),
   never a Splash address, the wallet itself or another business's, and
   verified once by a 1 USDC test deposit the partner confirms and the chain
   shows. A spending rule binds a beneficiary only to a verified address.
2. **The supplier's account** (`POST /api/wallet/payouts/beneficiaries`,
   owners only). Stored only when the bank's own holder name, from the
   partner's name enquiry, is the name given, and with a structured address.
   The business's own name is refused (that is a withdrawal). The account
   number, the beneficiary salt and the supplier's ISO 20022 party are
   sealed (AES-256-GCM under `WITHDRAWAL_ACCOUNT_KEY`), bound to the org and
   row. A supplier is never withdrawn to, and an own account is never paid
   as a supplier.
3. **The quote** (`POST /api/wallet/payouts/quotes`), only once the wallet
   holds the principal plus Splash's fee outside every hold.
4. **The payout** (`POST /api/wallet/payouts`, `Idempotency-Key`). An owner,
   or a staff member asking the owners (Sky's decision); only the owners'
   quorum signs. It declares a purpose code and the source of funds, and
   needs the payer's KYB profile complete (`originator_incomplete`). Then,
   as for a withdrawal:
   - the fee above the one shown, or a worse rate than accepted, is refused;
   - the sealed account is opened and its commitment matched with the
     intent's `beneficiary_ref`;
   - the ISO 20022 message is built from exactly that account;
   - **the instruction goes to the partner first**, keyed by the intent id
     and the expected amount; a lost answer cancels the payout and reverses
     the instruction by the intent id, asked again by the sweep until the
     partner takes it (every run until ops are alerted, then backing off up
     to six hours, never giving up). The partner keeps a reversal for an
     intent id it does not hold yet, so the late instruction is refused;
   - the owners are asked to sign the canonical composed PTB under purpose
     `partner_payout`: withdraw principal plus `max_fee`, open the intent
     (kind 4, to the deposit address, for that commitment and amount),
     confirm from the business wallet, anchor, delete. The signers are
     shown the supplier, bank, last four digits, amounts, rate, purpose and
     deadline, and the server checks them before every signature.
5. **After settlement** the executed transaction is read, and the digest is
   posted only when its `IntentCreated` event names the instructed intent
   id. The sweep retries what did not post.
   Once the digest is posted, the sweep also asks the partner for the
   payout's status (`status`, keyed by the row's own intent id and partner
   reference) on every run until it is final, so a lost webhook does not
   leave a payout sent forever. The answer moves it forward only, by the
   webhook's rules (funds received, paid out, failed; a failure asks for the
   USDC back to the business wallet). A polled `returned` is not believed:
   a return counts only from the digest a webhook names and the chain shows.
   A failed payout is not polled (it waits for its return). A paid-out
   answer keeps the bank's reference and a failed one the partner's reason
   (an id of 6 to 128 characters, a reason cut to 200). A route that cannot
   answer, or is switched off, is counted as `pollErrors` and asked again
   next run; it does not make the cron answer 502 on its own (only a row
   that could not be settled does).
   **A failed payout's return is asked for until the partner accepts.**
   Every ask (from the failure webhook, the poll, a short return, or the
   sweep) is counted on the row (`return_asks`, `return_asked_at`), and the
   time the partner accepted is kept (`return_accepted_at`, 0044). While it
   is null the sweep asks again on every run (`returnsAsked`,
   `returnsPending` in its answer); after five asks without an acceptance
   ops are alerted once (an ALERT log line with ids only, and a
   `return_request_stuck` event).
6. **Webhooks** (`/api/webhooks/payouts/pdax`, `/durianpay`): signed, in the
   window, each event once, never backwards, for that partner's own payout
   only. A signed event of a type or status Splash does not know is
   acknowledged (200, ignored) and changes nothing, and it is kept for ops
   in `payout_partner_unknown_events` (0044): the partner, the event id, the
   type and status cut to 64 safe characters, and how often it came; nothing
   else from the body. Its first delivery logs an ALERT line. A later
   paid-out webhook may add the bank's reference to a payout the poll found
   paid out without one (once; a kept reference is never replaced). A broken
   body is 400. A failure asks for the USDC back to the business wallet; a return
   counts only as the chain shows it.

`anchor_audit_hash` is not in this PTB: the `AnchorCap` is the operator's,
so it is the operator's own transaction, as before.

**This is the only way money reaches a partner** (p2-4.5 review). A bank
payout (kind 4), or a payment of any kind to one of the business's partner
deposit addresses (verified or still waiting for its test deposit), is
refused everywhere else with `use_payout_route` (409):
`requestWalletPayment` without its withdrawal block, `requestOpenIntentPayment`,
a staff member's draft or open-intent ask (`askOwnersToApprove`), an owner
accepting an ask stored before the check, and the `wallet_payment` shape
check (an `open_intent` or existing intent of kind 4). A staff member asks
for a supplier payout through `POST /api/wallet/payouts`, which instructs the
partner before anything is signed.

**Binding a beneficiary in the spending rules** (`addBeneficiaries`): the
commitment must be the `beneficiaryRef` of one of this business's verified
bank accounts (`beneficiary_not_a_destination` otherwise), and the deposit
address the verified one of that account's own partner
(`beneficiary_partner_mismatch`). The business multisig adds it to the
SpendPolicy through `POST /api/wallet/spending-rules/recipients`.

**Before the first supplier payout** an owner saves the business's
structured registered address with its profile (`POST /api/onboarding/profile`
`address: { streetName, buildingName, postCode, townName, countrySubDivision }`,
the country is `addressCountry`). Without it every supplier payout answers
`originator_incomplete`. The setup form's address fields are Phase 3 UI.

## ISO 20022

`lib/payments/iso20022.ts` is the one mapping from the recipient form to
pacs.008-style fields (a JSON object with the message's element names):

| Form | pacs.008 |
|---|---|
| account holder name | `Cdtr/Nm`, `CdtrAcct/Nm` (must be the account's holder) |
| structured address | `Cdtr/PstlAdr` (street, building, post code, town, district, subdivision, country). No `AdrLine`: CBPR+ stops taking unstructured addresses in November 2026. Town and country required. |
| registration number | `Cdtr/Id/OrgId/Othr` (scheme `CINC` or `TXID`, issuer) |
| bank code, account | `CdtrAgt/FinInstnId` (`BICFI` for a BIC, else `ClrSysMmbId`), `CdtrAcct/Id/Othr/Id` |
| purpose code | `Purp/Cd` (ExternalPurpose1Code: SUPP, GDDS, SCVE, TRAD, COMC, RENT, LICF, INTC, CASH) |
| relationship | `RgltryRptg/Dtls` type `RELATIONSHIP` |
| source of funds | `RgltryRptg/Dtls` type `SOURCE_OF_FUNDS` |
| invoice reference | `RmtInf/Ustrd` |

From the payment: `PmtId/EndToEndId` (`SPL` and 32 hex digits of the intent
id) and `UETR` (derived from the intent id, the same on every retry),
`InstdAmt` (the USDC principal as USD), `IntrBkSttlmAmt` (what the account
receives; IDR in whole rupiah), `XchgRate`, `ChrgBr` SHAR with the
partner's lines in `ChrgsInf`, `Dbtr` from the payer's KYB profile,
`DbtrAcct` (the Sui wallet), and the intent id, asset, deposit address and
beneficiary commitment in `SplmtryData`.

Characters: the CBPR+ Latin set plus the extended-set characters business
names and addresses use, `& # @ ! % * = _ ;` (an adapter that writes XML
escapes `&` with `escapeXmlText`). A supplier's holder name is the one its
bank checks, so an accented letter or another script is refused when the
supplier is added, before any name enquiry. The business's own text (the
debtor, and a withdrawal's creditor) is transliterated instead (Cafe for
Café; an unreadable optional part left out), never a refusal, and
`SplmtryData.transliterated` plus an `iso20022_transliterated` trail event
name the fields changed.

Each adapter checks the message against the instruction before sending:
intent, amount, settlement amount, rate, the owners' minimum, charges,
account, holder, bank, deposit address, wallet, commitment, debtor name and
registration, relationship and purpose.

A withdrawal (§4.4) carries a message too: purpose `INTC`, relationship
`self`, the creditor is the business itself.

The evidence export (§4.6) takes `pacs008Evidence`: the same message,
masked to the last four characters of the account and of both registration
numbers, and the address's town and country. Every bank payout, a supplier
payout or a withdrawal, stores it on its row with its purpose code
(`withdrawals.iso20022`, `withdrawals.purpose_code`). The database requires
both on every row (`withdrawals_iso20022_check`, 0044) except a withdrawal
written before the copy was kept, which 0044 marks `iso20022_legacy`; the
view carries `iso20022Legacy`, so the export can say "no ISO 20022 copy
(written before 25 Oct 2026)" instead of showing an empty message. Payouts and suppliers are read by owners
and staff only, not viewers (`requirePayoutReader`).

Sandbox webhooks: each route verifies with its own secret,
HMAC-SHA256(`PAYOUT_SANDBOX_WEBHOOK_SECRET`, `splash:payout-sandbox-webhook:v1:<partner>`)
(`sandboxWebhookSecretFor`), so a body signed for one route does not verify
at another, as with the live secrets.

## cctp_wallet

USDC only, CCTP V2 only. A standard transfer from Sui (Circle lists 0 bps;
fast transfer from Sui is not offered). The mint recipient is re-derived from
the address for the chain (EVM left-padded; Solana the USDC token account;
Aptos the account address); Stellar and Starknet are not planned. The live
path waits on two things outside this section: Circle's fee API (Circle says
not to hard-code the fee) and a registered bridge adapter in `splash_core`.
Until then the PTB builder refuses kind 3 (`cross_chain_not_built`) and the
live adapter refuses.

## Open

- The live PDAX, DurianPay (and its exchange partner), Hata and Fiuu APIs,
  their webhook payloads and deposit networks, from the signed contracts;
  whether each accepts a least receive amount over the 24-hour signing
  window.
- Name screening of a supplier against sanctions lists (§4.6). The bank's
  name enquiry is not screening.
- The bridge adapter and Circle's fee API for `cctp_wallet`.
- The payout UI (Phase 3).
