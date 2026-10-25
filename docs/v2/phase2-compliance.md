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

Tests: `tests/compliance-kyt.test.mjs`, `tests/compliance-sumsub.test.mjs`,
`tests/controls-evidence.test.mjs` (PGlite, no network), and the source
checks in `tests/kyb-lifecycle.test.mjs`.

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
is refused, and no secret verifies as false); then the body; then its date
(`createdAtMs` or `createdAt`) inside a two-day window, since Sumsub retries
for about a day, and no more than five minutes ahead; then the delivery is
claimed once in `webhook_events` by the SHA-256 of the raw body. A replay
inside the window is acknowledged and changes nothing. A failure of ours
releases the claim so Sumsub can deliver again. Production without a
database refuses (503).

- **KYB:** only `applicantReviewed` decides. GREEN moves the business to
  KYB_PROVIDER_APPROVED; RED with `reviewRejectType: FINAL` to REJECTED; a
  RED the applicant may retry changes nothing (before, any RED rejected).
  The actor is PROVIDER, which the state machine never lets reach ACTIVE; a
  transition the machine refuses is acknowledged (200) and nothing moves
  back.
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

- The payment, the payer (the business's registered profile), the supplier
  (this business's saved recipient at that address, with its Travel Rule
  half) and the applicant (the business's KYB case) are read on the server.
- The recipient's newest screening by this business must be CLEAR: REVIEW
  waits for a person, BLOCK is refused (403), none asks for screening first.
- Once per payment: the row is written before Sumsub is asked, keyed by the
  business and the payment reference (the intent id when it exists, else
  the signing request id), which is also Sumsub's txnId. A retry of the same
  message answers the same transfer without asking again; the same payment
  with another amount, address or party is refused (`travel_rule_conflict`).
  A failed send leaves the row `preparing`, with no reference, and the retry
  asks again under the same txnId. An answer without Sumsub's transfer id,
  or naming another txnId, is not a submission.
- The payer is `type: company`, paying from an `unhostedWallet` (the
  business's own wallet); the supplier is at a `crypto` (hosted) address
  with the exchange named to Sumsub. Countries go as ISO alpha-3, from a
  fixed list; any other country is refused, not guessed.

## The sender-declaration pack (unhosted senders)

The business's wallet is self-hosted, so no VASP holds the sending side.
`POST /api/wallet/payments/[wsr_…]/sender-declaration {exchange,
invoiceNumber?, invoiceDate?, format?}` returns the pack as PDF (default)
or JSON (`splash.sender-declaration.v1`), with the SHA-256 of the JSON in
`X-Content-SHA256` and on the PDF. It holds the payer (name, registration,
country, address from the profile), the sending wallet, the supplier and
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
  reference once per business, and the database refuses a verdict without a
  reference and a time. Another business's screening of the same address
  does not count. Only CLEAR permits a payment.

## The controls evidence, per payment

`GET /api/wallet/payments/[ref]/evidence?format=json|pdf`, owners and staff.
`ref` is the intent id, the payout id (`wdr_…`) or the signing request
(`wsr_…`). Another business's reads as absent (404). The same content in
both formats, the JSON's SHA-256 in `X-Content-SHA256` and on the PDF:

| Section | From |
|---|---|
| payment | the payout row or the signing request's decoded bytes: kind, status, amount, the `max_fee` bound, paid to, from wallet |
| kyb | the business's newest KYB case: id, state, the provider's applicant reference, the lifecycle |
| screenings | this business's screenings of the address paid: provider, reference, verdict, score, time |
| travelRule | the Travel Rule transfer for the payment |
| approval | the signing request: purpose, status, threshold, each signer's address, weight and time; the spending rule's allowance and policy ids; a second approval's policy and payer |
| quote | the payout's quote: reference, rate, what arrives, each partner fee its own line, Splash's fee |
| partner | the route, the partner's reference, the bank's reference, the account's last four |
| iso20022 | the masked pacs.008 copy the partner was sent |
| chain | the Sui digest; read from the chain, the intent created (under splash_core's original package id), and the SettlementAnchored event's Walrus blob and content hash; the receipt as `<digest>#<event index>` |
| gaps | what is not on file, in words |

No secret, signature, sealed value, salt, transaction bytes or account
number is ever in it: `assertEvidenceClean` refuses a document with such a
key or a raw key value, so a field added later cannot leak one. A chain
that cannot be read leaves the chain fields empty and says so.

## Not built here

- Name screening of a supplier or its owners (sanctions and PEP by name),
  which a bank route's partner does today. Sumsub screens both parties of a
  Travel Rule transfer; that answer arrives by webhook as the transfer's
  status.
- The recipient forms (§4.7) do not call the screening route yet, and the
  existing wallet-recipient save still screens with the sanctions list
  only. §4.7 moves both onto `screenRecipient`.
- A deposit's screening is not copied into `kyt_screenings`; the evidence
  export is per outbound payment and does not show it.
- The Elliptic request and response shapes and the Sumsub Travel Rule shape
  are from their public documentation; check both against the contracted
  accounts' sandboxes before go-live.
