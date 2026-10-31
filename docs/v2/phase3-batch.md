# v2 Phase 3, brief 5.6: Batch payouts

`/dashboard/batch` pays up to 20 recipients in **one Sui transaction the owners
sign once**. The page is a stepper: **Upload, Review rows, Approve, Send,
Receipts**, with a **How it works** button that opens the same pop-up as
Transfer (`components/transfer/ui.tsx` `Modal`: blurred backdrop, close X,
Escape).

Code: `components/batch/` (the page), `lib/batch/sheet.ts` (the sheet, pure),
`lib/batch/file.ts` (reading a file in the browser),
`lib/server/wallet-batches.ts` (review, create, start the signatures),
`lib/server/batch-receipts.ts`, `lib/server/wallet-batches-route.ts`,
`app/api/wallet/batches/*`, `payBatchFromWalletTx` in
`lib/server/sui-v2-builders.ts`, `requestWalletBatch` in
`lib/server/business-wallet.ts`, the `wallet_batch` signing purpose
(`wallet-signing.ts`, `payment-compliance-gate.ts` `batchBeforeSign`). Migration
`0065` (`wallet_batches`, `wallet_batch_rows`, and the purpose list).

## What was removed

The old desk screened rows **in the browser** ("No list match in dev screen"),
authorised with a typed authenticator code, settled through the v1 custody
batch (a payout-run route over a shared pool) and said things Splash cannot
back: a cheaper FX rate on netted rows, a "merkle-rooted receipt", off-peak
window pricing, "Tier 1 limits · RM 20k / transfer" next to USD amounts, and
the settlement-engine container. All of it is gone from the page, and the
v1 custody route itself is removed (see "The v1 custody batch is removed").
There is **one currency**: every amount is USDC. A
cell with a currency sign or code ("RM 20k", "$5,000", "USD 100", "20k") is
refused rather than read as a number.

## The five steps

| Step | What it does | Where the rule lives |
|---|---|---|
| 1 Upload | A CSV or Excel file, rows pasted from a spreadsheet, or one blank row. Three columns: `recipient`, `amount`, `reference`. Up to 20 rows. Read in the browser; cells are kept exactly as written. Zeke's uploaded sheet arrives here as rows (`?draft=1`). | `lib/batch/sheet.ts`, `lib/batch/file.ts` |
| 2 Review rows | Every row on its own: the cells, **the recipient** (a name or wallet address the business **saved**, or a business on Splash by its registered name), **the screening** (a fresh CLEAR, v2 §4.6), **the recipient's own rule** (a wallet proven, v2 §4.7), the fee from the schedule on chain for the kind the payee is paid as, duplicates, the business's own wallet and Splash's addresses. A row that cannot be paid says why, in words, and can be fixed or removed. The wallet's shortfall is shown. Continue is open only when every row is cleared. | `reviewBatch` |
| 3 Approve | **Owners**: the batch becomes one signing request for the owners' multisig; each owner's device decodes the exact bytes itself (`reviewOnDevice`), is shown every payment and a transaction code, checks them against the batch that was approved (`differsFromApprovedBatch`), and signs with their own passkey. **Staff** prepare the batch; the owners are told, and an owner starts the signatures. **Run later** (scheduled through `splash_spend`, an owner naming the executor) is **not switched on** (`BATCH_SCHEDULE_WIRED = false`): the page says so and `{ schedule: true }` answers `409 schedule_not_wired`. | `createBatch`, `startBatchSigning`, `SignPanel` |
| 4 Send | At the threshold Splash submits the transaction. The page asks every few seconds and goes on the moment the batch is paid. | `StepSend.tsx` |
| 5 Receipts | One receipt per payment (receipt no., payee, amount, Splash's fee as the chain charged it, who signed, the transaction), the batch totals, a CSV for the accountant and the explorer link. | `batchReceiptsFor` |

## What is trusted, and what is not

- **A sheet is untrusted data.** A row can only *name* a recipient the business
  already saved (or a Splash business by registered name). It can never
  introduce a payee, an account, an address that is not saved, or a fee. An
  address in a cell that is not a saved recipient is `recipient_not_saved`; text
  that tries to give instructions is `recipient_not_found`. Control and
  bidirectional characters are removed from every cell. The server takes three
  fields per row and drops the rest (`sheetRowsFromBody`).
- **The server checks again.** The review the page shows is not believed: the
  batch is reviewed again when it is created and again when the signatures are
  started (a recipient that changed, was removed, or is no longer cleared stops
  it, `recipient_changed`; a fee that rose is `fee_changed`).
- **All or nothing.** The batch is one transaction. One bad row is
  `422 rows_have_errors` with every row's own answer, and nothing is stored.
- **Who is not in a batch.** A bank account (paid with a bank payout, which tells
  the partner first, `use_payout_route`), an exchange account (its Travel Rule
  message is per payment), and USDC on another chain. The builder refuses the
  kinds too (`bank_payout_not_in_batch`, `cross_chain_not_built`), and so does
  the shape check and the gate before each signature.

## The transaction

`payBatchFromWalletTx`: for each row, the five commands of a single payment
(withdraw principal plus its fee bound, open the intent, pay it, anchor the
receipt, delete the finished intent), in the order of the rows, with one input
per shared object. Each row has its own payment reference
(`sha256("splash-batch-row" | org | intent id | position)`), so each is its own
intent on chain, once. All the anchors carry the batch's one sealed audit bundle.

`assertPurposeShape('wallet_batch')` refuses the request unless the bytes are
**exactly** the stored rows: the same number of payments, each tied to its own
withdrawal and intent, to the row's recipient, amount, kind and fee bound.
`openSigningRequest` also simulates the bytes (a dry run), so an overdrawn
wallet or a failing intent is refused before anyone is asked to sign (a batch too
large for one transaction is told to split it). Each owner's device runs the same
shape rule on the transaction's own bytes (`differsFromApprovedBatch`): exactly five
commands per approved payment in order, each paid from its own withdrawal and
intent, the withdrawal equal to the amount plus the fee bound, no bank, other
chain or exchange payment, and the withdrawn total equal to the approved total.

## Fees (Amendment A1)

Splash's fee on each row is read from the schedule on chain for the kind the
payee is paid as (`deps.splashFee`; free between Splash businesses). The total
shown is the batch's fee bound: the client sends it back as `maxFeeMinor`; below
the real fee is `409 fee_changed` with the new fee, above the 1% ceiling is
`400 fee_above_ceiling`. Each row's `max_fee` signed is that row's own fee. No
penalty or late fee exists, and no partner or Circle fee arises on a wallet
payment, so none is shown. The page types no rate (`check:fees`).

## Idempotency

The batch's intent id is the `Idempotency-Key` (8 to 80 letters, digits, `-`,
`_`), unique per business. A retry is answered **first**, from the stored batch,
before anything about the world is read again: the same key with the same cells
(recipient, amount, reference, in the same order, normalised) answers the batch
already made even after a recipient was added, a fee moved, the balance dropped
or the batch settled. A changed fee bound does not make it another batch; the same
key with other cells is `409 idempotency_key_reused`; requests racing on one key
make one batch and one signing request. Starting the signatures twice opens one
request, and a request whose link to its batch failed to save is found again by
its dedupe key (`batch:<id>`). A request that fails after the rows were stored
leaves no batch under the key. The page makes a new intent id whenever the sheet
changes.

**The same sheet under a new intent id is a new batch on purpose, so it is not
silent.** The review compares every row (address, amount, reference) with the rows
of this business's batches of the last 30 days that have not failed or lapsed. A
repeat is shown on its row, and the batch is made only when the person confirms
(`confirmDuplicates`, else `409 duplicate_of_earlier_batch`). Batches already out
for signatures are counted against the wallet balance of the next one. A Splash
business a sheet names only by its registered name is shown as a new payee, with
its full address and country, and is paid only once confirmed
(`confirmNewPayees`, else `409 new_payee_needs_confirmation`). The unique payment
reference per business only stops one row being stored twice.

## Tenants and roles

Every route goes through `batchRoute` → `walletRoute`: a signed-in customer, the
org from the **session** (`requireSessionAccount`), their own membership, and the
live wallet context for that org only. Nothing reads an org, an account or a
role from the request. Another business's batch, recipient or receipt reads as
absent (404, `recipient_not_found`). Owners and staff (MAKER, APPROVER) review and
prepare; only an owner starts the signatures; a viewer can do neither.

## Fail closed in production

- The sealed audit bundle is made by the server and fails closed
  (`record_unavailable`, 503): a sandbox Seal policy or Walrus blob is refused, and
  nothing is stored or asked of the owners.
- A row is cleared only by a **provider's** answer: in production a sandbox CLEAR
  on file is no clearance, and a row is refused. The same check runs again before
  each signature (`batchBeforeSign`), naming the payment ("Payment 2 of 5: …"),
  together with the wallet's own address and Splash's own addresses read now.
- No verdict, reference or number is made up by the page: screening, fees,
  balances and receipts are all the server's.

## Receipts

`GET /api/wallet/batches/:id/receipts` (JSON) and `?format=csv`. Each payment's
fee is the one the chain charged (the executed transaction's `FeeCharged`
events, one per payment, in order). A batch whose transaction cannot be read, or
whose events cannot be matched to the rows (for example a payment that charged
nothing and so emitted none), is **not final** and shows the bound, never a fee
given to the wrong row. No event at all reads as no fee, as for a single payment.
A batch nobody has started has no receipts (`409 batch_not_started`).
The CSV writes any cell a spreadsheet would run as a formula as text.

## The v1 custody batch is removed

Sky decided that the old custody path goes if nothing uses it. Nothing did, so
the payout-run route (a customer route that paid a payroll file out of the
shared `SettlementPool` with a typed authenticator code), its status route, its
store and repository, its run-key and second-factor helper, its size limits,
`recordBatchSettlementOnSui` with the `SUI_BATCH_SETTLEMENT_MODE` switch, the
staff "Batch payouts" table and the staff transaction list's batch rows, and the
tests that covered only them, are removed.

What was checked first: no page, component, script, scheduled job or document
called the route; the one internal caller was the approval queue's replay, which
only replayed a payload the route itself wrote (Zeke's batch drafts carry none);
and the path was already refused on mainnet in every mode (v2 D11).

What stays: the `batch_runs` table and its shipped migration `0011` (the
history is kept; no migration was added and none dropped), and the
`BATCH_PAYOUT` proposal kind with its approval-binding helpers, because Zeke's
drafts and approvals already on file carry it. Approving one now records it as
**not executed**, names Batch payouts as where payout runs are paid, claims no
payment, and spends the approval once (`BATCH_PAYOUT_RETIRED_REASON`).

## Not done, and why

- **Scheduled batches** (`splash_spend`, the operator named as executor by an
  owner approval) are not carried out: the staff-side and executor-side
  transactions have no builder on this server (the same reason as
  `STAFF_RULE_PAYMENTS_WIRED`, `docs/v2/phase3-transfer.md`). The page and the API
  say so. Nothing is scheduled.
- **No testnet dry run of a full batch.** The cap of 20 payments (100 commands) is
  conservative against the protocol's per-transaction limits and the sponsor's
  20,000,000 MIST gas budget; both must be checked with a simulation of a full
  batch before the cap or the budget is changed (phase 1 design, "Batches are
  atomic"). Only the model chain ran here.
- **A staff member's batch is not tied to the 10,000 USDC second-approval rule**:
  every batch is the owners' to sign, so the rule never applies.

## Tests

`tests/wallet-batches.test.mjs` (PGlite, the wallet world's model chain, software
passkeys): the sheet and its currency rule, the transaction and its limits,
review per row, the owners' request, signing to settled, the gate before each
signature, the shape check against swapped, added and dropped payments, the fee,
all-or-nothing, idempotency and racing, staff and owners, a scheduled batch,
tenants, production, and the receipts. `tests/batch-page.test.mjs`: the page's
source, the copy rules, the routes' gate, and the device's check of a batch.
