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
| Duplicates | `lib/bills/duplicates.ts` | Same document: the same invoice. Same supplier and invoice number as another open or paid invoice: cannot be scheduled, and the partial unique index `payable_invoices_number_once_unique` holds it against a race. Same supplier and amount within 45 days under another number: a person says why it is not a duplicate (`acknowledge_duplicate`). |
| Recipient | `match` | Only the business's own recipients, and only verified ones (screening `CLEAR` or admin `ATTESTED`). A USDC-only launch matches no bank recipient. When the invoice prints an account or wallet that is not the recipient's, the page warns; the payment still goes to the recipient on file. |
| Schedule | `schedule` | A pay-on date from today to a year out. `unschedule` takes it back to review; `cancel` closes it. |
| Approve | `POST /api/bills/:id/approve` | Hands the invoice to the payment flow through `lib/bills/payment-hook.ts`, keyed by the invoice id. **The 5.4 payment flow is not on this branch**: the hook answers `501 PAYMENT_FLOW_NOT_WIRED`, nothing changes, and the page says so. When 5.4 lands it calls `registerBillPaymentFlow(flow)`. |
| Paid | `recordBillSettlement` (server only) | The payment flow reports the intent and the Sui digest. Idempotent: the same pair again is a replay, a different digest is refused, one digest pays one invoice (unique index). `recordBillPaymentClosed` puts an unpaid closed intent back to scheduled. No client route reaches either. |
| Receipt | the page | Receipt no. (`SPB-YYYYMMDD-…`), paid on, amount, supplier, invoice number, destination (masked), approvers, Sui digest with a verify link, save as PDF. |
| Self-billed e-invoice | `POST /api/bills/:id/e-invoice` | Only for a paid invoice from a supplier outside Malaysia, for a Malaysian business. Made once (a second request returns the same file; `refresh` remakes one older than 72 hours, for a fresh issue date). `GET …?download=1` downloads it; the page links the MyInvois portal. |

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
  /api/invoices/:id` refuses a regression (409), "paid" without a payment
  reference (422) and a second transfer binding (409).
- The public pay link records the payer's report as **reported** ("Payer
  says paid"), never paid, and never overwrites a payment on record. Only
  the business ("Mark as paid", with the reference) or a USDC payment
  matched on Sui makes it paid.
- A receipt for each paid invoice: method (USDC on Sui with a verify link, or
  a bank transfer the business confirmed), reference, date.

## Storage

Migration `0057_payable_invoices` (journalled). Numbered 0057 to follow
Phase 2's 0033–0054 (it was 0050 before the branches met).
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
