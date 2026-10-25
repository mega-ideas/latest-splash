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
| Check | `PATCH /api/bills/:id` `confirm` | A person confirms every field (supplier, invoice number, amount, currency, due date, invoice date, supplier country). Nothing is paid as read. |
| Duplicates | `lib/bills/duplicates.ts` | Same document: the same invoice. The same invoice number as another open or paid invoice, from the same supplier (the name as typed, reduced; letters of any script count) or to the same recipient: cannot be scheduled, and two partial unique indexes hold it against a race (`payable_invoices_number_once_unique` by name, `payable_invoices_recipient_number_once_unique` by recipient, 0058). The same amount from the same supplier or to the same recipient within 45 days under another number: a person says why it is not a duplicate (`acknowledge_duplicate`). The check runs again before the hand-off. |
| Recipient | `match` | Only the business's own recipients, and only verified ones (screening `CLEAR` or admin `ATTESTED`). A USDC-only launch matches no bank recipient. A recipient the supplier's name does not suggest ("Paid under another name") needs a reason of 8 characters or more, kept as `match_reason`; changing the supplier clears the match. A recipient whose wallet is one of Splash's own addresses is refused (`splash_address`), and an unreadable list of them is a 503. When the invoice prints an account or wallet that is not the recipient's, the page warns; for a PDF, Zeke reads them (form-checked, at most 10 of each), and when it did not the page says they were not compared. The payment still goes to the recipient on file. |
| Schedule | `schedule` | A pay-on date from today to a year out. Only the invoice as it was checked: a change in between is refused (`changed`). `unschedule` takes it back to review; `cancel` closes it. |
| Approve | `POST /api/bills/:id/approve` | Hands the invoice to the payment flow through `lib/bills/payment-hook.ts`, keyed by the invoice id, with `settlementAsset: 'USDC'` and `feeRule: 'quote_in_transfer_shown_fee_is_max_fee'` (the fee is quoted in Transfer and the fee shown there is the payment's `max_fee`; the invoice carries no fee number). A non-USD invoice is refused with `fx_quote_needed`: Invoices does not quote rates, and the page sends it to Transfer. **The 5.4 payment flow is not on this branch**: the hook answers `501 PAYMENT_FLOW_NOT_WIRED`, nothing changes, and the page says so. When 5.4 lands it calls `registerBillPaymentFlow(flow)`. |
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

- The create form keeps its fields, grouped (who is paying, what they owe,
  when and from whom), with errors under each field, the business's own
  name prefilled, a due date 14 days out, a preview of what the payer sees,
  and the pay link ready to copy when the invoice exists. It is a dialog
  (Escape closes it, focus stays inside).
- Status moves forward only (`lib/invoices/status.ts`). `PATCH
  /api/invoices/:id` asks `lib/invoices/patch-rules.ts`: only owners,
  finance admins, approvers and makers (the membership's role) change an
  invoice (403 otherwise); it refuses a regression (409), "paid" without the
  reference the business received (422; the reference on file and the
  payer's report do not count), a transfer that is not the org's (404) and
  a second transfer binding (409).
- The public pay link records the payer's report as **reported** ("Payer
  says paid"), never paid, and never overwrites a payment on record. What
  the payer said is kept apart (`payer_reported_reference`,
  `payer_reported_at`, 0058), shown beside "Mark as paid", and never filled
  in for the business. Only the business ("Mark as paid", with the reference
  from its statement) or a USDC payment matched on Sui makes it paid.
- A receipt for each paid invoice: method (USDC on Sui with a verify link, or
  a bank transfer the business confirmed), reference, date.

## Storage

Migrations `0057_payable_invoices` and `0058_invoices_review` (journalled).
Numbered from 0057 to follow Phase 2's 0033–0054 (they were 0050 and 0051
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
