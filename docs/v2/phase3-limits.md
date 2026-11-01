# v2 Phase 3: Limits on automatic payments, and asking Splash for higher ones

Sky's decision: a business has default limits, and an owner can ask Splash for
higher ones. Splash's own changes keep their 24 hour notice; owners' own
changes stay instant; an owner **lowering** a limit is always instant and asks
nothing. Nothing here moves money and nothing under `move/` changed.

| What | Where |
|---|---|
| Figures, ceilings, the words, the timing | `lib/limits/rules.ts` (pure, used by the page and the server) |
| The notices owners get | `lib/limits/notice.ts` |
| Every read and write | `lib/server/business-limits.ts` |
| Customer routes (one gate: the session) | `app/api/limits/**`, `lib/server/limits-route.ts` |
| Staff routes | `app/api/admin/limits/**` |
| Starts what is due, tells the owners | `app/api/cron/limit-changes` (every 15 minutes) |
| Settings, Limits | `components/settings/LimitsCard.tsx` |
| Operator console, Limit requests | `app/admin/(console)/limits`, `components/admin/AdminLimitRequests.tsx` |
| Tables | `business_limits`, `business_limit_requests` (migration 0078) |
| Trail | `wallet_authority_events` (append-only), six new actions |

## The four limits

Every business starts with the Mode B allowance defaults
(`ALLOWANCE_DEFAULTS`, written once in `lib/schedule/rules.ts`). The ceiling is
the most Splash will ever grant, in code.

| Limit | Standard | Ceiling | Where it holds |
|---|---|---|---|
| One automatic payment | 2,000 USDC | 10,000 USDC | the allowance an owner asks for; every payment of an automatic run |
| In a day | 5,000 USDC | 50,000 USDC | the allowance; the daily limit automatic runs reserve against |
| In a month | 20,000 USDC | 500,000 USDC | the allowance (the network holds it) |
| How long an allowance lasts | 90 days | 366 days | the allowance |

The ceilings: **one payment is the 10,000 USDC an owner must always approve**
(`AUTO_APPROVAL_CEILING_MINOR`); a year is `ALLOWANCE_MAX_DAYS`; 500,000 a
month is the on-chain Tier 3 window cap `VERIFIED_WINDOW_CAP_MINOR` mirrors.
**The 50,000 a day is Splash's proposal and has no earlier source: Sebastian and
Sky should confirm it, and the monthly figure, before mainnet.** The
second-approval line itself (the SpendPolicy's, 10,000 USDC by default) is not
a limit here: only owners edit it, and this path never raises it. The page says
so under the list.

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
   higher than the limit now and inside the ceiling, or it is refused with the
   reason in plain words. **A pending request changes nothing anywhere.**
2. **Decide.** The staff queue (`/admin/limits`) lists open requests oldest
   first with the business, who asked, the figure, the ceiling and the reason.
   Staff **approve**, **approve a smaller figure** (above the limit now, below
   the ask), or **decline** with a reason of at least ten characters in plain
   words. The ceiling is checked again here. Deciding twice the same way is one
   decision; a different second decision is refused (`already_decided`) and
   rewrites nothing.
3. **24 hours.** An approval sets `effective_at` = decision + 24 hours (the
   table refuses anything shorter). The owners are told by e-mail and WhatsApp
   (the same owner notifier the schedules use, `tellOwners`), once for
   "approved, starts at ...", once for "declined, and why", once for "started".
   A notice that reached nobody is not recorded as sent and is tried again by
   the cron. In the app, Settings, Limits shows the request waiting, what the
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
  own, or the standard 5,000 when they set none, never more than the business's.
  A limit Splash raised does not raise what the owners never chose. The status
  the page shows and the cap the runner checks and reserves against are the
  same figure.

An allowance already on the network keeps its terms until the owners change it:
lowering the monthly limit or the number of days does not shorten a signed
allowance, which is the owners' own, instant to revoke or reissue. The per-payment
and daily limits are checked at every automatic run, so lowering those takes
effect on the next one.

The older operating controls (per-transfer 50,000 and daily 250,000 USD in
Settings, Controls; `org_settings`) are the owners' own and instant, and are
unchanged. They are not Splash limits.

## The trail

Every action is a line in `wallet_authority_events` with who did it: an
owner's user id, `operator:<email>` for staff, `system:limits` when the notice
runs out. Actions: `limit_raise_requested`, `limit_request_approved`,
`limit_request_declined`, `limit_request_cancelled`, `limit_lowered`,
`limit_change_applied`. The migration widens the table's action check; the
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

Screenshots at 1440 and 390 (Settings, Limits at its standard; the request sheet
empty, with a refused figure, and filled in; the pending state; the staff queue;
the decision panels; the decided list; the owner's view after the answers; the
lower sheet) are in the session's `screens-p3-limits` folder. The dev server ran
without `.env.local`, `USE_MOCK_APIS=true`, signed in as the repo's seeded
operator and the dev staff login.

## Needs Sky

- The daily (50,000) and monthly (500,000) ceilings above.
- Whether support staff should ever see the queue read-only (today: no).
- The existing review item still open from scheduled batches: one stolen payer
  key is bounded per day only by the monthly cap. A network-held daily cap needs
  a `splash_spend` change and is Sebastian's; this section does not touch it.
