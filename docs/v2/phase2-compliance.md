# Compliance — v2 Phase 2 §4.6

Status: built 25 Oct 2026 on `v2/phase2-backend` (migration 0045). Brief:
`SPLASH_SUI_V2_PROMPT.md` §4.6. Decisions: D3, D5, D8, D12.

Code:
- `lib/compliance/sumsub.ts`: the KYB adapter, the webhook check, the
  Travel Rule adapter.
- `lib/compliance/kyt.ts`: transaction screening (Elliptic, the Chainalysis
  sanctions list, the sandbox), address formats per chain.
- `lib/compliance/sender-declaration.ts`: the sender-declaration pack.
- `lib/compliance/controls-evidence.ts`: the evidence document, its PDF and
  its leak check. `lib/compliance/pdf-text.ts`: the plain-text PDF writer
  both documents use.
- `lib/server/kyt-screenings.ts`, `lib/server/travel-rule-transfers.ts`,
  `lib/server/sumsub-webhook.ts`, `lib/server/controls-evidence.ts`,
  `lib/server/exchange-payment-compliance.ts`, `lib/server/compliance-deps.ts`.
- Routes: `POST /api/kyb/sumsub`, `POST /api/webhooks/sumsub`,
  `POST /api/compliance/screenings`,
  `GET /api/wallet/payments/[ref]/evidence?format=json|pdf`,
  `POST /api/wallet/payments/[ref]/travel-rule`,
  `POST /api/wallet/payments/[ref]/sender-declaration`.

Limits: opening a Sumsub verification is 20 an hour per business
(`kybSessionOrg`), the evidence 600 an hour per person (`controlsEvidenceUser`), the sender
declaration 120 an hour per
person (`complianceReadUser`), the screening route and the Travel Rule
message their existing per-person limits. The webhook has no session; its
signature, date window and one-time claim stand in for one.

Tests: `tests/compliance-routes.test.mjs` (the gates of each route, as
source checks), `tests/compliance-kyt.test.mjs`, `tests/compliance-sumsub.test.mjs`,
`tests/controls-evidence.test.mjs`, `tests/compliance-payment-gates.test.mjs`,
`tests/compliance-provider-answers.test.mjs` (PGlite, no network), and the
source checks in `tests/kyb-lifecycle.test.mjs`.

## The rule every adapter follows

Each provider has a labelled sandbox (`sandbox: true`) outside production.
In production only `isProductionRuntime` decides, so `USE_MOCK_APIS` never
brings a sandbox back, and a provider without its credentials refuses:

| Adapter | Credentials | Production without them |
|---|---|---|
| KYB (Sumsub) | `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY` | `kyb_not_configured` (503) |
| Travel Rule (Sumsub) | the same, and `SUMSUB_TRAVEL_RULE_ENABLED=true` | `travel_rule_not_configured` (503) |
| KYT | `ELLIPTIC_API_KEY` + `ELLIPTIC_API_SECRET`, or `CHAINALYSIS_SANCTIONS_API_KEY` | provider `none`: every verdict is null |

No session, verdict, Travel Rule reference or screening result is made up.

**A provider's answer.** A screening verdict counts only with the
provider's own reference and the time it answered, and the sandbox's never
counts in production (`isProviderAnswer`, lib/compliance/kyt.ts; only the
runtime mode decides). This matters for what is already on file: a sandbox
CLEAR kept by a non-production server writing to the same database does
not open or sign a production payment, send a Travel Rule message, or
clear a held deposit. The address is screened again by the live provider,
or the payment is refused (`recipient_not_screened`, `not_screened`) and
the deposit stays held (`not_screened`). Production keeps no sandbox
verdict, and a sandbox Travel Rule message does not let an exchange payment
be signed in production (`travel_rule_missing`); sending the message
through the provider replaces it (below).

A sandbox BLOCK on file is treated by what it is attached to. On a
recipient it still blocks (403, `recipient_blocked`), and the gate never
screens it away: a person clears it, by screening the address again
through the live provider (`POST /api/compliance/screenings`), whose newer
answer then decides. On a deposit it is not the provider's answer, so the
deposit is held as `not_screened` and screened again by the live provider
on its next check; a live CLEAR can then release it. Either way nothing
moves on the sandbox's word: the money stays held, or the recipient
unpaid, until a provider answers.

**The runtime mode is the only switch.** "Production" here means
`NODE_ENV=production` (lib/server/runtime-mode.ts), read by each server
function from the env it is given, which defaults to the process's. Any
process that reaches the production database (a web server, a worker, a
cron job, a one-off script) must run with `NODE_ENV=production`; one that
does not treats sandbox answers on file as answers. This is a line on the
mainnet checklist (docs/v2/phase2-business-wallet.md, Mainnet), and a
non-production deployment must never be given the production
`DATABASE_URL`.

## KYB and KYC (Sumsub)

- The applicant is the business: `externalUserId = org:<orgId>`. The
  webhook finds the org by that string and by nothing else in the payload.
  Before this section the session route created applicants under the KYB
  case id, so no verdict could ever find its org; it is now `org:<orgId>`.
- `POST /api/kyb/sumsub {kybCaseId}` reads the case by the org from the
  session (`requireSessionAccount`) and sends the case's own business name
  and registration number. Before this section it took the case id, the
  name and the number from the request and attached the applicant to any
  case by id, across businesses.
- Requests are signed: HMAC-SHA256 (hex) over timestamp, method, path with
  query, and body. A 409 on create is a resumed applicant; an answer with
  no access token is a failure.

## The Sumsub webhook

In this order: the HMAC over the raw body in the algorithm Sumsub names
(`HMAC_SHA256_HEX`, `HMAC_SHA512_HEX`, or its SHA-1 default; any other name
is refused, and no secret verifies as false). Production refuses SHA-1,
which is also what a delivery without the algorithm header gets, unless
`SUMSUB_WEBHOOK_ALLOW_SHA1=true` for the switch-over to `HMAC_SHA256_HEX`; then the body; then its date
(`createdAtMs` or `createdAt`) inside a two-day window, since Sumsub retries
for about a day, and no more than five minutes ahead; then the delivery is
claimed once in `webhook_events` by the SHA-256 of the raw body. A replay
inside the window is acknowledged and changes nothing. A failure of ours
releases the claim so Sumsub can deliver again, and the route answers 500.
Production without a database refuses (503).

- **KYB:** only `applicantReviewed` decides. GREEN moves the business to
  KYB_PROVIDER_APPROVED; RED with `reviewRejectType: FINAL` to REJECTED; a
  RED the applicant may retry changes nothing (before, any RED rejected).
  The actor is PROVIDER, which the state machine never lets reach ACTIVE; a
  transition the machine refuses (`KybTransitionError`, and only that) is
  acknowledged (200) and nothing moves back. Any other failure while applying
  it (the database down, a timeout) releases the delivery, so the verdict
  arrives again rather than being lost (before the review, every error was
  acknowledged as a refused transition).
- **Travel Rule:** `applicantKytTxnApproved`, `…Rejected`, `applicantKytOnHold`
  and `applicantKytTxnAwaitingUser` move the transfer Sumsub's own
  reference names, only when the txnId (when given) is that transfer's
  payment and the org (when named) is its business, and forward only:
  submitted, then on hold or awaiting the counterparty, then approved or
  rejected, which are final.

## The Travel Rule (exchange recipients)

A wallet payment to a supplier's deposit address at an exchange (D5a) sends
the paying business and the supplier to Sumsub, which delivers them to the
exchange (VASP to VASP). `POST /api/wallet/payments/[wsr_…]/travel-rule
{exchange, purpose?}`, owners and staff:

- The payment, the payer (the name and registration number of the
  business's KYB case, the business the provider verified; the address and
  country from its profile), the supplier (this business's ONE saved
  recipient at that address, with its Travel Rule half; two saved at one
  address is refused, `recipient_ambiguous`) and the applicant (the KYB
  case) are read on the server. The business's KYB must be approved
  (KYB_PROVIDER_APPROVED, KYB_ADMIN_APPROVED or ACTIVE), or nothing is sent
  (`kyb_not_approved`).
- The exchange is the saved exchange account's own (§4.7,
  `docs/v2/phase2-wallet-recipients.md`): a request naming another is
  refused (`exchange_mismatch`), a wallet the supplier holds is not an
  exchange account (`not_an_exchange_recipient`), and only a recipient saved
  before §4.7 still takes it from the request. A deposit address once named
  at one exchange in a message the provider took keeps that exchange: another
  is refused (`exchange_mismatch`).
- The recipient's newest screening by this business must be CLEAR: REVIEW
  waits for a person, BLOCK is refused (403), none asks for screening first.
- Once per payment: the row is written before Sumsub is asked, keyed by the
  business and the payment reference (the intent id when it exists, else
  the signing request id), which is also Sumsub's txnId. A retry of the same
  message answers the same transfer without asking again; the same payment
  with another amount, address or party is refused (`travel_rule_conflict`).
  The caller that sends first claims the row (`preparing` to `sending`, a
  compare-and-set); a second caller meanwhile is told it is in progress
  (`travel_rule_in_progress`) and Sumsub is asked once. A failed send goes
  back to `preparing`, with no reference, and the retry asks again under the
  same txnId. A send Sumsub answers 409 (it may hold that txnId from a send
  whose answer was lost), or a claim older than ten minutes with no answer,
  is held as `unconfirmed`: never sent again and never taken for sent, until
  Sumsub's webhook for that txnId and this business (`externalUserId`)
  names its transfer. An answer without Sumsub's transfer id, or naming
  another txnId, is not a submission.
- A sandbox message on file for the payment (written by a non-production
  server using the same database) never reached an exchange. Sending
  through the live provider replaces it in one compare-and-set on that
  sandbox row: the row takes a new id, the provider, the new request, no
  reference and `preparing`, and the send goes on as above. The new id means
  a late answer to the sandbox send, whose updates name the old id, cannot
  land on the provider's row. The sandbox row's own fields are not kept
  (there is no archive table); the provider's message is the one that
  counts. A provider's message is never replaced, and the sandbox meeting it
  is `travel_rule_conflict`.
- The payer is `type: company`, paying from an `unhostedWallet` (the
  business's own wallet); the supplier is at a `crypto` (hosted) address
  with the exchange named to Sumsub. Countries go as ISO alpha-3, from a
  fixed list; any other country is refused, not guessed.

## The sender-declaration pack (unhosted senders)

The business's wallet is self-hosted, so no VASP holds the sending side.
`POST /api/wallet/payments/[wsr_…]/sender-declaration {exchange,
invoiceNumber?, invoiceDate?, format?}` returns the pack as PDF (default)
or JSON (`splash.sender-declaration.v1`), with the SHA-256 of the JSON in
`X-Content-SHA256` and on the PDF. It holds the payer (the KYB case's name
and registration number, the country and address from the profile; only for
a business whose KYB is approved), the sending wallet, the supplier and
its deposit address on Sui, the amount, the invoice number and date (the
only fields from the request, marked as the sender's), the payment
reference and the digest once sent. The exchange is named only when its
agreement is signed (`SIGNED_PARTNERS`), its role otherwise.

## KYT (Elliptic, Chainalysis sanctions list)

- **Elliptic** (D8): the AML API's synchronous wallet exposure
  (`POST /v2/wallet/synchronous`, subject `holistic`), signed with
  `x-access-key`, `x-access-timestamp` (ms) and `x-access-sign` (base64
  HMAC-SHA256 keyed by the base64-decoded secret over timestamp, method,
  lower-cased path and body). The verdict is the risk score against the
  thresholds: BLOCK at 7 or more, REVIEW at 3 or more, CLEAR below
  (`ELLIPTIC_REVIEW_SCORE`, `ELLIPTIC_BLOCK_SCORE` until compliance sets
  them). A null score is REVIEW: a fresh address is what an unknown payee
  looks like. An error, a timeout, an answer without Elliptic's own id, an
  unreadable score, or a misconfigured key (a secret that is not Elliptic's
  base64, thresholds out of order) is no verdict, and nothing is asked.
- **Chainalysis sanctions list:** the fallback until Elliptic is contracted.
  With both, a listing blocks whatever Elliptic says, and "not listed" is
  never taken for Elliptic's answer.
- **What is screened:** deposits on arrival (§4.3, kept on the deposit's
  row); recipients through `POST /api/compliance/screenings {kind, chain,
  address}`: `wallet_recipient` and `exchange_recipient` on Sui,
  `cross_chain_recipient` on Solana, Ethereum, Base, Arbitrum, Optimism,
  Polygon or Avalanche. The address is checked against its chain's format
  first (Sui 0x + 64 hex, EVM 0x + 40 hex, Solana base58 32 to 44); a wrong
  one is refused before any provider is asked.
- **Kept:** every screening, the unanswered ones too, in `kyt_screenings`
  (0045): append-only (a trigger refuses UPDATE and DELETE), a provider's
  reference once per business and address (0046: an answer covering two
  addresses is two rows, and neither is handed the other's; the sanctions
  list's reference names the address), and the database refuses a verdict
  without a reference and a time. Another business's screening of the same
  address does not count. Only CLEAR permits a payment.

## What holds a payment back

The screening and the Travel Rule message are not only kept: the money path
reads them.

- **Opening.** A wallet payment (`requestWalletPayment`), the owners'
  payment of an open intent (`requestOpenIntentPayment`) and an owner's
  second approval of a rule payment (`openSecondApproval`) are opened only
  when this business's newest screening of the recipient is a fresh CLEAR
  (`recipientScreeningGate`, lib/server/kyt-screenings.ts). BLOCK is 403
  (`recipient_blocked`); REVIEW (`recipient_in_review`), nothing on file or
  no answer (`recipient_not_screened`) are 409. A CLEAR older than
  `KYT_SCREENING_MAX_AGE_HOURS` (default 24), or an unanswered newest attempt,
  is screened again by the server's provider and that answer decides; with
  no provider it is refused (`recipient_screening_stale`). A BLOCK is never
  screened away by this check. Nothing is stored for a refused payment. A
  bank payout pays the business's verified partner deposit address and goes
  through the payout route (§4.4, §4.5).
- **Cross-chain.** A cross-chain payment's CCTP receipt
  (`openCrossChainTransfer`, lib/server/cross-chain-transfers.ts) is opened
  only when this business's newest screening of the destination address,
  on its own chain (BASE, SOLANA, …), is a fresh CLEAR
  (`crossChainDestinationGate`): the same codes as above, and another
  business's CLEAR, or a CLEAR of the same address on another chain, does
  not count. On Solana CCTP mints to the supplier's USDC token account,
  while sanctions and KYT lists name wallets, so the wallet that owns that
  account (read on chain when the recipient is saved,
  `destination_token_owner`) is screened too: on save (a BLOCK on either is
  `recipient_blocked` and nothing is saved; the recipient shows the less
  favourable answer of the two) and when the payment is opened (both must
  be fresh CLEARs; a BLOCK on either decides; a Solana recipient with no
  owner on file is `recipient_not_screened`). A retry of a receipt already
  opened is screened again too: the receipt is kept as it is, and a BLOCK,
  REVIEW or stale answer since is reported instead of the receipt. The
  owners' cross-chain pay path itself is not built yet
  (`cross_chain_not_built`); when it is, it opens this receipt first, and
  its signing check calls `crossChainDestinationGate` again.
- **Signing.** Before every signature on a wallet payment or a second
  approval (the signing layer's `beforeSign`,
  lib/server/payment-compliance-gate.ts) the same check runs again, so a
  payment opened before a BLOCK is not signed after it; the signature that
  completes the quorum passes through it too.
- **Exchange payments.** A wallet payment to an exchange recipient is not
  signed until its Travel Rule message is with the provider (`submitted`,
  `awaiting_counterparty` or `approved`, with Sumsub's reference): none, or
  one not yet accepted, is `travel_rule_missing`; `on_hold` holds
  (`travel_rule_on_hold`); `rejected` refuses (`travel_rule_rejected`). A
  recipient is an exchange's when the payment's kind is EXCHANGE, when this
  business screened the address as an `exchange_recipient`, or when a
  message was started for the payment, so sending it as kind WALLET does not
  avoid the check.

## The controls evidence, per payment

`GET /api/wallet/payments/[ref]/evidence?format=json|pdf`, owners and staff.
`ref` is the intent id, the payout id (`wdr_…`) or the signing request
(`wsr_…`). Another business's reads as absent (404). The PDF is a readable subset of the JSON; the JSON holds every field.
The JSON's SHA-256 in `X-Content-SHA256` and on the PDF:

| Section | From |
|---|---|
| payment | the payout row or the signing request's decoded bytes: kind, status, amount, the `max_fee` bound, paid to, from wallet |
| kyb | the business's newest KYB case: id, state, the provider's applicant reference, the lifecycle |
| approvedAt | when the payment was approved: the signature that completed its quorum (null while it is not) |
| screenings | this business's screenings of the address paid that were on file when it was approved: provider, reference, verdict, score, time; for a cross-chain payment also those of its destination address on its own chain (`subject: cross_chain_recipient`), and on Solana those of the wallet that owns that token account (`subject: cross_chain_recipient_owner`) |
| screeningsAfterApproval | screenings made after it was approved, listed apart: not the check that applied to it |
| travelRule | the Travel Rule transfer for the payment |
| approval | the signing request: purpose, status, threshold, each signer's address, weight and time; the spending rule's allowance and policy ids; a second approval's policy and payer |
| quote | the payout's quote: reference, rate, what arrives, each partner fee its own line, Splash's fee |
| partner | the route, the partner's reference, the bank's reference, the account's last four |
| iso20022 | the masked pacs.008 copy the partner was sent |
| chain | the Sui digest; read from the chain, the intent created (under splash_core's original package id), and the SettlementAnchored event's Walrus blob and content hash; the receipt as `<digest>#<event index>` |
| gaps | what is not on file, in words: among them no CLEAR as the newest screening before approval (of the cross-chain recipient, for a cross-chain payment, and on Solana of the wallet that owns its token account, or that wallet not on file), a KYB case changed after approval (it is shown as it is now), an exchange payment with no Travel Rule message the provider took, and in production a screening or Travel Rule message on file that is the sandbox's |

No secret, signature, sealed value, salt, transaction bytes or account
number is ever in it: `assertEvidenceClean` refuses a document with such a
key (an account under its usual names too: `iban`, `account`,
`creditorAccount`, `accountNo`; the last four is `…Last4`), a raw key
value, or an account-shaped value (eight digits or more, or an IBAN) outside
the amount, time, score and reference fields, so a field added later cannot
leak one. Each partner fee is copied as its own line with its four fields
only, not passed through from the quote. A chain
that cannot be read leaves the chain fields empty and says so.

## Not built here

- An owner's override of a Travel Rule `on_hold`: a held payment waits for
  the exchange. Whether owners may override a VASP's hold at all is for
  compliance to decide.
- A staff member's own payment under their rule, within its limits, is made
  with their allowance on chain and is not built by the server here, so the
  screening check does not run on it; when that path is built it must call
  `recipientCleared`. Rule recipients are verified by the business multisig.
- The Travel Rule step for a rule payment (`spend_approval`): the message
  route takes wallet payments only.
- An `unconfirmed` Travel Rule message is resolved by Sumsub's webhook only;
  ops have no screen for it yet, and the payment stays held meanwhile.
- A REVIEW is cleared only by screening the address again; there is no
  reviewer's decision record yet.

- Name screening of a supplier or its owners (sanctions and PEP by name),
  which a bank route's partner does today. Sumsub screens both parties of a
  Travel Rule transfer; that answer arrives by webhook as the transfer's
  status.
- §4.7's wallet recipients (exchange, self-custody, cross-chain) are
  screened with `screenRecipient` before they are saved. The older wallet
  save (`POST /api/recipients` with `payoutMethod: WALLET` and no
  `deliveryKind`) still screens with the sanctions list only; what it saves
  is an unproven wallet the supplier holds, which is not paid until proven
  and screened here.
- A deposit's screening is not copied into `kyt_screenings`; the evidence
  export is per outbound payment and does not show it.
- The Elliptic request and response shapes and the Sumsub Travel Rule shape
  are from their public documentation; check both against the contracted
  accounts' sandboxes before go-live.

## Review follow-ups (section 4.6)

- A payout's free text (remittance reference, party names, town) is masked at
  export: cut to 140 characters, any IBAN or run of eight digits or more
  reduced to its last four digits. The account-shaped check stays on for
  everything else, and a refused document answers 422 (`evidence_refused`).
- After a Sumsub 409 the applicant is looked up by its external user id so
  the case's reference is attached even when the first attach was lost.
- Decision for compliance: with Elliptic and the sanctions list both
  configured, an unreachable list leaves Elliptic's verdict standing and the
  detail says the list gave no answer. Elliptic's score already includes
  sanctions exposure; failing closed would stop every payment during a list
  outage. Say which is wanted.
