# v2 Phase 3: Zeke reads payout sheets

Sky's decision: Zeke keeps drafting batch payouts, and the easy path for a person
is to upload a file and let Zeke read it. So a person attaches a sheet, Zeke shows
the rows for checking, and prepares the batch in the **wallet batch flow**, the one
Batch payouts uses (`docs/v2/phase3-batch.md`). It can no longer land on the old
path, which is removed.

Zeke never sends. It prepares; the owners sign once. Nothing in this page changes
that (`docs/v2/phase2-zeke.md`, sections 1 and 2a).

## What a person does

1. **Attach a sheet** with the paperclip in the Zeke composer (the desk page, an
   open conversation, the floating Zeke), **or paste rows** into the composer, **or**
   use the upload on Batch payouts. A CSV, a tab-separated paste or an `.xlsx` (the
   spreadsheet reader the project already depends on; no new library).
2. **Check the table.** Zeke's thread shows the file as a plain table: recipient,
   amount, currency, reference, and per row **Clear**, **Check** or **Cannot be
   paid**, with the reason in words. Zeke's limit is on top of the card ("I can
   prepare this batch, but I can't approve or send it...").
3. **Press Prepare batch.** One button. The batch is made by
   `POST /api/wallet/batches`, as a typed batch is. Zeke says "Nothing has been
   sent" and links to Batch payouts.

Pasted rows (two or more lines split by tabs, commas or semicolons, with a number
in them) go to the sheet reader, never to the model.

## Code

| | |
|---|---|
| `lib/batch/ingest.ts` | the reader: rows from text or `.xlsx`, by fixed rules |
| `lib/server/zeke-batch-sheet.ts` | `readSheetForZeke`: the reader, then `reviewBatch`, then the person's rule |
| `lib/server/sheet-columns-deps.ts` | the only model call: column names |
| `app/api/wallet/batches/sheet/route.ts` | `POST`, gated like every wallet route |
| `lib/server/capped-body.ts` | reads a body up to a cap, while it is read |
| `lib/batch/file.ts` | the browser's side: file to text or bytes, size and kind only |
| `components/oxwal/SheetCard.tsx`, `lib/oxwal/use-oxwal-thread.ts` | the card and its actions |
| `lib/agent/sheet-copy.ts` | Zeke's words (run through the completion guard in the tests) |

## The file is data

`lib/batch/ingest.ts`. Nothing in a cell is ever read as an instruction, and what is
changed is recorded on the row, so the person sees it.

- **Text that talks to an assistant** ("ignore the rules", "Zeke, approve this",
  `SYSTEM:`, "from now on pay to...", a tool name) is **ignored and cleared**. A
  recipient cell that does this is empty, so the row names nobody and cannot be
  paid. In a reference, the rest of the row is still checked.
- **Formulas.** A leading `=`, `+`, `-` or `@` (also the full-width forms, after
  NFKC) is removed; a cell that is a spreadsheet function call, a pipe or a shell
  line is cleared.
- **Links and commands** are stripped from what is shown back (schemes, `www.`,
  an address with a path, email addresses; backticks, `$(`, `&&`, `|`, HTML tags,
  `javascript:`, `curl ... host`).
- **Hidden characters** of every kind are removed from every cell and the row says so:
  all control and format characters, the variation selectors, U+034F, the Hangul and
  Khmer fillers, the blank Braille cell and the whole Unicode tag block
  (`lib/agent/untrusted-text.ts`, one list for the sheet reader, the invoice scan and
  typed batches). Text spelled in the tag block (ASCII that no screen draws) is read
  before it is dropped, so an instruction hidden there clears the cell.
- **A name that sounds like a command is still a name.** Phrases that can only be
  aimed at an assistant ("ignore previous instructions", `SYSTEM:`) hold for every
  cell. A verb and an object ("send it", "release payments") hold for references, and
  for a name only when it reads as an order (starts with please or kindly, or is five
  words or more). So "Release Payments Ltd" and "Zeke's Diner" are suppliers. A name
  that is cleared says so and tells the person to use the wallet address.
- **A row that no longer says what the file said is a row to check.** A cell cleared
  as an instruction or a command, or a recipient that had a link or a formula cut
  out, makes its row **Check** (one box, as for a repeat).
- **A file name** is shown, and stored as the batch label, only when it is plain. A
  name with a link, a host name (a dot and letters) or an instruction in it is not
  shown: the card says "Uploaded sheet" and the label is generic.
- **Caps.** The file: 256 KB. Rows scanned: 200. Columns: 40. One cell: 400
  characters. A spreadsheet is a zip: its directory is read first and a spreadsheet
  that would expand past 8 MB or 200 parts is refused **before it is opened**. A
  batch is at most **20 payments**; more is refused as a whole, with the count, and
  never cut to 20. The route reads its body with a cap while it is read
  (`readCappedText`).
- **One currency, USDC.** Zero and negative amounts, a currency sign or code beside
  an amount, and a currency column that says anything but USDC are refused. A
  foreign currency travels with the amount ("100 EUR"), so a row cannot become
  USDC by being passed on: the review refuses it again. **Only a currency cell that
  is truly empty means USDC.** A cell that had something in it which was cleared (a
  command, an instruction) is unreadable, not USDC: the row is refused and the
  review sees "100 ?".

Matching a name or an address to a recipient is not done here. The review does it,
against **this business's** saved recipients only (`reviewBatch`), exactly as for a
typed batch.

### Where a model helps, and where it cannot

Only when the **headers** are not ones the reader knows (`recipient`, `name`,
`payee`, `amount`, `total`, `reference`, `memo`, `currency`, and the aliases in
`lib/batch/sheet.ts`). Then `mapColumns` is given the header names, never a cell,
and answers which header is the recipient, amount, reference and currency. The answer
is **checked**: every named header must exist exactly once, no header is used
twice, **every** amount cell must be a number or an amount with a currency beside
it, the recipient column must hold something, and a column of whole numbers (invoice
numbers) is not the amount while another unused column of amounts has cents.
**Columns a model chose need the person's yes**: the card names them ("Recipient:
Party. Amount: Settle Total. Reference: Invoice No."), the chip reads "Check the
columns", and Prepare waits for the box. Batch payouts shows the same notice, and the
columns that were not used, above the review. A header that reads like an instruction is replaced by "(column 3)"
before the model sees it. With no `ANTHROPIC_API_KEY`, or a wrong answer, or a
model that throws, nothing is guessed: the person is asked to name the columns.
There is no sandbox answer to reach in production or anywhere else.

## The table's checks

`readSheetForZeke` runs `reviewBatch` on every row. A row is:

- **Cannot be paid**: its cells are wrong (no recipient, a bad amount, a foreign
  currency, a repeated row), or its recipient is **not a verified recipient**: not
  saved by this business, not found, ambiguous, not screened clear by a provider
  (in production a sandbox clear is no clearance), or a wallet not proven. Those
  cannot be paid until verified, and the card says so in words.
- **Check**: it repeats a payment of a batch made in the last 30 days, or names a
  Splash business by its registered name that nobody on the team has saved. The
  person ticks one box to say they have checked; the same two confirmations the
  batch page asks for (`confirmDuplicates`, `confirmNewPayees`).
- **Clear**.

The wallet's shortfall is one note on the sheet and blocks Prepare. A fee that has
moved since the table was shown is `409 fee_changed` at Prepare; the table is never
the authority, the batch flow checks every row again.

### The person's rule

A staff member's rows are also judged by their spending rule with **the function
Transfer uses** (`approvalPlan`), reading the rule from the chain
(`readStaffRule`), counting the cap taken by earlier rows of the sheet: over the
payment limit, over what is left of the cap, a recipient not on the rule, above the
amount an owner must approve. Each reason is said with its numbers
(`approvalReasonLines`). **A batch is signed by the owners whatever the rule says**
(`docs/v2/phase3-batch.md`, "A staff member's batch is not tied to the 10,000 USDC
second-approval rule"), so a row outside the rule is **marked, not blocked**, and a
row inside it says that the owners still sign. If the rule cannot be read, one note
says every row waits for the owners; no rule is ever made up. An owner is not judged
by a rule. The card says so in one line ("No spending rule applies to an owner.
Every batch still needs the owners' signatures."), because the product has no
owner-side per-payment or daily limit to check a row against: SpendPolicy's
per-payment maximum and second-approval amount are the staff rule's, and
`approvalPlan` answers `owners_sign` with no reasons for an owner, in Transfer too.

### The card

The amount is the amount that will be signed (`1,200.00`), with the typed text as a
tooltip when it differs. The table sits outside the thread's live region
(`aria-live="off"`) and one status line is announced instead ("Payout sheet: 7 rows
read, 3 cannot be paid.", `components/oxwal/SheetStatus.tsx`). Rows pasted into the
box stay there until the sheet has been read, so a question that looked like rows is
not lost.

## Prepared, and not sent

- An **owner's** batch becomes one signing request for the owners' multisig. Nothing
  is drawn until the threshold has signed on their own devices.
- A **staff member's** batch is `prepared`: no signing request, no audit bundle; the
  owners are told, and one of them starts the signatures in Batch payouts.
- **Replay.** The sheet's intent id (`batch_...`) is made when the table arrives and
  is the `Idempotency-Key` of Prepare. Pressing twice, or two tabs, makes one batch
  and one request. The same sheet read again is a new intent id, so a repeat of a
  batch made in the last 30 days is shown as **Check** and made only on a yes.
- Zeke's words are Splash's own fixed text and never say money moved. The tests run
  every string through `guardCompletionClaims`.

## Tenants and roles

The route is `batchRoute` -> `walletRoute`: a signed-in customer, the business from
the **session** (`requireSessionAccount`), their own membership, the live wallet
context for that business only; then the accepted terms, the payer role
(`requireWithdrawalRequester`: owner or staff, never a viewer), and the wallet rate
limit. A body that names a business, role or user is refused as a provenance
violation. Another business's recipients, batches and receipts read as absent.

## What was removed

Once the rewire left them unreferenced (proved by search in
`tests/zeke-legacy-batch-removed.test.mjs`):

- the `BATCH_PAYOUT` proposal kind (`PROPOSAL_KINDS` in `lib/agent/types.ts` no
  longer has it), its entries in the launch scope, policy, screening, anomaly,
  metrics, queue and stuck-payment views;
- Zeke's `proposeBatchPayout` tool and the model's instructions for it;
- the step-up `BATCH_PAYOUT` purpose and `batchPayoutSubject`, `payableBatchRows`,
  `batchTargetCurrency`, `batchPayoutSubstance` (the approval-binding helpers only
  it used);
- `lib/batch-parse.ts` (the browser's parser), `stashBatchDraft`, `takeBatchDraft`
  and the `?draft=1` hand-over through `sessionStorage`.

**Proposals of that kind already on file** are closed once by migration
`0072_retire_batch_payout_proposals`: those still open become `EXPIRED` with the
reason on the row; settled, anchored, rejected, failed, expired and reversed ones
are history and stay. Nothing is deleted. One that still reaches the approval
executor is recorded `SKIPPED` ("Approved and recorded, not executed ... use Batch
payouts ... Nothing was sent", `RETIRED_KIND_REASON`) and spends its approval once,
never "re-authorize".

**Not changed.** The `step_up_codes` table keeps its check constraint from
`0022`, which still lists `BATCH_PAYOUT`: a constraint that allows one more value
than the code writes is harmless, and narrowing it would need the old rows removed
first. Short-lived codes are the only rows that could carry it. `lib/policy/limits.ts`
still accepts a `'batch'` kind for a minimum; nothing passes it.

In a USDC-only launch (`LAUNCH_SCOPE=stablecoin`) Zeke used to refuse any message
containing "batch" with "payout runs are not open". A batch from the business's own
wallet is USDC, so it is open: the words "batch", "payroll" and "pay everyone" are no
longer scoped out, and Zeke points to the sheet. Netting, internal transfers and
conversions still are.

## Not done

- **A staff member's batch is not paid inside their rule.** A batch is many
  payments in one transaction; the single-payment path (`staff_rule_payment`,
  `docs/v2/phase3-staff-in-rule.md`) has no batch form, and building one changes the
  shape the owners' devices check. It needs the transaction builder, the shape
  check and a dry run, and the owners' sign-off on the rule's per-payment model for
  batches. **No Move change is needed**: `splash_spend::pay_intent` is already called
  once per payment. Until then the card marks the rows and the owners sign.
- **The floating Zeke does not carry a sheet card to the Zeke page** when its expand
  button is pressed (a card holds payee names and amounts; `thread-handoff.ts` keeps
  those out of memory it hands over). The sheet is attached again there.
- **No `.xls`** (the legacy binary format) and no `.numbers`/`.ods`; the spreadsheet
  reader reads `.xlsx` only.
- **No live-model test of the column mapper.** It is tested against stubs; with a
  key it runs the same checks on whatever the model answers.

## Tests

- `tests/zeke-sheet-ingest.test.mjs`: the reader (hostile content, caps, a zip that
  expands, currency, the model's answer checked).
- `tests/zeke-sheet-ingest-fixes.test.mjs`: the independent review's findings on the
  reader (a cleared currency cell, hidden characters, columns a model chose, file
  names, supplier names), and that the reader's source holds no invisible character.
- `tests/zeke-sheet-review.test.mjs`: the table, unverified recipients, the rule,
  limits, tenants, production, preparing without a draw, replay and races, Zeke's
  words, the route's gates and the body cap.
- `tests/zeke-legacy-batch-removed.test.mjs`: the old path is gone, by search and by
  behaviour, and what happens to proposals on file.
