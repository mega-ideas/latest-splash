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

## 2a. Zeke never says money moved

Zeke cannot send, approve or sign, so a sentence that says money **has been or
is being** sent, paid, transferred or done is false whatever the model meant
by it (a prompt-injected invoice can ask for exactly that). The prompt says so
("Never say that money has been, was or is being sent..."), but the control is
code: `guardCompletionClaims` in `lib/agent/oxwal.ts`.

- **Where.** `runOxwalAgent` holds the turn's own words until it is known
  whether the turn moved money (a money tool, a proposal, a prepared
  transfer) and whether a draft is waiting: they are released when a proposal
  or prepared transfer arrives (so what led up to a card still comes before
  it) and at the end of the turn. They go out unchanged (the same pieces) or
  with the claiming sentences removed, and the fixed line is said once. The limitation statement, the first-recipient nudge and every other
  notice are Splash's own fixed words and are not part of this.
- **Which turns.** `moneyTurnLevel` and what the turn did decide:
  - *strict*: the classifier says money-moving, or the turn called a money
    tool or produced a proposal or prepared transfer, or it is a short reply
    ("yes, go ahead", "did it go through?", "status") in a thread about
    money. Every claim is removed.
  - *topic*: the message talks about payments (history, how to pay, in the
    languages above) without moving any. A claim is removed unless the
    sentence is dated or points at a record ("Acme was paid 500 USDC on 3
    October"), and a bare "Done!" is just a word.
  - *none*: anything else. The reply is never touched, so "Done! I will go by
    Ada" on a rename stays.
  The thread is client state: it can only move a turn from none to strict,
  never the other way.
- **What is a claim.** A sentence that says it was done ("Paid!", "Sent",
  "Done, I transferred it", "I've paid Acme", "It has been sent", "The payment
  went through", "Payment successful"), is being done ("I'm sending it now",
  "on its way", "processing your payment") or was approved or signed by Zeke.
  Read the way a person reads it: compatibility forms, look-alike Cyrillic and
  Greek letters, small caps, accents, hidden and zero-width characters,
  spaced, dotted or hyphenated letters, digits for letters, stretched words
  and markdown all fold to the word. The same claims are caught in Indonesian,
  Malay, Tagalog, Vietnamese, Thai, Chinese, Japanese, Korean, Spanish, French,
  Portuguese, German, Italian, Dutch, Turkish, Russian, Arabic and Hindi.
- **What is not.** A negation in the same clause ("has not been sent",
  "nothing was paid"), a condition or a modal ("once approved it will be
  sent", "can be sent", "if it had been sent"), a question, and Splash's own
  copy (the limitation statement, the proposal's words). A sentence is dropped
  whole: a claim tucked into reassurance ("Paid, and no further steps are
  needed") goes with the reassurance.
- **The fixed line.** Where claims were removed, the reply ends with
  "Nothing has been sent. It is waiting for approval." when a payment was
  prepared this turn, and with "I haven't sent anything. I can't approve or
  send payments, so a person on your team does that." when none was, so the
  line never promises an approval that does not exist. A reply with no claim
  gets no extra line.
- **Deterministic and idempotent.** No model reads the model, nothing reads
  the environment, and the same text gives the same answer every time; the
  guard's own output is a fixed point. `tests/zeke-completion-guard.test.mjs`
  covers hostile phrasing, other languages, truthful sentences that must
  stay, turns that must not be touched, two turns at once, and production.

The opening message and the Zeke page header keep the fixed limit sentence.

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

- Invoice and counterparty free text is tagged `trusted: false`, and text that
  reads like an instruction raises an `UNTRUSTED_INSTRUCTION` warning
  (`scanUntrustedText`). The text is normalised first (full-width and
  look-alike forms, zero-width and control characters), then checked for
  override wording, system-style prefixes, a changed payee or bank, "pay to"
  phrasings, tool names, IBAN-like and long account numbers and wallet
  addresses. The warning is advice for the reader; the payee and amount never
  come from this text whether or not it is flagged. The payee comes only from a verified
  counterparty id the person named, the amount from the person or the
  invoice's amount field, never from a memo.
- A payment drafted against an invoice is bound to it in code
  (`proposePayment`). The counterparty must be the business named on the
  invoice (issuer or named payer) and the amount must equal the invoice's;
  otherwise the draft is refused with the reason, not flagged for the approver
  to catch. On the model path, an invoice that carried a warning and was read
  earlier in the same turn is bound to any `proposePayment` the model makes,
  even if the model leaves the invoice id out. A partial payment is drafted
  without an invoice. Scan hits also cover leetspeak, spaced letters,
  Cyrillic/Greek look-alikes, dashed account numbers, SWIFT/BIC and crypto
  wording, and the warning labels the excerpt "Text from the invoice or
  counterparty, not from Splash".
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
