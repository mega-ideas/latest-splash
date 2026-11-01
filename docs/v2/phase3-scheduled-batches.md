# v2 Phase 3: Scheduled batches

A batch of payments to recipients the business saved, set to fall due once,
every week or every month, in one of two modes **an owner chooses per
schedule** (Sky's decision: both; automatic suits a business with one to three
staff, and the Sui allowance already enforces strict rules).

| Mode | What happens at the due time | Who is the authority |
|---|---|---|
| **A. Ask me first** (the default) | Splash prepares the batch exactly as Batch payouts do and asks the owners through the existing signing request (phones, WhatsApp, the app). | A person's own passkey: the owners' multisig signs the batch. Nothing moves before. |
| **B. Pay automatically within my limits** | Splash re-checks everything and, if every check passes, pays each payment through `splash_spend::pay_intent` with no one present. Anything that fails a check hands the whole run back to Mode A, with the reason. | An allowance the owners signed (an owner-signed, revocable, expiring action) to a dedicated **scheduled payer**. |

No Move code changed. Nothing here signs or sends on any network in tests or in
this branch's screenshots.

Code: `lib/schedule/` (pure: due times, states and words, the checks, the
notices, the summary), `lib/server/scheduled-store.ts`, `scheduled-payments.ts` (what an
owner does), `scheduled-runner.ts` (what happens at the due time),
`scheduled-payer-signer.ts` (the key), `scheduled-payments-deps.ts` (live
wiring), `app/api/wallet/schedules/*`, `app/api/cron/scheduled-payments`,
`components/schedule/*`, migrations `0069`, `0070` and `0076` (the grace window).

## States, in the owners' words

`scheduled`, `waiting for approval`, `approved`, `paid`, `skipped`, `failed`
(its own History group, with what happened and what to do), and `not approved
in time` (a lapse: nobody's failure, in the "Not paid" group). `lib/schedule/rules.ts`
`RUN_STATE` is the one table the Scheduled tab, History and the notices share.

A lapse says: *"Nobody approved it before the request ran out, so it did not go
out. Nothing was paid. There is no late fee or penalty."* No late fee or penalty
exists anywhere in the product.

## Who may do what

| | Owner | Finance lead | Everyone else |
|---|---|---|---|
| Set, change, skip, stop, delete an "ask me first" schedule | yes | yes | no |
| Set or change a schedule that **pays automatically**, or skip or stop one | yes | no | no |
| Pause all automatic payments (kill switch); turn them back on | yes (any one owner) | no | no |
| Give, change or take back the allowance | yes (the quorum signs) | no | no |
| See schedules and runs | yes | yes | staff who may read payouts |

Owners' own changes are **instant with no cooldown**: edit, skip, stop, delete,
a switch to "ask me first" and the kill switch all take effect for the next run,
and for the next payment of a run in progress. Revoking the allowance itself is
a multisig-signed request and takes effect when the owners sign; the kill switch
and "ask me first" are what stop automatic payments at once. A DB `CHECK` refuses
an automatic schedule an owner did not create (`payment_schedules_auto_owner_check`).

## The runner and idempotency

`GET|POST /api/cron/scheduled-payments`, bearer `CRON_SECRET` (no secret set:
nobody is authorised, in every environment; production also refuses to boot
without it). Run it every five minutes. It takes an injected clock in tests.

- One run per schedule per due date: `UNIQUE (schedule_id, due_date)`.
- The run is **made before** the schedule moves on, so a crash never loses a run.
- A run is claimed with a lease (`claimed_at`, ten minutes) before it is started;
  every state change is a compare-and-set from the state it expects.
- Mode A's batch intent id is `sch-<schedule>-<due date>`, so a second pass
  replays the same batch and the same signing request.
- Mode B's payments are claimed once (`pending` to `submitting` with the digest
  written first, only while the run is still `approved`) and unique per business
  by payment reference, which is also the on-chain idempotency key.
- A run Splash could not start within **24 hours** of its due time lapses and is
  not run late. A catch-up of missed occurrences makes each run and lapses it.
- No cron entry was added to any file: this repo schedules routes from the host
  (`docs/DEPLOY-DIGITALOCEAN.md`), so the entry goes there.

## Notices

Day before an automatic run, again as it runs, "ready for approval" (with the
reason when an automatic run was handed back), a receipt, and failed, lapsed,
skipped and paused. E-mail (a link to the signed-in Scheduled tab) and WhatsApp
where an owner has a verified number. **No link pays, skips or stops by itself**:
Skip and Stop are buttons in the signed-in app, and the notice says so. The
day-before notice and the "starting" notice both carry them (`actions` in
`lib/schedule/notice.ts`: "Skip this run" and "Stop schedule", each pointing at
the Scheduled tab on that run), in the e-mail and the WhatsApp message alike. A
bare link in a message only opens the app; pressing the button needs an owner
signed in.

## Mode A

`prepareApproval`: re-resolves every payee (the saved address must still be the
saved recipient's), runs `reviewBatch`, then `createBatch` as an owner (the
schedule's creator if still an owner, else the first owner) with a **24-hour
approval window** (`settleWindowMs`, at most the signing layer's own 24 hours;
by hand a batch is still one hour). The existing `beforeSign` re-screens every
payee before each signature. No partner is called before approval.

## Mode B: the design, with no Move change

The owners' multisig gives the **scheduled payer** an allowance through the same
signed request flow as a spending rule (`issueSpendingRule` / `changeSpendingRule`
/ `revokeSpendingRule`): it becomes a **STAFF spender** of the business's
`SpendPolicy`, with its own per-payment maximum, an app-bound allowance with a
monthly cap and an expiry. It therefore pays only recipients the owners verified
on the policy, and above the second-approval line the chain itself requires an
owner approval, which an automatic run never has, so it hands back.

The scheduled payer is **a separate KMS key from the gas sponsor** (separation of
duties; `docs/KEY-POLICY.md`). It holds no funds and no SUI; the operator
sponsors the gas (counted in the business's 1 SUI per 24 hours, shared with
the owners' own payments).

### The grace window (migration `0076`)

Sky's decision: the "starting" notice of an automatic run goes out **GRACE
minutes before the run's first payment**. GRACE is **10 by default, 0 to 60 per
business** (whole minutes), set by an owner at once with no cooldown
(`setGraceWindow`, `POST /api/wallet/schedules/automatic { action: 'grace', minutes }`,
a database `CHECK` on the column, and `automatic_grace_changed` on the owners'
trail).

At the due time, once every check passes, the runner does **not** pay. It
announces the window:

1. `openGraceWindow` sets `payment_schedule_runs.starts_at` = now + GRACE, once
   (`WHERE status = 'scheduled' AND starts_at IS NULL`), and `window_version` =
   the schedule's version, and frees the lease.
2. The "starting" notice goes out with that time: "Starts at 14:10 UTC, Skip or
   Stop until then. Nothing has been paid yet." It carries the Skip and Stop
   buttons. (If the runner stops between 1 and 2, the next pass sends it.)
3. The run stays `scheduled`. Skip and Stop are exactly what they were for a run
   that has not started: they end it as **skipped, nothing paid**. Passes inside
   the window do nothing.
4. At `starts_at` the runner claims the run again (the same lease) and **makes
   every check again**: the kill switch, the mode, the allowance and every limit
   (per payment, monthly window, daily, second-approval line), each payee, the
   fee, the payer, the wallet's balance. Anything that no longer passes hands the
   whole run to "ask me first" with the reason. So does a schedule **changed
   since the window opened** (`window_version` differs from its version): what is
   paid is what the notice named (`changed_in_window`). Otherwise it pays as
   described under "Paying".

Where it is enforced, not just where it is intended:

- **No automatic payment is claimed before the window ends.** The claim
  statement itself (`claimPayment`) only matches a payment whose run has
  `starts_at IS NULL OR starts_at <= now`. The runner never calls it early, and
  if it ever did the database refuses.
- **Skip versus the first claim** is as before: one statement under the
  per-business lock (`moveRunUnlessPaying`), so a Skip and the first payment's
  claim cannot both succeed. At the window's end the runner's move from
  `scheduled` to `approved` and a Skip are compare-and-sets on the same status:
  one wins. A test runs the two at the same moment, three times.
- **The announced start is fixed for that run.** Changing the setting later moves
  no start that was announced (it applies to the next run that starts); moving
  the schedule's time inside the same day closes the window and the new time gets
  its own, with its own notice. Opening the window is once per run
  (`starts_at IS NULL`), and a run is still made once per schedule and due
  date.
- **The clock edges are explicit**: at `starts_at - 1 ms` nothing is paid; at
  `starts_at` it is. A run Splash could not start within 24 hours of its due
  time lapses, window or not (a window opened late and ending after that is not
  paid late).
- **A window of 0 is the old behaviour**: the run pays at the due time, and the
  notice names no start.
- **Production**: a sandbox payer is not a payer there, so the checks hand the
  run back **before** a window is announced. Nothing is promised that could not
  happen.

The Scheduled tab and History say it in one place, one component
(`components/schedule/RunWindow.tsx`): "Starts at 14:10, Skip or Stop until
then", in the viewer's own clock, and nothing once the window is over.

### The summary before the owners sign (`lib/schedule/summary.ts`)

An owner switching a schedule to automatic resends its payments (the
`confirm_payments` rule is unchanged). If the allowance is not in force, the
allowance screen then opens by itself, and it has two steps. The second is
"Check this before your owners sign":

> Splash will pay these 4 payments, up to 2,000 USDC each, from 12 Nov until
> 10 Feb. Nothing is paid without your limits. You can stop this anytime.

below it the exact payments (recipient, masked address, amount, reference), the
most for one payment, the daily and monthly limits, the recipients, the end date,
the warning window and how to stop (Skip this run, Stop schedule, Pause all
automatic payments, taking the allowance back).

The figures are not computed on the page. `parseAllowanceInput` reads what was
typed one way for the page and the server; `allowanceTerms` / `allowanceRule`
turn it into the rule the owners sign; `automaticSummary` reads the per-payment
maximum, the monthly cap and the end date from those terms. `requestAllowance`
builds the summary from the same form and the same clock as the rule, refuses
(`summary_mismatch`) if they ever disagree, and answers with it. Tests pin that
the screen's and the server's summaries are identical, and that after the owners
sign, the network holds exactly the figures the summary showed
(`tests/scheduled-summary.test.mjs`). The payments listed are those of the
schedules that pay automatically and are running.

### The checks (`lib/schedule/auto-check.ts`), all of them, over the whole run

Not paused; the schedule is an owner's and its creator is still an owner; the
payer and the sponsor exist; the allowance is readable, running and not about
to end; each payee is unchanged (same address, same kind), a Splash business or
a wallet (never an exchange, bank or another chain), **paid before** (a transfer
the owners signed, an ask they approved, an executed batch or an earlier
scheduled payment: never a first payment to a new recipient), cleared by
screening now, on the verified list; each payment under the allowance's
per-payment limit and under the second-approval line counting what was paid that
recipient (the lower of the business's own line and 10,000 USDC, so a policy can
never lift the ceiling; an allowance cannot offer more than that for one
payment); the whole run fits what is left of the window, each payment counted
against the next; the daily limit holds; the fee is no higher than the one the
owner was shown (and the fee paid is the current fee, which is `max_fee`); the
wallet holds enough.

### Falling back

A failed check hands the **whole run** to Mode A, with the reason in plain words
(`FALLBACK_TEXT`), in the notice, the Scheduled tab and History. If it then
cannot be prepared either, the run says both. Paying is all or hand back; only an
execution failure after payments began leaves a run part-paid, and that is said
("1 of 2 payments went out ... Nothing was paid twice") and files under Failed.

### Paying

(Under the grace window above, this starts when the window ends.) Per payment, in order: the run, the schedule, the kill switch and the mode are
read again (a Skip, Stop, pause or switch to "ask me first" stops the rest at
once); the fee is read again; the allowance is read again (it has counted the
previous payment); the audit bundle is made (fails closed in production); the
bytes are built with `staffRulePaymentTx` and decoded back with the same
`describeWalletTransaction` and `assertPurposeShape('staff_rule_payment')` a
staff member's own payment is held to, and `assertSponsorable`; the gas budget is
checked; the dry run must pass; **then** the payment is claimed and signed by the
payer and sponsored. An answer that never came is read back from the chain by
its digest and never sent again; after 72 hours (past any validity window) it is
given up on as not paid. A payment that did not go out ends the run: the rest
are not sent after it.

### Fail closed, and the sandbox

- Production without `SCHEDULED_PAYER_KMS_KEY_ID`, its region and address, or
  with a key that does not derive that address, or that is the operator's key or
  address or the sponsor's: no payer, every run is handed back. The boot refuses
  a payer that names the operator's key or address, or an address with no key.
- No allowance, an unreadable one, an unreadable policy, no sponsor: handed back.
- The **sandbox payer** (development only) works the run through, signs nothing
  on any network, and records a `sandbox:` digest that is never shown as an
  explorer link. It is not reachable in production: the resolver never returns
  it, and the executor refuses it again.

## The trust change, honestly

Before this, every payment had a person's passkey behind it, either the owners'
quorum or a staff member's own. In Mode B a **Splash-held key** pays, with no
person present. The owners' consent is the allowance they signed, not each
payment. What bounds it:

- **A stolen payer key** can ask `splash_spend` to pay **recipients the owners
  verified**, for businesses that gave it an allowance, up to the per-payment
  maximum, the monthly cap and the expiry, and never above the second-approval
  line without an owner. It cannot pay an address the owners did not verify,
  raise a limit, add a recipient or touch the wallet. The loss is bounded by the
  allowance caps (the monthly cap is enforced by the network), and the owners
  revoke it. One key serves every business that gave it an allowance, so the
  worst case across businesses is the sum of their allowances; per-business keys
  are the stronger design and are Sebastian's call.
- **A compromised Splash server** can ask KMS to sign while it is compromised, the
  same window the operator key already has, bounded by the same caps, plus the
  server-side checks it could skip. The outflow monitor watches the operator, not
  this key (see needs_from_sky).
- **The daily limit is Splash's, not the network's.** An allowance carries one
  recurring cap (`allowance::monthly_rate_limit` here). Both a daily and a
  monthly cap on one allowance is not possible in `0x2::allowance`; the daily
  limit the owners set is enforced by the server (against what automatic runs
  paid in the last 24 hours). A stolen key is therefore bounded per day only by
  the monthly cap. Two things hold the server's limit honestly: a limit asked
  for with an allowance waits (migration 0070) and applies only when the owners'
  signed request executes, so one owner's call cannot raise it; and an automatic
  run reserves its payments under a per-business lock that counts what other
  runs have set aside, so two runners cannot both pass a limit that fits one.
  What the server cannot give is the network's own daily cap; that needs a
  `splash_spend` change, which is Sky's decision.
- Verified recipients are the main defence: money goes to the owners' own
  suppliers, so a misuse is mostly an early or repeated payment to a supplier.

## Defaults the owners start from (Sebastian reviews)

Per payment 2,000, daily 5,000, monthly 20,000 USDC, 90 days
(`ALLOWANCE_DEFAULTS`). Owners edit them; the form refuses a per-payment limit
above the daily one, a daily above the monthly, and one above the business's own
per-payment maximum or longer than a year.

## What a rotation does

A wallet rotation reissues the scheduled payer's rule with the others
(`reissueAfterRotation` carries STAFF rules of spenders that read as `member`;
the payer does). The owners sign that request. If they do not want automatic
payments to carry over, they revoke the allowance after.

## What the independent review changed

- **A moved time moves its run.** One run is made per schedule and UTC day; when
  the time moves inside the day, the run already made takes the new time (and the
  day-before notice is sent again). A schedule started again after a stop opens
  the run the stop closed. A time an owner skipped stays skipped; a "once"
  schedule moved onto such a day says so.
- **Automatic is confirmed by an owner.** Switching a schedule to automatic needs
  its payments sent again, so a Finance lead's changes are never taken on trust;
  the schedule then becomes the owner's. An owner editing the payments of any
  schedule takes it as theirs.
- **Skip and the first payment** go through one lock; a Skip is one statement
  that checks no payment was claimed. The network-fee allowance is checked again
  under the same lock as the claim.
- **Left as they are, on purpose.** An unknown outcome stays "being paid" until
  the chain answers or 72 hours pass: telling a rejected transaction from an
  outage needs a real network, and at-most-once matters more than a quick
  answer. "Paid before" counts an approved ask because an ask becomes approved
  only after its signing request has executed (`settleApprovalAsks`). The
  allowance request is not idempotent by key; a second request while one is
  open is a second signing request the owners can decline.

## Tests

The grace window and the summary: `tests/scheduled-grace-rules.test.mjs` (the
window's length and words, the notices, the allowance rule, the caps at their
boundaries, the summary), `tests/scheduled-grace.test.mjs` (the window end to
end: to the millisecond, Skip and Stop inside it, Skip racing its end, the
checks made again at its end, clock edges, once-only, tenants, production),
`tests/scheduled-summary.test.mjs` (the summary equals the request and the
chain). Older tests give their business a window of 0, so they stay about the
payments.

`tests/scheduled-rules.test.mjs`, `scheduled-auto-check.test.mjs` (every check
and its order), `scheduled-payer.test.mjs` (key policy, no sandbox in production,
boot checks, canon D-0004), `scheduled-schedules.test.mjs` (who, instantly,
idempotency, tenants, the allowance through signed requests),
`scheduled-runner-ask.test.mjs`, `scheduled-runner-auto.test.mjs` (payments,
every hand-back, once-only, kill switch between payments, unknown outcomes,
production), `scheduled-routes.test.mjs` (gates, cron fail-closed),
`scheduled-history.test.mjs` (History, the tab, copy), `scheduled-review.test.mjs`
and `scheduled-review-units.test.mjs` (what the review found). They run on PGlite with the
staff-rule world's model chain, which applies `splash_spend`'s checks and the
allowance's caps to the bytes built.

## Not done, and why

- **No testnet run.** The five-command payment with the payer as sender, signed
  by a KMS key and sponsored, follows the staff payment's own builder; the model
  chain does not verify signatures. The hardware passkey check is Phase 2's.
- **No batch in one transaction under an allowance.** Mode B pays one transaction
  per payment (not the batch PTB), so each is claimed and read back on its own.
- **Splash business payees are supported by the API (by id, after the owner has
  seen its address and country) but the form offers saved wallet recipients only.**
- **"Test-verified" recipients**: "paid before" is the only test of a known payee
  here. A wallet's ownership proof is not a payment.
- **No "Scheduled" in Batch payouts**: `BATCH_SCHEDULE_WIRED` stays `false`; the
  Scheduled tab in Transfer is where schedules are made.
- The partner payout API and exchange accounts are not scheduled (an exchange's
  Travel Rule message is per payment; a bank payout tells the partner first).
