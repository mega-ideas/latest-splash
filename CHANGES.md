# v5 Clear Air palette (branch feat/v5-clear-air)

- Palette v3 "Clear Air" in `styles/tokens.css`: night foundation, air neutrals, beacon cobalt as the single signal colour, ember reserved for the wordmark full stop and two marketing eyebrows; v2 names kept as aliases so every surface re-skins. Dark mode retuned. See `docs/design-system.md` §9.
- Brand icons recoloured toward beacon (originals in git history).
- `scripts/check-copy.mjs` whitelist extended with the v3 hexes.

# v4 Clearance Signal (branch feat/v4-clearance-signal)

Adopts the "Global Payment Clearance" design handoff with our own branding (Palette v2, Geist, truthful copy). Plan and interpretation: `docs/clearance-signal-plan.md`; rejected handoff claims: `docs/claims-audit.md`.

## Foundation
- Semantic token layer in `styles/tokens.css` (surfaces, signal, state, borders, shell dimensions, durations) over the unchanged Palette v2.
- Shell primitives in `components/shell`: StatusLabel, ClearanceProgress (B · FX · POL · APP · EXE · PRO), EvidenceList, DataTable, Inspector, PageHeader/Workspace/SummaryStrip/GroupHeading. `components/system` primitives restyled flat (12px radius, 1px dividers, mono labels).
- Clearance view model `lib/payments/clearance.ts`; code-first money formatting `lib/money.ts`.
- `/dashboard/*` is the app root; `/app/*` redirects (`next.config.ts`). Sidebar regrouped Operate / Govern / Build.

## Pages
- Clearance board (`/dashboard`), Payments (URL-param filters, CSV, inspector), Beneficiaries, Liquidity (no rate figure; execution gated), Routes, Reconciliation (three-way match), Approvals (real submit path kept; why-required, maker/checker, quote expiry, immutable ids, confirmation note), Policy (IF/THEN from settings), Compliance, Audit log, Developers, Integrations.
- Receipt detail is the full-page clearance record (checkpoints, evidence timeline, settlement timeline, proof drawer; share/print/export kept).
- New payment: Beneficiary · Amount · Route · Review · Processing · Receipt. Route step compares the partner rail with reviewed baselines; only the partner rail executes. "Creation does not move funds. Checker approval is required." next to the primary action.
- Events API `GET /api/events` (org-scoped, `?days=`, `?name=`).

## Landing
- `components/landing-v3`: dark nav, hero with a real HTML clearance strip (KUL → MNL, USD 5,000.00 → PHP, checkpoints, effective FX, cost, delivery, freshness, live state), proof band, operating model, route comparison, corridor atlas, governance, three-way reconciliation, developers, final CTA. Motion held still under `prefers-reduced-motion`.

## Gates
- `tsc`, `eslint`, `check-copy`, `test:oxwal` green. axe (WCAG 2.1 AA) clean on `/`, Beneficiaries, Approvals, Liquidity, New payment, Payments after contrast fixes. Keyboard: register row → Enter opens the inspector, focus lands on its title, Escape closes and restores focus to the row. No horizontal overflow at 375.

# v3 mainnet redesign (branch feat/v3-mainnet-redesign)

## Phase 4 — Approvals · Recipients · Treasury
- `/dashboard/approvals`: policy cards from operating settings, queue + history from `/api/proposals` (`?scope=history`), approve/reject through the one real path (`POST /api/proposals/[id]/submit`) with optional reason, aria-live decisions, mobile bottom bar.
- Recipients and Treasury rebuilt on the design system with truthful asset labels (USDC / USD claim / USDY) and roadmap-chipped projections.

## Phase 5 — 0xWal
- Resumable runs: `lib/agent/stream-hub.ts`, `GET /api/oxwal/[runId]?after=<seq>`, client `lib/oxwal/stream-client.ts` (backoff, dedupe, named failures). Thread persisted as text turns + proposal references only (`lib/oxwal/thread-store.ts`).
- Desk restyled; ActionCards read-only in-thread (approval only in Approvals); `FloatingIndicator` replaces `FloatingCopilot` (dashboard + desktop only; dot on the mobile 0xWal tab). Settings rebuilt as six tabs.

## Phase 6 — Landing v2
- `components/landing-v2/*` replaces `IsometricLanding` + cinematic hero; money-flow section per `docs/money-flow-spec.md`; hero shows live renders of the real product.

## Gates — accessibility and performance
- axe (WCAG 2.x A/AA) clean on Send, Batch, Approvals, 0xWal, Receipts, Login, the landing and Pricing; Lighthouse accessibility 100 on `/` and `/login`.
- Contrast amendment: `--text-muted` #59686F; 700 text shades for status text on tints (`--info-text / --ok-text / --warn-text`); ghost placeholders use dashed borders, never 40% opacity on text.
- Performance: legacy CSS split into `styles/legacy.css` (loaded only by app routes), providers scoped to app layouts, framer-motion removed from the landing, cinematic stylesheet retired, brand icon 616KB → 26KB, app icon 168KB → 22KB, root loading image 841px → 256px.
- `/metrics` answers a real 404 via `proxy.ts` unless `NEXT_PUBLIC_METRICS_LIVE=true`.
- `.github/workflows/ci.yml`: check:core + check-copy + eslint, tsc, test suites, Move packages untouched.

## Phase 7 — Public pages
- `/pricing` (illustrative ladder), `/rates` (Pyth mid vs executed; sandbox rows labelled until mainnet volume), `/trust` (restyled; required licensing sentence kept), `/roadmap` (two milestones, no volume promises), `/docs` (customer API surfaced; admin OpenAPI at `/api/openapi`), `/sandbox` (demo credentials flow), `/metrics` (404 unless `NEXT_PUBLIC_METRICS_LIVE=true`), `/login` (system auth shell; zkLogin providers disabled unless enabled), `/receipt/[token]` (tokens, statement-descriptor explainer, never indexed).
- New env flags: `NEXT_PUBLIC_METRICS_LIVE`, `RATES_HAVE_VOLUME`.

# Phase 1 Upgrade Log

## P0-1

- Added the shared Phase 1 domain store, transfer audit history, delivery tiers,
  invoices, ledger entries, sweep jobs, rate holds, and demo seed model.
- Added the mock AES-GCM Seal adapter with access policies and a fail-closed live
  adapter placeholder.

## P0-2

- Rebuilt the Walrus adapter with ciphertext-only validation, mock round-trip
  storage, live publisher/aggregator support, and typed network failures.

## P0-3 / P0-4

- Added validated invoice APIs, Seal + Walrus document flow, a live invoice
  vault, secure pay-link creation, and issuer settlement confirmation.
- Added the public bank-transfer payment request and counterparty acquisition
  flow with payer recipient creation, KYB-invite stub, and analytics summary.

## P0-5 / P0-6

- Added the three-rung recipient delivery ladder to the send wizard and persisted
  the selected delivery tier through authorization.
- Added the PDAX adapter, settlement-completion sweep engine, stored-balance
  credits, paired ledger entries, and held-duration API fields.

## P0-7

- Added the five-panel 0xWal invoice-to-payment workspace, access checks,
  extraction recommendation route, invoice-prefilled transfer handoff, and chat link.

## P0-8

- Added linked audit-trail views with Walrus retrieval, Seal decryption, document
  hash verification, Seal allowlist and extraction evidence, Sui proof, sweep proof,
  and full status history.

## P0-9

- Added the compliance-copy CI guard, removed hardcoded visible treasury-rate
  defaults, removed the static nav yield badge, and made treasury execution fail
  closed in both the API and interface with the required projection disclosure.

## P0-10

- Completed the exact demo dataset across invoices, all three recipient tiers,
  completed swept transfer and audit chain, Cebu stored balance, and active PHP
  rate hold; wired recipients to the live store and applied DEMO badges.

## P1-1

- Added privacy-bounded MemWal behavior recall cards to the operating desk and
  0xWal workspace, with safe demo behavior seeds and no PII-bearing memories.

## P1-2

- Added live open-invoice batch recommendations to 0xWal, with corridor-aware
  savings estimates and one-click pre-staging in the batch compliance desk.

## P1-3

- Added server-owned 48-hour rate holds, an active-hold countdown desk, and a
  quote-step workflow that creates and reuses a selected hold with authorization.

## P1-4

- Replaced the dashboard's first generic metric with a live 0xWal operating
  summary for detected invoices, same-corridor batchability, and approval work.

## P1-5

- Added full-store CSV and JSON reconciliation exports with deterministic
  accounting fields and dated `splash-reconciliation-{yyyymmdd}` filenames.

## P1-6

- Added a $5,000 sweep-versus-hold simulator that separates fees removed by
  internal netting from fees relocated to the eventual external payout.

## QA

- Deduplicated MemWal recall cards and safely backfilled missing behavior slots
  to prevent duplicate React keys in the operating desk.
- Moved corridor batch prefill behind the initial render to keep server and
  client summary counts identical while preserving one-click batch staging.
- Added a client-side MemWal normalization boundary so repeated or malformed
  recalled behaviors cannot create duplicate React keys or duplicate cards.
