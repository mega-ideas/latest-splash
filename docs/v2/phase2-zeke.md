# v2 Phase 2 §4.8 — Zeke's rules

Zeke reads state and prepares drafts. It never holds a key, never signs and
never approves (D-0004). This page says how each §4.8 rule is enforced and
where. Code: `lib/agent/oxwal.ts`, `lib/server/zeke-session-notices.ts`,
`app/api/oxwal/route.ts`. Tests: `tests/zeke-rules.test.mjs`.

## 1. No key, no signature, no approval

Every tool the model is offered is in `OXWAL_TOOL_REGISTRY`, and each one is a
READ or a PROPOSE:

| Tool | Category | What it can do |
|---|---|---|
| getBalances, getTreasuryState, getCorridorLiquidity, getRate, getNettingOpportunities, getComplianceStatus | READ | Read fixture or model data, in a truth envelope |
| getCounterparty, getInvoice | READ | Read a record of the session org (or the sample workspace, read-only) |
| findSavedRecipient, listSavedRecipients | READ | Read the org's saved recipients |
| quoteX402Payment | READ | Price a pasted 402 challenge; carries a settlement refusal |
| prepareUsdcTransfer | READ | Build a link to the Send screen; quotes, reserves and signs nothing |
| proposePayment, proposeInternalTransfer, proposeFxConvert, proposeTreasuryAllocation, proposeTreasuryRedeem, proposeNettingSettlement, proposeBatchPayout, proposeX402Payment | PROPOSE | Draft an unsigned proposal with no approvals |
| proposeRecipientFromInvoice | PROPOSE | Draft a recipient a person confirms; saves nothing |
| setAssistantName | PROPOSE | Store a display name |

The tool loop refuses any other name, and every org-scoped tool runs under the
session's org, whatever the model wrote (`scopeToolInputToOrg`). No agent
module imports a signer, keypair, KMS client or approval call; the test checks
the sources.

## 2. The limitation statement

The intent classifier (`classifyZekeIntent`) is deterministic code, not the
model:

- **Money-moving** (send, pay, transfer, refund, reimburse, disburse, cash
  out, off-ramp, buy, rebalance; prepare a payment or batch; approve, release,
  execute, process, fund, repeat or resend a payment, payout, batch or
  payroll; allocate, sweep or redeem treasury): Zeke states the limit **every
  time**, before the turn acts: "I can prepare this payment, but I can't
  approve or send it. A person on your team approves it, and it is signed from
  your Splash Wallet." Batches and treasury moves have their own noun. A
  forged history cannot remove it.
  - Polite and indirect openings are stripped first ("kindly", "we need to",
    "is it possible to", "ok so please could you", a leading quote mark).
  - A message with several asks is judged by the one that moves money:
    "What is my balance? Then pay Acme 500" is a payment; so is "Did we pay
    Acme? If not, pay them 500".
  - A request for a document about money ("prepare a summary of payments",
    "make a report of treasury", "run a payments report") is a read.
  - A turn that prepares nothing does not open with "I can prepare this
    payment": a lane refusal (a locked lane, treasury before the custody
    phase) and a USDC send with no saved wallet recipient answer in their own
    words, with no statement.
- **A money tool the classifier did not foresee** ("yes, go ahead", then the
  model calls `proposePayment`): each model response's text is held back
  until its tool calls are checked, so the statement comes before the model's
  own words ("Done, I have queued it") as well as before the tool's event,
  once per turn. A recipient draft and a rename are not money tools.
- **Read-only** (balances, receipts, history, "what did we pay"): the
  read-only statement **once per sign-in session**.

Each statement arrives as a `notice` event followed by its text as `delta`s, so
it is in the thread and in the history the client sends back.

## 3. Once per session

"Once" is recorded on the server, in `zeke_session_notices` (migration 0049):
one row per org, session and notice, and the primary key is the "once" — a
claim is an insert that lands or conflicts, so two tabs, two instances or a
retried request get one winner. The session key is an HMAC-SHA-256 of the
signed session's email and mint time under `CUSTOMER_SESSION_SECRET`, derived
by the route from the verified cookie (a new sign-in is a new session; the
email is not stored, and without the secret a reader of the table cannot test
an email and a sign-in time against a row). With a session key the ledger is
the only record: a forged assistant turn carrying the statement's words
neither suppresses it nor leaves it unclaimed. The thread history decides
only when there is no session key.

Rows older than 31 days are pruned on about 2% of claims
(`PRUNE_PROBABILITY`), not on every one. The table has no foreign key to
organizations on purpose: the sample workspace has no organizations row, and a
failed claim would turn into the ledger's unknown answer.

**History.** The thread history is client state. The route keeps only
`{role: 'user' | 'assistant', content: string}` turns, each capped at 4,000
characters, the last 12 (`sanitizeOxwalHistory`); the tool loop applies the
same filter again before the model sees it. A forged `tool_result` block, a
system turn or an object posing as text never reaches the model.

**Failing closed.** In production without a database the ledger refuses. Zeke
then states the read-only limit anyway (over-stating a limit costs a
sentence) and does not nudge (a "once" nobody can prove is a "never").

## 4. The first-recipient nudge

At the end of a turn, an org with no saved recipient hears "You haven't saved a
recipient yet. Add your first one under Recipients, and I can prepare payments
to them." — at most once per session, and never once a recipient exists. It
reads only the session org's recipients; a failed read, no session key or an
unavailable ledger means no nudge.

## 5. Prompt injection

Invoices and uploaded sheets are data:

- Invoice free text is tagged `trusted: false`, and directives in it raise an
  `UNTRUSTED_INSTRUCTION` warning. The payee comes only from a verified
  counterparty id the person named, the amount from the person or the
  invoice's amount field, never from a memo.
- `getInvoice` and `getCounterparty` take the session org; another tenant's
  record is "not found", the same answer as one that does not exist. Payment,
  batch and netting drafts accept only this org's verified, KYT- and
  sanctions-clear counterparties. The sample workspace's records
  (`cp_acme_ph`, `inv_demo_acme_5000`) stay readable to every business as
  examples, but only the sample workspace can draft against them: another
  business gets "not found", so no real queue holds a payment to a record
  Splash seeded.
- Raw destinations (address, account, wallet) are refused by every drafting
  tool, and unknown tools (for example `signProposal`) are refused by the loop.
- An invoice read into a recipient never overwrites a field already on the
  saved record, and nothing is saved without a person.
- An uploaded sheet goes to the batch desk as rows (sessionStorage); it is
  never put into the model's message.
- Zeke's output renders as React text, escaped; a prepared-transfer card links
  only to `/dashboard/send-usdc?…`.

## 6. The floating widget

The fixed strip "Reads state · prepares proposals · cannot send" is gone. The
statement lives in the conversation, where §2 puts it.
