# Onboarding scope — the Stablecorp pattern, on Splash's machine

*Scoped 2026-09-23 against `8086269`. Nothing here is built; this is the plan.*

## The reference, in four beats

Stablecorp's onboarding (observed live and from the walkthrough recording):

1. **Register** with email; verification before anything counts.
2. **"How will you use Stablecorp?"** — one intent per account (Company /
   Payroll / Off-ramp), chosen from a comparison screen with a "BEST FOR"
   line and one CTA per card.
3. **Account Setup**, a five-step stepper with a breadcrumb (`Dashboard >
   Account`): Accept Terms → Choose Entity → Register Entity → Pay → Verify
   Business. Checkmarks for done, numbers for pending, each step titled and
   subtitled.
4. **A gated dashboard**: every money surface in the nav carries a padlock
   until setup completes. Only Account Setup, Referrals and Settings are
   open. Locked destinations show gentle empty states — *"No invite code
   yet. Finish setting up your account and your invite code appears here."*
   — never a dead click.

## What Splash already has

More of this machine exists than the reference needed to build. The scope
is mostly front-of-house.

| Piece | State | Where |
|---|---|---|
| Email signup with delivered verification, mailbox-owner-wins | **Shipped** (WS1) | `app/api/auth/signup`, `/verify-email` |
| zkLogin (Google), per-email workspace in `REGISTERED` | **Shipped** (v14) | `app/api/auth/zklogin`, `lib/auth/signup-org.ts` |
| KYB lifecycle state machine | **Shipped** | `lib/compliance/kyb-state.ts` — `REGISTERED → KYB_SUBMITTED → KYB_PROVIDER_APPROVED → KYB_ADMIN_APPROVED → ACTIVE`, plus `REJECTED`/`SUSPENDED` |
| Server-side money gate with per-state reason copy | **Shipped** | `lib/server/kyb-gate.ts`, `kybGateReason()` — `canMoveMoney()` is true only at `ACTIVE` |
| KYB submission surface (Sumsub + doc upload) and admin review console | **Shipped** | `app/settings/kyb`, `app/api/kyb/*`, `app/admin/(console)/kyb` |
| Approval threshold + dual-approval settings | **Shipped** (schema) | `org_settings.approval_threshold_usd`, `dual_approval_threshold_usd_micro` |
| Maker-checker membership grants that refuse unverified emails | **Shipped** (WS1) | `grantMembership` |
| Recipient creation with Phase-0 tier gate | **Shipped** (WS6) | `deliveryTierAllowed`, `PAYOUT_ONLY` |
| Dashboard nav shell | **Shipped**, ungated | `components/dashboard/DashboardShell.tsx` |
| Intent-per-workspace | **Missing** | — |
| Persisted terms acceptance | **Missing** — signup validates `accepted: z.literal(true)` and stores nothing | `app/api/auth/signup` |
| Setup stepper UI | **Missing** | — |
| Nav locks + locked empty states | **Missing** | — |

## The flow, screen by screen

### 1. Sign up — no change

Email + verification and zkLogin both land in a fresh workspace in
`REGISTERED`. Already exactly the reference's shape.

### 2. `/onboarding/intent` — "How will you use Splash?" *(new)*

One intent per workspace, chosen once, changeable later only in Settings.
Splash's honest options are not Stablecorp's:

| Intent | BEST FOR line | State |
|---|---|---|
| **Pay suppliers** | A business paying suppliers in the Philippines from USD | Live — the testnet corridor |
| **Collect and invoice** | A business raising invoices and collecting through pay links | Live |
| **Treasury** | Idle USD under an approval-gated posture | Roadmap — the card says so and offers "register interest", it does not pretend |

Stored as `organizations.intent` (nullable text; null = not chosen). A
signed-in user with no intent is redirected here from `/dashboard/*`; the
choice tailors which setup steps are emphasised and which nav group opens
first, and nothing else — it must never gate differently from the KYB
state, or the intent screen becomes a second source of truth.

### 3. `/dashboard/setup` — Account Setup *(new)*

Splash forms no entities and charges no formation fee, so the reference's
five steps become Splash's five:

| # | Step | Done when | Backed by |
|---|---|---|---|
| 1 | Accept terms | A `terms_acceptances` row for this user at the current version | **New table** |
| 2 | Business profile | Legal name, country, registration number on the org | Existing org fields, small form |
| 3 | Verify the business | `kybLifecycle` ≥ `KYB_SUBMITTED`; step shows in-review / approved / declined states | Existing `/settings/kyb` machinery, re-hosted in the step |
| 4 | Approvals | `approval_threshold_usd` confirmed; optionally a second approver invited (grant refuses unverified emails — already enforced) | Existing `org_settings`, memberships |
| 5 | First recipient *(skippable)* | ≥ 1 recipient, `PAYOUT_ONLY` | Existing recipients API |

**Stepper state is derived, never stored.** Each step computes done-ness
from the real records above; only step 1 needs new persistence. A stored
`onboarding_progress` column would drift from the truth the first time an
admin flips a KYB state, so there isn't one.

The stepper is the reference's grammar: checkmark for done, number for
pending, title + subtitle per step, back/continue, current step underlined.
Completion of steps 1–2 is the user's own pace; step 3's wait states show
`kybGateReason()` copy verbatim, so the stepper and the money routes can
never disagree about why something is blocked.

### 4. The gated dashboard *(rework of `DashboardShell`)*

The shell already renders grouped nav. Each item gains an unlock rule,
evaluated **server-side in the layout** from the same `kyb-gate` the money
routes use — the padlock is presentation; the routes stay the security.

| Nav item | Open when | Locked shows |
|---|---|---|
| Setup, Settings, Support | Always | — |
| Overview | Always (read-only; its numbers already respect the phase gates) | — |
| 0xWal | Always — it can prepare and explain, it cannot move money regardless | — |
| Invoices, Recipients | Terms accepted (step 1) | Padlock + "Finish setting up your account" |
| Transfer, Rate holds, Batch Payout, History | `canMoveMoney()` — i.e. `ACTIVE` | Padlock + `kybGateReason()` for the current state |
| Treasury | `ACTIVE` **and** custody phase enabled (existing `custodyPhaseEnabled()`) | Padlock + the custody-phase copy the routes already return |

Locked pages don't 404 and don't dead-click: the destination renders its
header and one empty-state card — icon, one sentence from the same reason
source, one button to the step that unblocks it. That is the reference's
"No invite code yet" pattern with Splash's own reasons.

No referrals page: Splash has no invite codes, and inventing a surface to
copy the reference would be decoration.

## Data and API changes

- Migration `0019`: `terms_acceptances` (user_id, org_id, version,
  accepted_at) and `organizations.intent` (nullable text). **No Move
  changes anywhere in this scope.**
- `POST /api/onboarding/terms` — writes the acceptance row; idempotent per
  version.
- `POST /api/onboarding/intent` — sets the org intent; refuses overwrite
  except from Settings.
- `GET /api/onboarding/state` — the derived stepper state in one call, so
  the shell and the stepper read the same computation. Server-computed in
  the layout for the nav locks; this endpoint exists for client refresh
  after in-page actions.

## Tests (red first, per house rule)

- Derived state: each step's done-ness from fixture rows; a KYB state
  flipped by the admin console immediately changes step 3 with no writes.
- The nav lock table above, asserted against the rendered shell for each
  `KybLifecycleState` — and a meta-assertion that the lock rule reads from
  `kyb-gate`, so the UI cannot invent its own gate.
- Terms: money routes refuse (`412` + reason) when no acceptance row exists
  even if KYB is `ACTIVE` — the new gate joins the server, not just the nav.
- Intent: `/dashboard/*` redirects to `/onboarding/intent` when null; the
  redirect never fires for `ACTIVE` orgs created before the migration
  (backfill `intent = 'pay'` for orgs with settled transfers, null for the
  rest — decided below).
- Locked pages render the empty state, never the data, for a blocked state.

## Sequencing

| PR | Contents | Size |
|---|---|---|
| 1 | Migration 0019, terms + intent APIs, terms server gate | S |
| 2 | Derived onboarding state + `/onboarding/intent` screen | M |
| 3 | `/dashboard/setup` stepper hosting the existing KYB + approvals surfaces | L |
| 4 | Nav locks + locked empty states across dashboard pages | M |
| 5 | Polish: stepper motion (reduced-motion-safe), mobile pass | S |

Each PR lands green on its own; the locks (PR4) ship only after the setup
path (PR3) exists, so nothing is ever locked without a door.

## Open decisions (yours)

1. **Intent options and names** — "Pay suppliers / Collect and invoice /
   Treasury" is my proposal; the third card can also be dropped entirely
   until custody phase exists.
2. **Backfill** for existing orgs: auto-`pay` for orgs with settled
   transfers, or force everyone through the intent screen once?
3. **0xWal placement** — I've left it unlocked (it cannot move money at any
   state, three independent gates already prove it). Locking it anyway
   would match the reference's look at the cost of hiding the safest demo
   surface. Which do you want?
4. **Terms version source** — a constant in `content/`, or served from
   `/terms-of-service` frontmatter so legal edits bump it?
