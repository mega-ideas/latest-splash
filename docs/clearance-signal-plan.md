# Clearance Signal — implementation plan (v4)

Source: `Splash-Clearance-Signal-Design-Handoff` (README-FIRST, IMPLEMENTATION-GUIDE, COPY-DECK, tokens/components CSS, 15 reference frames). This plan maps the existing app onto that system. Source-of-truth order, as the handoff states: existing verified business rules and backend contracts → implementation guide → tokens → page image → generated microcopy.

## What we keep from the handoff

- The creative idea: **Global Payment Clearance**. Every payment carries a serialized clearance record with six checkpoints — beneficiary · FX · policy · approval · execution · proof — that follows it from obligation to proof.
- Layout: 184px navigation sidebar on the dark foundation, 48px top bar, page header (32px title + one supporting line + one primary action), workspace + 400px inspector rail, 44px table rows, 1px dividers, flat opaque surfaces, no shadows except overlays.
- Copy deck headings, supporting lines, action verbs and the status vocabulary (Verified, Policy passed, Awaiting checker, Quote expiring, In transit, Reconciled, Review required, Blocked, Exception).
- Decision notes: "Creation does not move funds. Checker approval is required." / "Funds remain unexecuted while this case is open." / execution confirmation / expired quote.
- Motion rules: 120–180ms; animate route progress only on state change; never loop route lines or pulse statuses.

## What stays ours

- **Colour.** Palette v2, mapped onto the handoff's semantic roles (`styles/tokens.css`, "Clearance semantic layer"): foundation = ink-900, canvas = paper, raised = surface, subtle = surface-2, **signal (routes, selection edge, primary action) = teal-600**, hover = teal-500, selected tint = teal-100, verified = green, attention = amber, exception = red, data/analytical = teal-300. There is no orange and no iris; "machine decision" surfaces are expressed with mono type on surface-2, not a fifth hue.
- **Type.** Geist for interface, Geist Mono for evidence (IDs, timestamps, digests, FX, tabular amounts). Weights 400/500, 600 only for page titles.
- **Truth.** No "regulated in the United Kingdom", no FCA reference, no "14 corridors", no "99.98%". Corridors are USD → PHP and USD → IDR, staggered; partner labels stay generic; "no customer funds until MFCA activation"; treasury shows availability and obligations, never a rate on the liquidity page.
- **Routes.** `/dashboard/*` remains the app root (auth, tests, links). `/app/*` from the handoff becomes an alias that redirects.

## Page map (handoff → existing)

| Handoff | Route | Built from |
|---|---|---|
| Clearance board | `/dashboard` | transfers (D7 state machine), proposals, treasury snapshot, corridors |
| Payments | `/dashboard/payments` (receipts/history/transfers fold in) | `/api/transfers`, URL-param filters, inspector = clearance record |
| New payment | `/dashboard/send` | existing 5-step wizard → Beneficiary · Amount · Route · Review (quote TTL 30s = freshness/expiry) |
| Beneficiaries | `/dashboard/recipients` | `/api/recipients` + KYB status + payment history |
| Liquidity | `/dashboard/treasury` | `/api/treasury` (available, scheduled outflows, buffer) — no rate figure |
| Routes | `/dashboard/routes` (new) | `lib/network` corridors + `lib/fx/corridors` + comparison baselines |
| Reconciliation | `/dashboard/reconciliation` (new) | transfer status history (partner), ledger entries (internal), Sui digest (network) |
| Approvals | `/dashboard/approvals` | existing real path `POST /api/proposals/[id]/submit` |
| Policy | `/dashboard/policy` (new) | operating settings rendered as IF/THEN; edits stay in Settings |
| Compliance | `/dashboard/compliance` (new) | KYB gate state, beneficiary screening, blocked/returned payments |
| Audit log | `/dashboard/audit` (new) | product events (hashed actors), transfer audit records |
| Developers | `/dashboard/developers` (new) | `/docs` content + sandbox; API keys roadmap-chipped |
| Integrations | `/dashboard/integrations` (new) | network profile, rails, oracle/storage adapters |
| Landing | `/` | 10 sections; hero = real HTML clearance strip for USD → PHP |

## Build sequence

1. Tokens (semantic layer) + shell (sidebar, top bar, page header, workspace, inspector, table, status, checkpoint line, evidence list, buttons).
2. Clearance board with live data and every visual state.
3. Payments + New payment.
4. Beneficiaries, Liquidity, Routes.
5. Reconciliation, Approvals, Policy, Compliance, Audit.
6. Developers, Integrations.
7. Landing in the same language.
8. QA: keyboard, 360/768/1024/1440, loading/empty/error/permission states, axe.

## Acceptance (from the handoff, applied)

Three-second read (task, risk, next action); every amount with an ISO code and tabular numerals; every quote with source freshness and expiry; every recommendation with alternatives and why it won; approval separate from execution; maker cannot approve their own request; server-evaluated policy; attributable evidence; loading/empty/expired/blocked/offline/insufficient-liquidity/partner-outage/permission-denied states; one primary action in teal; status never by colour alone; visible focus; mobile approval without a desktop table; no glass, glow, gradient blobs, 3D coins, wallet language, bento filler or giant KPI cards.
