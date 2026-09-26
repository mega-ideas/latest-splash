# Splash product walkthrough

> This script describes the July 2026 testnet demo (pre-flight 2026-07-18). Steps other than the login line below may not match the current build.

Covers, in order: **1) Transfer · 2) Batch payout · 3) 0xWal · 4) Invoice loop · 5) Treasury.**
Login: accounts are rows in `users`. Sign up at `/signup`, open the verification link (with `EMAIL_TRANSPORT=console` it is printed in the server log), then a staff member grants a membership at `/admin/memberships`. On a production build, `/signup` answers 403 unless `CUSTOMER_SELF_SIGNUP_ENABLED=true`. Locally, `npm run dev:db` seeds `demo@acme.test` (and `live@acme.test`, `fresh@acme.test`) and prints their password on start; `docs/STABLECOIN-LANE.md` lists the same accounts. `CUSTOMER_EMAIL` / `CUSTOMER_PASSWORD` no longer exist: `lib/env.ts` refuses to boot while either is set.
Branch: `w9/type-color-discipline` (the polished surfaces — PR #3).

---

## Pre-flight — VERIFIED 2026-07-18 (day before demo)

Full rehearsal run on this branch, all live:

- ✅ **Real on-chain settlement WORKS.** `SUI_SETTLEMENT_MODE=live`; the §1
  scenario ($500 → Acme Manufacturing PH) ran AUTHORIZED→SETTLING→**DISBURSED
  in ~12s** with digest `GbWivrGc…` resolving **200 on testnet.suivision.xyz**.
  No `SUI_SETTLEMENT_MODE=simulate` needed. (Fallback if testnet is sick on the
  day: set `SUI_SETTLEMENT_MODE=simulate` + restart — flow completes with a
  labelled SIM_ receipt.)
- ✅ **0xWal answers with REAL Claude** (`source: "claude"` verified) — the API
  key has credits. Scripted intents also verified. If the API misbehaves on the
  day, add `OXWAL_FORCE_LOCAL=true` to `.env.local` + restart: deterministic
  planner, every scripted flow still works.
- ✅ Every route in the script returns 200 after login; demo files exist
  (`public/batch-payout-all-clear.csv`, `samples/invoice-acme-ph-5000.html`).
- ✅ Share-link receipt opens logged-out with the live digest; treasury shows the
  collapsed "Where your money sits" panel; timeline shows real per-stage
  timestamps.
- ℹ️ `NEXT_PUBLIC_DEMO_MODE` is **off**, so lists start sparse and every flow
  creates real records live (more convincing). Set it `=true` + restart only if
  you want pre-seeded dashboard numbers.

Boot: `npm run dev` (Node runs with `--use-system-ca` per package config).
Restart the dev server after any `.env.local` change.

### NEW since this script was written (the W9 upgrades — extra beats to show)

- **§1 Quote step** is now a comparison card: big mono amount, all-in fee with
  %, "Supplier receives", and a **Splash vs Fintech vs Bank wire strip**
  (labelled illustrative baseline) plus a maker-checker note reading your real
  approval threshold. Say: "and here's what this payment costs anywhere else."
- **§1 Status** is a human timeline — Payment approved → Funds converted →
  Sent to the Philippines → Delivered — with **real timestamps per stage**.
- **§1 Receipt** has a business face + collapsed "**Verify independently**"
  proof layer (Settlement record, Tamper-evident archive, network line), a
  "**PDF for your accountant**" button, and "**Share with supplier**" — click
  it, open the copied link in an incognito window: same receipt, no login.
  That incognito reveal is the strongest new wow moment.
- **§5 Treasury** ends with a one-line trust panel — click "Splash orchestrates
  — we never hold your funds." to unfold the Airwallex → PDAX·GCash →
  Splash partner path.

---

## 1 · Transfer  (Payments → Transfer)

**Goal:** one payout, USD in → PHP out, quote-locked, audit receipt.

1. Sidebar → **Transfer**.
2. **Beneficiary:** pick 🇵🇭 Philippines. Business name `Acme Manufacturing PH`,
   account `1234567890`. Amount `$500`. → **Continue to delivery**.
3. **Delivery:** choose **Bank payout** (0.70% corridor fee). → **Review quote**.
4. **Quote & Send:** point out the locked rate (≈56.42 PHP), fee ($8.50), recipient
   receives ≈27,730 PHP, 30-second quote hold. Tick the confirm box → **Send**.
5. **Provider deposit:** → **Continue with STRIPE**.
6. **Status:** the settlement steps stream (provider confirmed → Sui settlement →
   PH rail → recipient). 
   - With §B config/simulate: lands on **Receipt** with a digest.
   - Without: it will stop at "Settlement failed" — that's the missing contract
     config, not the UI. Use `SUI_SETTLEMENT_MODE=simulate` to demo the happy path.

**Talking point:** "Funded in USD, delivered in PHP, quote locked at signing, and
every step is an auditable receipt — no bank login ever enters Splash."

---

## 2 · Batch payout  (Payments → Batch Payout)

**Goal:** a payroll/vendor run — screen every row, authorize once.

1. Sidebar → **Batch Payout**.
2. Click **Click to upload CSV** and pick **`public/batch-payout-all-clear.csv`**
   (created for this demo — all 6 rows pass screening).
3. Every row shows **PASS** (AML, KYT amount, structuring, corridor, purpose). The
   summary reads **6 rows cleared, 0 review, 0 blocked**, cleared total ≈ $21,795.
   - Optional contrast: also drop the built-in sample (Download sample) to show
     rows going to **REVIEW/BLOCKED** — proves screening is real.
4. Enter any 6-digit code (e.g. `123456`) → **Authorize**.
5. The batch queues and settles.
   - With §B config/simulate: **SETTLED** with a digest / explorer links.
   - Without: **FAILED** on the missing compliance config (same fix as §1).

**Talking point:** "50 beneficiaries, one signed authorization, one reconciliation
entry — and bad rows are isolated before any value moves."

**CSV file:** `public/batch-payout-all-clear.csv` (also in `samples/`). Columns:
`name,address,country,purpose,amount`. Every amount ≤ $5,000, allowed corridor,
purpose set, distinct names → guaranteed all-PASS.

---

## 3 · 0xWal  (Payments → 0xWal, the default dashboard)

**Goal:** the conversational finance desk that prepares, never executes.

1. Sidebar → **0xWal** (or just land on the dashboard).
2. Type **`do a batch payout`** → 0xWal replies:
   *"I don't see a batch drafted yet — want to create one now?"* with how to start.
   (Deterministic — works regardless of AI credits.)
3. Type **`what can you read and prepare?`** → it lists its read + propose tools.
4. Click the **Review invoice** chip (`Pay invoice inv_demo_acme_5000 to cp_acme_ph`)
   → 0xWal streams activity lines (Reading invoice → Verifying counterparty →
   Preparing payment proposal) and drops an **unsigned Action Card** into the chat
   with impact table, simulation deltas, evidence (trusted/untrusted), and a
   "Approve or reject in the queue" note.
5. Point out the header stats climbing (Proposals / Approval) and the floating
   0xWal badge — it reminds you of pending approvals on any other page.
6. Click **Open queue** → see §3b.

### 3b · 0xWal control room (the Approval queue)

1. The **Approval queue** shows pending proposals with **Approve** / **Reject**.
2. Click **Approve** on a row → it clears to **"Approved & queued for settlement"**
   in *Recently resolved*, the Pending count drops, and a toast confirms. The
   dual-control row needs the second signature — shows the maker-checker split.
3. Click **Reject** on another → confirm dialog → it returns to the maker.

**Talking point:** "0xWal prepares unsigned proposals; a human approves in the
control room. The model never holds authority — approval is enforced outside it."

---

## 4 · Invoice loop  (Finance → Invoices → Inspection loop tab)

**Goal:** private invoice → encrypted proof on Walrus → route recommendation.

1. Sidebar → **Invoices**. Two tabs: **Invoice vault** and **Inspection loop**.
2. Open **Inspection loop**.
3. **Encrypted document:** upload **`samples/invoice-acme-ph-5000.html`** (open it
   first in a browser and "Save as PDF" if you want a PDF — the loop accepts either;
   the file becomes the encrypted Walrus blob). It reads Acme PH, $5,000, due Jun 28.
4. Watch the **release gate** rail fill: Invoice intake → **Walrus proof** (real
   blob id, `mode: live`) → Seal access → 0xWal draft.
5. Click **Extract and recommend route** → shows extracted facts + a route
   recommendation, marked **Approval required**.
6. Click a **Seal access** check — allowed identity passes, `unknown@org` fails closed.
7. **Open payment intent** → hands off to the Transfer flow (§1) with the invoice
   attached.

**Talking point:** "The invoice is Seal-encrypted and its proof is anchored on
Walrus — real, verifiable, 7-year retention — before any money is recommended."

**Files:** `samples/invoice-acme-ph-5000.html` (matches the loop's demo metadata).

---

## 5 · Treasury  (Finance → Treasury)  — Phase 0: gated, and says so

**Goal:** show that the product refuses to hold funds until it may.

Holding customer funds — a treasury balance, a stored balance, a sweep
account — is Phase 2 and needs a money-broking licence Splash does not hold.
The code cannot check a licence, so it checks the custody package: with
`SPLASH_CUSTODY_PACKAGE_ID` unset, `/api/treasury`, both treasury crons, a
`STORED_BALANCE` or `SWEEP_ACCOUNT` delivery, and a recipient set up for one
all answer the same plain 403 (`custody_not_licensed`). No demo balance and
no demo transaction is shown anywhere.

1. Sidebar → **Treasury**. The page reads **"Treasury arrives with our
   licence"**, names the licence, and shows no balances and no projections.
   The money-path panel below it still explains who holds what today.
2. Dashboard → the treasury card says the same thing in one line; its button
   reads **"When it arrives"**.
3. Ask 0xWal about yield or treasury — it answers with the same reason and
   never quotes a rate or a balance.
4. **Send → Delivery**: only `PAYOUT_ONLY` is accepted; a `STORED_BALANCE`
   request is refused before any recipient or intent is written.

**Talking point:** "We built the controls before the licence. The product
tells you what it is not allowed to do yet, in the words of the licence it
needs — nothing is modelled as if it were already held."

When the custody package is configured (Phase 2), the interactive walkthrough
returns: allocate, a cancellable withdrawal notice, and the trust line at the
bottom.

---

## One-line reset between runs
- 0xWal chat / queue state is per-tab — refresh to reset.
- Uploaded invoices persist; that's fine (shows history). Batch/transfer create new
  records each run.
