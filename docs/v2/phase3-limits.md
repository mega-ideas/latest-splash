# v2 Phase 3: Limits on automatic payments, and asking Splash for higher ones

Sky's decision: a business has default limits, and an owner can ask Splash for
higher ones. Splash's own changes keep their 24 hour notice; owners' own
changes stay instant; an owner **lowering** a limit is always instant and asks
nothing. Nothing here moves money and nothing under `move/` changed.

**Update, Sky's decision on how limits start (2 Nov 2026).** The round-three figures below
(2,000 / 5,000 / 20,000 USDC as the standard, and 10,000 / 50,000 / 500,000 as ceilings) are
replaced. A new business starts at **50,000 USDC a payment and 100,000 a day, with the monthly
figure worked out from its own answers**; they are **starting points, not ceilings**, and go up or
down on request and approval. Nothing existing is lowered or changed (migration 0086). See "How a
limit starts" and "Two people for a large grant" below; where the older text below disagrees, those
sections are the current rule.

| What | Where |
|---|---|
| Figures, the sanity maximum, the two-person lines, the words, the timing | `lib/limits/rules.ts` (pure, used by the page and the server) |
| The three questions and the formula | `lib/limits/start.ts` (pure) |
| The answers, starting a new business, "Ask for higher limits" | `lib/server/limit-start.ts`, `app/api/limits/answers/**`, `components/limits/StartQuestions.tsx` |
| The notices owners get | `lib/limits/notice.ts` |
| Every read and write | `lib/server/business-limits.ts` |
| Customer routes (one gate: the session) | `app/api/limits/**`, `lib/server/limits-route.ts` |
| Staff routes | `app/api/admin/limits/**` |
| Starts what is due, tells the owners | `app/api/cron/limit-changes` (every 15 minutes) |
| Settings, Limits | `components/settings/LimitsCard.tsx` |
| Operator console, Limit requests | `app/admin/(console)/limits`, `components/admin/AdminLimitRequests.tsx` |
| Tables | `business_limits`, `business_limit_requests` (migration 0078); `held_max`, the kept limits and the restore action (migration 0079); `business_limit_answers`, the first approval and the pinned rows (migration 0086) |
| Trail | `wallet_authority_events` (append-only), nine actions (`limit_answers_saved` and `limit_request_first_approved` are the two newest) |

## The four limits

| Limit | A new business starts at | Where it holds |
|---|---|---|
| One automatic payment | 50,000 USDC (or less, from its answers) | the allowance an owner asks for; every payment of an automatic run |
| In a day | 100,000 USDC (or less, from its answers) | the allowance; the daily limit automatic runs reserve against |
| In a month | 500,000 USDC with no answers; otherwise worked out from them, up to 500,000 | the allowance (the network holds its own rate); every automatic run, over the last 30 days |
| How long an allowance lasts | 90 days | the next allowance an owner gives |

**They are starting points, not ceilings.** A limit is asked for and granted above
the start (the request is the ordinary one, below). `LIMIT_SANITY_MAX` (1,000,000 a
payment, 10,000,000 a day, 100,000,000 a month) only catches a typo and is not a
policy; the length of an allowance keeps a true ceiling, a year (`ALLOWANCE_MAX_DAYS`).
The monthly start (500,000) is the round-three ceiling kept as the cap of the working
and as the start of a business with no answers: Sky gave the monthly figure as "worked
out from the business's answers", so this number is Splash's and needs Sky's eye.

**The second-approval line is not a limit here and is not lifted by one.** An automatic
payment above it (10,000 USDC by default, never more: `AUTO_APPROVAL_CEILING_MINOR`)
still waits for an owner, whatever the per-payment limit says, so a per-payment limit
of 50,000 does not let an automatic payment of 50,000 through. The page says so under
the per-payment request sheet (`askNote`) and beside the Controls block. Whether that line
should move with the new figures is Sky's and Sebastian's: it is the SpendPolicy's.

## How a limit starts

**Three plain questions**, asked of a new business in the setup page (the existing
onboarding, `components/onboarding/SetupStepper.tsx`: a card under the business profile,
not a step and gating nothing) and, for a business that has not answered, in Settings,
Limits (`components/limits/StartQuestions.tsx`):

1. How much do you expect to transfer each month? (USDC)
2. How many payments do you expect to make each week?
3. How much will your first transfer into your wallet be? (USDC)

**One pure function** (`proposeStart`, `lib/limits/start.ts`, `FORMULA_VERSION` 1) turns
them into proposed limits. Every step rounds up:

| Step | Rule |
|---|---|
| basis | the larger of the month and the first transfer in |
| monthly | half as much again as the basis, to two significant figures |
| average payment | the month divided by the payments in it (payments a week x 52 / 12) |
| per payment | twice the average payment, to two significant figures, never more than the month |
| daily | a tenth of the monthly figure, to two significant figures, never less than one payment, never more than the month |
| minimums | 100 USDC a payment, 500 a day, 2,000 a month (all below the old standard) so a small business can still pay an invoice |
| sanity | nothing is carried past `LIMIT_SANITY_MAX` |
| **the cap** | **the proposal is the working capped at the starting figures** (50,000 / 100,000 / 500,000). What the working asked for beyond them is kept as `wanted`; it is the staff reviewer's to see and the owner's to ask for. Nothing above the starting figures is ever granted by the function. |

Worked: 20,000 a month, 5 payments a week, 10,000 first: monthly 30,000, per payment 1,900,
daily 3,000. 2,000,000 a month, 20 a week, 500,000 first: wanted 47,000 / 300,000 /
3,000,000, proposal 47,000 / 100,000 / 500,000 (daily and monthly capped).

**What is an acceptable answer.** A plain number: `25000`, `25,000`, `$25,000`, `25k`,
`1.5m`, with an optional `USDC`; payments a week a whole number from 1 to 100,000. Zero,
negative, text, blank, half a payment, an exponent, a number past a trillion USDC, and
anything with a control, zero-width or direction character is refused **in words, per
answer, without repeating what was typed**, and nothing is saved. An answer is at most 40
characters and is refused, never cut (a cut number is a different number).

**What happens to the answers** (`saveLimitAnswers`, `lib/server/limit-start.ts`):

- Owners only (the Finance lead gets `owner_only`, anyone else `not_allowed`); the business
  and the person are the session's.
- The answers are saved with the proposal (`business_limit_answers`, one row per business),
  as the owner wrote them (cleaned, at most 40 characters), shown only as text. **They are
  never written to the trail, the logs, or a request's reason.** The trail line says only
  that answers were saved.
- A **new business** (no limits yet) is started at the proposal, once: three
  `business_limits` rows, source `starting`, `changed_by` `system:onboarding`, `held_max`
  equal to the value (going higher is a request), each with a `limit_change_applied` line.
  The claim is one statement, so a double click or two tabs start the limits once.
- A business that **already has limits** (every business made before this, below) is never
  changed by answering. It is shown "A new business like yours would start at ..." and can
  ask for it. Answering again later updates what staff see and never moves a limit that has
  started.

**The owners are told** on the Limits screen, in plain words: "We started you at 1,900 USDC
a payment, 3,000 USDC a day and 30,000 USDC a month because you told us you expect to move
about 20,000 USDC a month, in about 5 payments a week, and that your first transfer into your
wallet would be 10,000 USDC." Each limit's row carries its own sentence. If the working asked
for more than the start, it says so, with **Ask for higher limits**.

**Ask for higher limits** (`askForHigherFromAnswers`, `POST /api/limits/answers/ask`) is the
round-three request path, once per limit the answers wanted more of than the business has: an
owner asks, Splash staff decide, a 24 hour notice. The figures are read from the answers
stored for the business, never from the request; the reason is a fixed sentence with no
figure in it; the key is the answers and their version, so a double click asks once and new
answers are a new ask.

**Splash staff see** the answers and the proposal beside the request on the queue card, with
the business's KYB tier and state and its last 30 days of automatic payments (how many, the
total, the largest, the busiest day; payments that failed are not use).

## A business that already runs keeps what it runs on

(Migration 0086 supersedes the 0079 paragraph below for the standard figures: 0079's rule
stands, and now holds for every business.) **Migration 0086 gives every business that exists
a row for each limit at the figure it runs on today**: what 0079 kept, what an owner lowered,
and for everything else the old standard (2,000 / 5,000 / 20,000 USDC and 90 days), source
`raised`, `changed_by` `system:migration`, with a line on the trail whose `before` and
`after` are the same figure. Nothing is lowered, raised or changed. The new starting figures
apply to businesses made after it. The page tells such an owner: "Your business already ran on
this before the new starting figures, so it keeps it. A new business starts at ...", and they
can ask Splash for the same.

### How migration 0079 started this

## Two people for a large grant

Sky approved following the recommendation. **A raise that takes the daily limit above
250,000 USDC, or the monthly limit above 2,500,000 USDC, needs TWO different Splash staff
approvals, one from compliance and one from operations.** Inside those amounts one approval is
enough, as before. The two amounts are `LARGE_GRANT_LINES` in `lib/limits/rules.ts`, written
once, with a comment; the service, the queue and the page read them from there (a test fails if
they are written anywhere else in code). The database check that holds the rule repeats them as
numbers in migration 0086 and moves with them.

- The line applies to the **granted** figure. Approving a smaller figure inside a line is one
  approval, even when the owner asked for more.
- **The first approval is recorded and starts nothing**: the request stays `pending`, the owners
  see "Splash is reviewing it" and are told nothing, no notice runs, nothing changes. The trail
  line is `limit_request_first_approved` under the staff member, with their role and the role
  needed next.
- **One person can never approve twice.** The same person again (a double click, or a second
  tab, or the same address in another case, or with the other role) is a replay of the first
  approval, not a second one. A different figure from them is refused (`figure_differs`).
- The **second approval** must come from the **other role** and a **different person**, for the
  **same figure** the first approved (`second_approver_role`, `figure_differs`). It decides the
  request, and **the 24 hour notice starts from the second approval**, not the first. Two people
  approving at the same moment end with one first and one second (tested). A second click on the
  second approval is a replay.
- Either person can **decline** at any time, and the owner can cancel at any time, before and
  after a first approval; a second approval after that is `already_decided`.
- The trail names both approvers: the `limit_request_approved` line carries both (address, role
  and time), and the `limit_change_applied` line that makes it real names the first approver too.
  `business_limit_requests` keeps the first approver, their role, the time and the figure, and
  the second approver's role.
- **The database holds the rule even for a statement that skips the service**: a large grant
  cannot be approved or applied without a first approver, the two cannot be the same address, and
  the two roles cannot be the same.
- The queue card says "Two approvals needed", who gave the first, which team the second has to
  come from, and does not offer the first approver the button again (they can still decline).
- **Today the console has one configured staff login, with the role operations.** Until a
  compliance login exists, a large grant cannot be completed: the first approval can be given and
  the second has nobody to give it. That is the rule working as Sky asked; it is a deploy fact to
  know (below).

## An owner undoes their own lowering at once

`business_limits.held_max` is the highest figure a business has legitimately held
for a limit: the standard, a figure it kept at migration, or a raise Splash
approved and that started. **Restore** (Settings, Limits; `POST
/api/limits/restore`; `restoreLimit`) puts a lowered limit back up to it at once,
for owners only, with no request and no notice, because it is the owner's own
change. A figure above `held_max` is a request to Splash as before, with the 24
hour notice. Asking Splash for a figure the business already held is answered
`restore_instead` ("choose Restore"), so a mistake is never routed through
review. Lowering to under a tenth of the limit shows a plain warning and the
button reads "Lower it anyway" (a "2" for "2,000" is usually a missing zero); it
goes through either way, because the owner can put it back at once. Lowering
still cancels a request open for that limit, including one Splash approved and
that has not started, because the owner has just said they want it lower: that
grant is not held (it was never in force), so the owner would ask again.

A limit is one number per business. There is no cross-limit rule on the
limits themselves (a payment above the day limit would be refused when an
allowance is asked for, because the allowance form already refuses it).

## Who can do what

| | Owner | Finance lead | Everyone else |
|---|---|---|---|
| See the limits and any request | yes | yes | no (403; the section is not shown) |
| Ask for a higher limit | yes | **no** | no |
| Cancel a request | yes (any owner) | no | no |
| Lower a limit | yes | no | no |
| Answer the three questions; Ask for higher limits | yes | no | no |

The Finance lead (`docs/v2/phase3-team-roles.md`) is an approver with an
appointment, and the spending rules and policy, which these limits sit beside,
stay with owners (`docs/v2/spending-rules.md`). So the Finance lead sees and
asks for nothing. The server answers `owner_only` to the Finance lead and
`not_allowed` to anyone else; the page shows no buttons it would refuse.

Splash staff: **compliance and operations** decide; **support is refused** by the
service, the route and the page (a limit is a risk decision, not a customer
question). It follows the billing precedent (operations only) one step
wider. The console has one configured staff login today with the role
`operations`, so the queue is open to it.

## What happens, step by step

1. **Ask.** Settings, Limits, Ask for more: a figure and a reason (at least ten
   characters, at most 500). The sheet says what happens next, word for word:
   *"Splash reviews this. If approved it starts after a 24 hour notice."* The
   request carries an `Idempotency-Key`; the same key is the same request
   (a different request under a used key is refused with 409), and only one
   request is open per limit (a second is `already_open`). The figure must be
   higher than the limit now and inside the sanity maximum, or it is refused with
   the reason in plain words. **A pending request changes nothing anywhere.**
2. **Decide.** The staff queue (`/admin/limits`) lists open requests oldest
   first with the business, who asked, the figure and the reason, and beside them
   the business's KYB tier and state, its answers, and its last 30 days of automatic
   payments. Staff **approve**, **approve a smaller figure** (above the limit now,
   below the ask), or **decline** with a reason of at least ten characters in plain
   words. The sanity maximum is checked again here. A grant above a two-person line
   (next section) is approved by two people. Deciding twice the same way is one
   decision; a different second decision is refused (`already_decided`) and
   rewrites nothing.
3. **24 hours.** An approval sets `effective_at` = decision + 24 hours (the
   table refuses anything shorter). The owners are told by e-mail and WhatsApp
   (the same owner notifier the schedules use, `tellOwners`), once for
   "approved, starts at ...", once for "declined, and why", once for "started".
   A notice that reached nobody is not recorded as sent and is tried again by
   the cron. If the limit has already started by then, the owners get the
   "started" notice alone; "it will start" is not sent after the fact. In the app, Settings, Limits shows the request waiting, what the
   limit is until then, and **Cancel this request**.
4. **Cancel.** Any owner can cancel until the moment it starts (one
   millisecond before is cancellable; at the moment it starts it is not:
   `already_started`, and the way back is to lower the limit). Cancelling twice
   cancels once.
5. **Starts.** The one statement that moves a request from `approved` to
   `applied` also writes the limit, in a transaction with the trail line, so
   there is no half state. **Every read of a limit starts what is due**
   (`currentLimits`), so a limit is never late because the cron did not run; the
   cron (`/api/cron/limit-changes`) is what tells the owners it started. A figure
   above the ceiling is clamped if ever stored.
6. **Lowering.** Settings, Limits, Lower: applies at once, nothing asked. A
   request still open for that limit is cancelled in the same transaction (a
   limit the owners just lowered is never raised again behind their back; the
   trail says why). Lowering to the figure it was just lowered to is the same
   call, not a second line.

## How this reuses what Splash already does for its own changes

FeeConfig and the other Splash-side proposals are **on chain** and announced to
every owner of every business from chain state (`governance-alert-monitor`,
the dashboard banner), because one change concerns everyone. A limit change is
**off chain and per business**, so it keeps the same shape with its own rows:
a proposal with a fixed 24 hour notice (`LIMIT_NOTICE_MS`), state-based (the
rows are the truth; reads apply what is due), owners told by e-mail and
WhatsApp through the same fan-out (`lib/server/owners-notifier.ts`, now with
`tellOwners` shared with the schedules), idempotent claims before each send,
and a cron that retries. The dashboard banner is not reused: it is the
payment-contract banner and its link and words are about the contract.

## Where the limits are enforced

`currentLimits(db, orgId)` is the one reader. It is used:

- `requestAllowance` (`scheduled-payments.ts`): an allowance above any limit is
  refused (`above_limit`) with the same sentences the Automatic panel shows
  (`allowanceLimitProblems`). A request that is pending, or approved and inside
  its notice, lets nothing through.
- `evaluateAutoRun` (`auto-check.ts`, via `evaluateAuto`): a payment above the
  business's limit for one automatic payment hands the whole run back to "ask me
  first" (`over_payment_limit`), whatever the allowance on the network says.
- The daily limit automatic runs are held to (`effectiveDailyCap`): the owners'
  own, or the 5,000 the Automatic form starts from when they set none (`UNCHOSEN_DAILY_CAP`; a business that starts at 100,000 a day still has 5,000 until its owners choose more), never more than the business's.
  A limit Splash raised does not raise what the owners never chose. The status
  the page shows and the cap the runner checks and reserves against are the
  same figure.
- The monthly limit, at run time: the last 30 days of automatic payments
  (`autoPaidSince`, payments and fees, paid or set aside), this run included,
  must fit it. It is checked when the run is evaluated and again under the same
  lock that reserves the daily limit, so two runs cannot both pass a limit that
  fits one. A run that does not fit is handed back (`monthly_limit`). So lowering
  the monthly limit takes effect at the next run even for an allowance already
  signed. "In a month" means any 30 days, not a calendar month.
- A run that is not given the business's per-payment or monthly limit is handed
  back (`AutoFacts` requires both, and the check refuses when a limit is missing).

The one limit that is not checked at a run is the length of an allowance. It holds
for the next allowance an owner gives: an allowance already given keeps its length
until the owners give it again or take it back, which is theirs and instant. The
lower sheet says so in those words. A signed allowance is not re-checked against
the limits when the owners sign it; the per-payment, daily and monthly limits are
checked at every run, so nothing a late change lets through is paid above them.

**The older operating controls** (per-transfer 50,000 and daily 250,000 USD in
Settings, Controls; `org_settings`) are a separate model and stay one. They govern payments the
team sends; they are the owners' own and instant, and are not Splash limits. **They are shown
together with the Limits on the one Limits screen**, in a block that gives both sets of figures
and says which payments each one holds (`controlsAndLimitsWords`, `lib/limits/start.ts`).

**The block does not say "the lower one always wins", because the code does not do that.** Sky
asked for the page to say which applies first and that the lower one always wins, and to check
the code first. Checked: the Controls figures are read only by `app/api/transfers/authorize` and
`app/api/treasury` (through `checkAuthorizationLimits`); the Limits are read only by the
automatic runner and the allowance request (`currentLimits`). No payment path reads both, so no
payment is held to both and there is no "lower of the two" to apply. Writing that sentence would
tell an owner something the code does not do. So the block says what is true: a payment is held to
one set, never both, and there is no order between them. `tests/limits-start-formula.test.mjs`
reads the code and fails if an automatic path starts reading the Controls figures, or the Controls
paths start reading the Limits, which is the moment the sentence must change. Making the lower
one win would mean the automatic runner also reading Controls (converting USD to USDC); it is a
small change to a money path and Sky's to ask for.

## The trail

Every action is a line in `wallet_authority_events` with who did it: an
owner's user id, `operator:<email>` for staff, `system:limits` when the notice
runs out, `system:migration` for a limit kept at migration. Actions:
`limit_raise_requested`, `limit_request_first_approved`, `limit_request_approved`,
`limit_request_declined`, `limit_request_cancelled`, `limit_lowered`, `limit_restored`,
`limit_change_applied` and `limit_answers_saved` (which carries no answer). `system:onboarding`
writes the lines that start a new business at its proposal. The migrations widen the table's action check; the
trigger that refuses updates and deletes is unchanged. They are not shown in the
team activity list (that list names the team actions it wants).

## Failing closed

- No database: the customer routes answer through the team gate (403/500) and
  the staff and cron routes answer 503; nothing falls back to a map.
- Without `CRON_SECRET` nobody can run the cron.
- A staff session is checked before the database is touched; support is refused
  by the service as well as the route.
- The business and the actor are always the session's: no route reads an org,
  a user or a limit holder from the request (a test reads the routes' source).

## Screens

Screenshots are taken once, by the final verification step (not by this section's build).
The earlier set: Settings, Limits at 1440 and 390 (at its standard and with a limit
kept at migration; the request sheet empty, after a bad submit, and filled in;
the pending state; the staff queue; the decision panels; the decided list; the
owner's view after the answers; the lower sheet with its second look; a lowered
limit with Restore, and after Restore; the days sheet) are in the session's
`screens-p3-limits-final` folder. The dev server ran without `.env.local`,
`USE_MOCK_APIS=true`, signed in as the repo's seeded operator and the dev staff
login; the staff decisions were made by clicking the real buttons.

## The staff queue

`/admin/limits` shows open requests oldest first, with the business, who asked,
the figure, the ceiling, the reason, and how many requests the business made
before. What was decided lately is sorted by when it was decided. After a
decision is saved the card closes; a refresh that fails is said on the page. Two
staff deciding the same request at once decide it once (the other is told
`already_decided`; tested). The card also shows the business's KYB tier and state,
the answers it gave with the proposal, and its last 30 days of automatic payments, and which
approval a large grant is waiting for.

## Needs Sky

- **The monthly start (500,000 USDC).** You gave per payment and daily; the monthly figure is
  "worked out from the business's answers", so 500,000 (the round-three ceiling) is Splash's
  choice as the cap of that working and as the start of a business with no answers. The three
  minimums (100 / 500 / 2,000) and the formula's 50% headroom, twice-the-average and a-tenth
  steps are also Splash's: confirm or change them in `lib/limits/start.ts`.
- **A per-payment limit of 50,000 does not let an automatic payment of 50,000 through.** The
  second-approval line (10,000 USDC by default, `AUTO_APPROVAL_CEILING_MINOR`) is the
  SpendPolicy's and is unchanged, so an automatic payment above it still waits for an owner. The
  page says so. If the new figures mean that line should move too, that is yours and Sebastian's.
- **The console has one staff login (operations).** A grant above the two-person lines needs a
  compliance login as well; until one exists it can be approved once and not finished.
- **Controls and Limits.** The page cannot say the lower one wins: no payment path reads both.
  If you want that to be true, the automatic runner would also have to read Controls.
- **Existing businesses.** They are pinned at what they run on and can answer the three questions
  from Settings, Limits; answering never changes their limits, it shows what a new business like
  them would start at and lets them ask staff. If you want an answer to move an existing
  business's limits without staff, that is a different rule.
- **Review fixes (independent review of the starting limits).**
  - The second approver of a grant sees one choice, "Approve <the first approver's figure>", and
    decline. A click sends that figure (a plain approve when it was the figure asked for, "approve a
    smaller figure" with the first approver's figure when it was not), so the label and the request
    agree (`lib/limits/decision.ts`). The server is unchanged: any other figure is still refused.
  - "Ask for higher limits" reports a request Splash already declined, or the owner cancelled, as
    closed ("Splash already answered ... Change your answers, or use Ask for more") and not as
    sent; a refusal is said with its reason (`askedNoteWords` in `lib/limits/start.ts`). The key is
    still the answers and their version, so new answers are a new ask.
  - The Limits screen says, under the limits, that a day of automatic payments is held to the
    unchosen cap (5,000 USDC) until the owners choose a daily amount in their allowance.
  - The staff card says its 30 days count automatic payments only; manual transfers are not counted.
  - Two first-time saves with different answers: the later one now saves its own answers (version
    + 1) instead of being told the earlier tab's figures.
  - Not changed, on purpose: a business that mistyped its first answer cannot re-start itself (it
    asks staff, as any raise does; letting a started business re-start would be a new rule, Sky's
    to decide), and the staff queue still reads every request (its size is the number of requests
    ever made, small and bounded by owners asking by hand).
- Whether support staff should ever see the queue read-only (today: no).
- Schedule `/api/cron/limit-changes` every 15 minutes in production. Without it a
  limit still starts on the next read, but the owners are not told it started
  until something else runs the notices; treat the schedule as a deploy gate.
- The existing review item still open from scheduled batches: one stolen payer
  key is bounded per day only by the monthly cap. A network-held daily cap needs
  a `splash_spend` change and is Sebastian's; this section does not touch it.
