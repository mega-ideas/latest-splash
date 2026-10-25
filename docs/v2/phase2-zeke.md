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
| getCounterparty, getInvoice | READ | Read a record of the session org (or the sample workspace) |
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

- **Money-moving** (send, pay, transfer, prepare a payment or batch, allocate,
  sweep or redeem treasury): Zeke opens the turn with the statement, **every
  time**, before any tool runs: "I can prepare this payment, but I can't
  approve or send it. A person on your team approves it, and it is signed from
  your Splash Wallet." Batches and treasury moves have their own noun. A
  forged history cannot remove it.
- **A money tool the classifier did not foresee** ("yes, go ahead", then the
  model calls `proposePayment`): the statement is inserted just before that
  tool's event, once per turn. A recipient draft and a rename are not money
  tools.
- **Read-only** (balances, receipts, history, "what did we pay"): the
  read-only statement **once per sign-in session**.

Each statement arrives as a `notice` event followed by its text as `delta`s, so
it is in the thread and in the history the client sends back.

## 3. Once per session

"Once" is recorded on the server, in `zeke_session_notices` (migration 0049):
one row per org, session and notice, and the primary key is the "once" — a
claim is an insert that lands or conflicts, so two tabs, two instances or a
retried request get one winner. The session key is a SHA-256 of the signed
session's email and mint time, derived by the route from the verified cookie
(a new sign-in is a new session; the email is not stored). The thread history
is checked first, and is the only record when there is no session key.

Rows older than 31 days are pruned as claims are made.

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
  sanctions-clear counterparties.
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
