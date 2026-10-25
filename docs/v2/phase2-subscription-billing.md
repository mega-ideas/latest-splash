# Subscription billing — v2 Phase 2 (Amendment A1 §6)

Status: built 25 Oct 2026 on `v2/phase2-backend` (migrations 0052 and
0053, the review fixes), behind
`FEATURE_SUBSCRIPTION_BILLING`, which is **off**. Not enabled anywhere.

Code:
- `lib/billing/subscription.ts`: the flag, calendar months (UTC), the term,
  the allowance name, the Settings line.
- `lib/server/subscription-builders.ts`: the three PTBs.
- `lib/server/subscription-billing.ts`: plans, subscribe, change, cancel,
  the executed-request step, the monthly cycle, the pull reader and sender.
- `lib/server/subscription-billing-deps.ts`: the live chain reads.
- `lib/wallet/wallet-tx-describe.ts`: `allowance::new` and a billing revoke,
  only with `expect.billing`; `lib/server/wallet-signing.ts`: the
  `subscription` purpose and its shapes.
- Routes: `GET /api/billing/plans`, `GET|POST /api/wallet/subscription`,
  `/api/cron/billing`.

Tests: `tests/subscription-billing.test.mjs`.

## While the flag is off

Every route and the cron answer 404 before they read a session or the
database, and every service call refuses `not_found` before it writes
anything. The one exception is cancelling: a business with a live or
pending plan can always revoke it (with neither, cancel is `not_found` too). No payment
path imports billing, and a test says so: billing never holds a payment
back.

## Plans

`subscription_plans`: `id`, `name`, `price_minor` (USDC, 6 decimals),
`interval` (`calendar_month_utc`, the only one), `term_months` (default 12),
an optional `lifetime_cap_minor`, `active`. Editable without code
(`upsertPlanForStaff`). A price change applies to new subscriptions; a live
one keeps the price it was signed at.

## Subscribing

The business wallet's quorum signs, sponsored like every wallet
transaction:

```
allowance::monthly_rate_limit(price) -> option::some<RateLimit>
allowance::new<Balance<USDC>>("splash-billing:<plan>", finance multisig,
                              lifetime cap or none, none, some(end of term), rate)
```

- **The spender** is `SPLASH_FINANCE_ADDRESS`, and only while it is the
  on-chain `FeeConfig`'s fee recipient: `fee_config::propose_fee_recipient`
  derived that address from its members and refused one any single member
  can sign for. So it is never the KMS operator or another lone key. Unset,
  malformed, or not the fee recipient (including while Splash's fees are
  off): `finance_unconfigured`, nothing built.
- **The limit** is the chain's: at most the plan price per monthly window
  of the allowance (`monthly_rate_limit`). The framework anchors its windows
  on the first charge (`sui::allowance`, `anchor_ms`) and renews them on
  that day of the month at 00:00 UTC, so a plan first billed on the 25th
  renews on the 25th. **"Per calendar month (UTC)" is Splash's server**:
  the partial unique index allows one drawn pull per business per calendar
  month. The chain alone would allow the price once per window, so a pull
  signed by the finance quorum outside Splash could draw the price on the
  1st (window from the 25th before) and again on the 26th; and a plan change
  starts a fresh window. The Settings line is A1's exact wording; this gap is
  in SECURITY.md as residual risk.
- **The term** ends at 00:00 UTC on the first day of the month after its
  last (`expiration_timestamp_ms`, exclusive); the current month counts.
- **The AllowanceCap** goes to the business wallet. Only the wallet can
  revoke it.

The reader accepts `allowance::new` only when the server set
`expect.billing`: USDC, named `splash-billing:…`, to exactly the finance
multisig, with an end of term and a calendar-month limit made in the same
transaction. The `subscription` purpose then checks the bytes carry exactly
the plan's name, price, term and lifetime cap, and that the transaction
revokes exactly the billing allowances the server read as the wallet's
(every one it holds to a finance multisig this business subscribed to), no
fewer and no other. Without `expect.billing`,
`allowance::new` is refused as before (spending rules never use it).

The pending subscription row is written **before** the signing request is
opened: if it cannot be written (another plan change is pending), no request
is opened; if the request cannot be opened, the row is `abandoned`.

When the request executes, the allowance is read from the chain (not from
the client) and must carry the plan's terms; the subscription becomes
`active` with its allowance and cap ids. If that follow-up cannot see the
allowance yet (an indexer that lags) or fails, the plan stays `pending` and
is reconciled again by the owners' next plan request (which is refused with
`reconcile_pending`, opening nothing, until it is recorded) and by every
billing cron run, which reports it as an error (502, so a person is told)
until it is.

## Billing

`/api/cron/billing` (daily, `CRON_SECRET`), cross-tenant:

1. What each submitted pull did, from its digest: a receipt, or a failure.
   One the chain has not seen once its gas window (`ValidDuring`, two
   epochs) has passed can never land, and goes back to be signed again.
   Then any executed subscribe not yet recorded is reconciled.
2. A plan past its term is `ended`; one whose allowance is gone (revoked
   in Splash or not) is `cancelled`; one in grace past `grace_until` is
   `lapsed`.
3. Once per business per calendar month (UTC), when the allowance's own
   window has room for the price, the month's **pull** is built: the
   finance multisig withdraws exactly the price from the business wallet
   under the allowance (`allowance::balance_spend`) and sends it to itself
   (`balance::send_funds`), paying its own gas from its address balance. The
   bytes are stored with their digest and an **invoice**
   (`SPL-<yyyymm>-<6-digit sequence for the month>`; never derived from the
   org, so two businesses cannot collide). A pull left unsigned past its
   gas window is rebuilt on the same row (not counted as a failed attempt),
   after checking its old digest did not land.
4. Detective: a billing allowance a wallet holds that no live subscription
   tracks is reported as an error; the owners can revoke it with Cancel.

**At most one drawn pull per business per calendar month**: the unique
index on `subscription_pulls (org_id, period)`, partial on
`status <> 'superseded'` (migration 0053). A failed pull is tried again on
the same row, for the same subscription and amount, at most three times in
the month; a succeeded one is never sent again. A failed or unsigned pull
of a plan since replaced is `superseded` (its invoice void) and the month is
billed under the plan in force, on a new row with its own invoice, so the
amount drawn, the invoice and the receipt name the same plan. A plan change
supersedes the old plan's unsigned pulls at once. The chain's monthly rate
limit bounds each allowance too.

The pull is signed by the **finance multisig's** members on their own
devices (Splash's finance ceremony, not the operator); the server never
signs it. `submitPullForStaff` sends the stored bytes with their
signatures: success writes the **receipt** (digest, amount, invoice); a
failure puts the plan in **grace** for seven days (from the first failure,
not extended) and emails the business's owners once per pull ("Your
payments are not affected: billing never holds a payment back."). If the network
refuses the transaction before running it (a wrong set of signatures,
expired bytes) and the chain shows no such digest, the pull goes back to
waiting for signatures and `submitPullForStaff` answers `not_sent`; the same
bytes sent twice are one transaction. If neither the network nor the digest
answers, the pull stays `submitted` and the next cycle settles it from its
digest, forward only. A failed pull of a plan no longer live tells nobody.

## Cancelling and changing

- **Cancel** = the wallet revokes (`allowance::revoke`) **every** billing
  allowance it holds to a finance multisig this business ever subscribed
  to, the tracked one and any stray one, in one transaction. It is built
  from the stored subscriptions and what the wallet holds, never from the
  live finance proof: a revoke moves no money to anyone, so it works after
  a finance rotation, with `SPLASH_FINANCE_ADDRESS` unset, and with
  `FeeConfig` unreadable. The plan is `cancelled` when that executes, or
  when the cycle finds the allowance gone.
- **Change** = revoke every billing allowance the wallet holds and grant the
  new one in one transaction the wallet signs. On execution the old plan is
  `replaced` (its unsigned pulls superseded) and the new one `active`. One
  change at a time.

## Settings copy

From the plan price only: "Splash can draw up to X USDC per calendar month
(UTC) for your plan. Revoke any time." (`allowanceCopy`).

## Open

- The Settings → Billing UI (Phase 3), and a staff tool to edit plans and
  to collect the finance multisig's signatures over a pull.
- No testnet run of `allowance::new` from a multisig, or of a pull under a
  plain allowance. The shapes follow the framework source
  (`sui::allowance`, `new` is `entry`) and the TS SDK's
  `withdrawal({ from: 'allowance' })`; simulation refuses a shape the
  chain rejects before anyone signs.
- A pending plan whose allowance never appears to the indexer is reported
  by every cron run until a person looks; the owners can still cancel
  (which revokes whatever the wallet holds).
- No owner notice when a term ends, and no renewal flow: a plan past its
  term is `ended` and nothing more is drawn.
