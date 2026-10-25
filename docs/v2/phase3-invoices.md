# v2 Phase 3, brief 5.8: Invoices

`/dashboard/invoices` opens on a choice: **Get paid** (invoices the business
sends) or **Pay invoices** (invoices its suppliers send). `?view=pay` opens
Pay invoices; the old `?view=loop` links (and `/dashboard/0xwal`) land there
too.

## Pay invoices (was the "Inspection loop")

intake → Zeke reads payee, amount, due date (confidence shown) → duplicate
check → verified recipient → schedule → approve → paid → receipt and the
self-billed MyInvois e-invoice.

| Step | Where | What it does |
|---|---|---|
| Intake | `POST /api/bills` | Pasted text, a text file, or a PDF. The client sends an intake key (a UUID): the idempotency key, unique per org. The same document again (while not cancelled) returns the invoice already on file. A PDF needs Zeke's reader; without `ANTHROPIC_API_KEY` it is refused (`pdf_unreadable`) and nothing is stored. |
| Reading | `lib/bills/extract.ts` | The parser reads labelled fields; Zeke's reading (when configured) is checked against the document text. Confidence is a level with a reason: **high** beside its own label, **medium** found without a label or read by Zeke and found in the text, **low** read by Zeke but not in the text, **not read**. No percentage, because nothing measures one. The page marks each value where it was found. |
| Check | `PATCH /api/bills/:id` `confirm` | A person confirms every field (supplier, invoice number, amount, currency, due date, invoice date, supplier country). Nothing is paid as read. The amount is read in the currency chosen (`lib/bills/amount.ts`): a group that starts with zero is a decimal (0.125 is an eighth), `1,250.00`, `1250,50` and `1.250.000` read as printed, and `1.234` or `12.345` is a decimal in dollars and a thousands mark in rupiah, dong, yen and won; with no currency it is not read, and the parser leaves such a total for the person with the reason. Written only onto the invoice as it was read (`changed` otherwise), so a duplicate answer given for another amount never survives. A currency other than USD or USDC is told here that it needs a rate quote, with a link to Transfer. |
| Duplicates | `lib/bills/duplicates.ts` | Same document: the same invoice. The same invoice number as another open or paid invoice, from the same supplier (the name as typed, reduced; letters of any script count) or to the same recipient: cannot be scheduled, and two partial unique indexes hold it against a race (`payable_invoices_number_once_unique` by name, `payable_invoices_recipient_number_once_unique` by recipient, 0058). The same amount from the same supplier or to the same recipient within 45 days under another number: a person says why it is not a duplicate (`acknowledge_duplicate`). The check runs again before the hand-off. |
| Recipient | `match` | Only the business's own recipients, and only verified ones (screening `CLEAR` or admin `ATTESTED`, and for a self-custody wallet the owner's signed ownership proof, brief D5 and 4.7: `ownership_unproven` otherwise; nothing on this branch records that proof yet, so no wallet recipient is paid from Invoices until 4.7 lands). A USDC-only launch matches no bank recipient. Only the same name, reduced, needs no reason: a recipient whose name is merely close ("Similar name"), or that the name does not suggest at all ("Paid under another name"), needs a reason of 8 characters or more, kept as `match_reason`, checked again at schedule and approve. Generic words (Global, Trading, Holdings, Electronics, ...) never make two names alike, and a suggestion needs more than half the longer name's words. Changing the supplier clears the match. A recipient whose wallet is one of Splash's own addresses (the operator and the treasury, both required, the test recipient, the FeeConfig fee recipient in force and the one proposed under notice, all normalised) is refused (`splash_address`); a missing or malformed address or FeeConfig id, or an unreadable FeeConfig, is a 503. When the invoice prints an account or wallet that is not the recipient's (accounts compared digit for digit; only an account kept as a mask matches by its ending, and then only a printed number of 8 digits or more), the page warns; for a PDF, Zeke reads them (form-checked, at most 10 of each), and when it did not the page says they were not compared. A printed account or wallet that is not on file warns even when another printed one is. The payment still goes to the recipient on file. A recipient made from a payer's report (`createdVia: invoice_link`) is a customer and never a candidate supplier, and choosing another recipient clears the "not a duplicate" answer given with the earlier one. |
| Schedule | `schedule` | A pay-on date from today to a year out. Only the invoice as it was checked: a change in between is refused (`changed`). The page sends the `revision` it showed (a fingerprint of supplier, number, recipient, amount, currency, dates, reasons and attempt, `billRevision`); the route requires it (`revision_required`), and an invoice someone changed since is a 409 `changed` carrying the invoice as it is now. `unschedule` takes it back to review; `cancel` closes it. |
| Approve | `POST /api/bills/:id/approve` | Takes `{ revision }` (required) and hands over only the version the person saw: a changed invoice is a 409 `changed` and nothing goes to Transfer. Hands the invoice to the payment flow through `lib/bills/payment-hook.ts`, keyed by the invoice id, its `payment_attempt` (0059; bumped when an intent closes unpaid, is withdrawn, or the invoice is unscheduled) and a hash of the recipient, amount, currency and date, so a re-approval is never answered with a dead intent and the same key with another payload is a 409 for the flow. Written as approving only onto the invoice it handed off: one changed while the flow took its quote is refused (`changed`) and the flow is told to drop the intent. `withdraw` takes an invoice waiting for approval back to scheduled, only through the flow's `cancel` (501 without it; the flow's refusal, for example once an owner signed, is a 409). The contract asks 5.4 to check the recipient again when it builds and when it signs. With `settlementAsset: 'USDC'` and `feeRule: 'quote_in_transfer_shown_fee_is_max_fee'` (the fee is quoted in Transfer and the fee shown there is the payment's `max_fee`; the invoice carries no fee number). A non-USD invoice is refused with `fx_quote_needed`: Invoices does not quote rates, and the page sends it to Transfer. **The 5.4 payment flow is not on this branch**: the hook answers `501 PAYMENT_FLOW_NOT_WIRED`, nothing changes, and the page says so. When 5.4 lands it calls `registerBillPaymentFlow(flow)`. |
| Paid | `recordBillSettlement` (server only) | The payment flow reports the intent, the Sui digest and the network it settled on (`testnet` or `mainnet`; without one, the server's), so the receipt links the right explorer. Idempotent: the same pair again is a replay, a different digest is refused, one digest pays one invoice (unique index). `recordBillPaymentClosed` puts an unpaid closed intent back to scheduled. No client route reaches either. |
| Receipt | the page | Receipt no. (`SPB-YYYYMMDD-…`), paid on, amount, supplier, invoice number, destination (masked), approvers, Sui digest with a verify link, save as PDF. |
| Self-billed e-invoice | `POST /api/bills/:id/e-invoice` | Only for a paid invoice from a supplier outside Malaysia, for a Malaysian business. Made once (a second request returns the same file; `refresh` remakes one older than 72 hours, for a fresh issue date, and the history keeps the replaced file's SHA-256; two remakes racing leave one). `GET …?download=1` downloads it; the page links the MyInvois portal. |

### The self-billed file (`lib/myinvois/self-billed.ts`)

Checked on 25 Oct 2026 against the MyInvois SDK (sdk.myinvois.hasil.gov.my):
UBL 2.1 JSON, e-Invoice type `11` (self-billed invoice), version `1.0`
(signature validation disabled; `1.1` needs the issuer's digital signature,
which Splash does not hold, and the SDK says 1.0 will be retired on a date
still to be announced). The foreign supplier is the `AccountingSupplierParty`
with the general TIN `EI00000000030`, BRN/SST/TTX `NA`, MSIC `00000` "NOT
APPLICABLE", state `17`; the business is the `AccountingCustomerParty`.
Classification `034` importation of goods, `035` importation of services,
`036` others. Countries are ISO 3166-1 alpha-3. Tax type `06` (not
applicable). A currency other than MYR carries `TaxExchangeRate` to MYR.
USDC is recorded as USD. The business's TIN, contact number, state and the
exchange rate are asked for and never filled in by Splash; without them the
file is not made. Validate in the MyInvois sandbox before relying on a new
field.

## Get paid

- The amount is text, not a float (`lib/invoices/create-input.ts`): up to 12 digits,
  up to 2 decimals, above zero. 0.001, 1e21, Infinity and numbers past 2^53 are a
  400 before anything is sealed or stored. An internal error is logged, not echoed.
- The pay link pays the Splash Wallet of the business's main admin. `POST
  /api/invoices` answers `receiveWallet.ready`; when that wallet is not set up the
  dialog says so, holds the copy button, and points to Settings, Security.
- Closing the dialog with typed work asks first (Keep editing / Close it).
- The create form keeps its fields, grouped (who is paying, what they owe,
  when and from whom), with errors under each field, the business's own
  name prefilled, a due date 14 days out, a preview of what the payer sees,
  and the pay link ready to copy when the invoice exists. It is a dialog
  (Escape closes it, focus stays inside).
- An invoice is created once. The dialog makes one create key (a UUID) for
  the invoice it is creating and keeps it across retries; `POST
  /api/invoices` requires it (`lib/invoices/create-once.ts`). The key and a
  fingerprint of the details are kept with the invoice under a partial
  unique index per org (`invoices_org_create_key_unique`, 0060). The same
  key with the same details answers 200 `replay: true` with the invoice
  already made (one pay link, one exact USDC amount), before any document
  is sealed or stored again; the same key with other details is a 409
  `create_key_reused`; another org's key is its own. Two creates racing on
  one key leave one invoice. A dropped connection brings the button back
  and says a retry will not make the invoice twice. The 409 names the
  invoice already made under the key (id, payer, amount, due date, status,
  pay-link slug; read for the session org), and the dialog offers "Open the
  invoice already made". A failed create is said once, in the role=alert
  line the button is described by, with no toast. The key and fingerprint
  never leave the server: every reply (list, create, `/api/invoices/:id`,
  the audit view) goes through `withoutCreateKey`. A request that sealed
  and stored a document but lost the race on its key logs the orphaned
  Walrus blob id and Seal policy id (never the document) for cleanup;
  claiming the key before the document work is left for later.
- The totals (Open, Overdue, Paid this month) stay on one line at any
  width (`lib/invoices/totals-figure.ts`): a figure steps down in size by
  its length to fit the narrowest tile, and past that is shown compact with
  the full value in the title and for screen readers. Up to lg, Open has
  its own row; from lg the three share one; the buttons join it from xl.
- Status moves forward only (`lib/invoices/status.ts`). `PATCH
  /api/invoices/:id` asks `lib/invoices/patch-rules.ts`: only owners,
  finance admins, approvers and makers (the membership's role) change an
  invoice (403 otherwise); it refuses a regression (409), "paid" without the
  reference the business received (422; 4 to 64 characters; the reference
  on file and the payer's report do not count), a reference that does not
  come with "paid" or comes once the invoice is paid or settled (409), a
  transfer that is not the org's (404) and a second transfer binding (409).
  The reference typed is kept as `received_reference` (0059); the one the
  payer was asked to quote stays. The write is guarded on the status read,
  so a USDC sync that settled the invoice in between is not overwritten
  (409 `changed`).
- The public pay link records the payer's report as **reported** ("Payer
  says paid"), never paid, and never overwrites a payment on record. What
  the payer said is kept apart (`payer_reported_reference`,
  `payer_reported_at`, 0058; `payer_reported_name`, `payer_reported_email`,
  0059), never over the payer the business named, bounded (reference 4 to
  64 in a plain form, name 120, email 254), shown beside "Mark as paid", and
  never filled in for the business. The payer's email is not logged. Only the business ("Mark as paid", with the reference
  from its statement) or a USDC payment matched on Sui makes it paid.
- A receipt for each paid invoice: method (USDC on Sui with a verify link, or
  a bank transfer the business confirmed), reference, date.

## Storage

Migrations `0057_payable_invoices`, `0058_invoices_review`, `0059_invoices_review_two` and `0060_invoices_create_once` (journalled).
Numbered from 0057 to follow Phase 2's 0033–0054 (they were 0050, 0051 and 0052
before the branches met).
`lib/server/bills-store.ts` is the only reader and writer; every query is
scoped to the org; every status change is a guarded UPDATE on the status it
leaves, appending to `history` in the same statement. With no
`DATABASE_URL` the routes answer 503: supplier invoices are never kept in
memory.

## Roles

Owners, finance admins, approvers and makers bring in, check, match,
schedule and send for approval. Viewers, auditors and developers read.
Approval itself is the payment flow's: inside a spending rule a staff
member's payment runs alone, above it the owners sign.
