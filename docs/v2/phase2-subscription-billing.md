# Subscription billing — v2 Phase 2 (Amendment A1 §6)

Status: built 25 Oct 2026 on `v2/phase2-backend` (migration 0052), behind
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
anything. The one exception is cancelling: a business with a live plan can
always revoke it (with nothing live, cancel is `not_found` too). No payment
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
- **The limit** is the chain's: at most the plan price per civil month of
  the allowance (`monthly_rate_limit`). Its windows renew on the day of the
  first pull at 00:00 UTC.
- **The term** ends at 00:00 UTC on the first day of the month after its
  last (`expiration_timestamp_ms`, exclusive); the current month counts.
- **The AllowanceCap** goes to the business wallet. Only the wallet can
  revoke it.

The reader accepts `allowance::new` only when the server set
`expect.billing`: USDC, named `splash-billing:…`, to exactly the finance
multisig, with an end of term and a calendar-month limit made in the same
transaction. The `subscription` purpose then checks the bytes carry exactly
the plan's name, price, term and lifetime cap, and that a plan change
revokes exactly the current billing allowance. Without `expect.billing`,
`allowance::new` is refused as before (spending rules never use it).

When the request executes, the allowance is read from the chain (not from
the client) and must carry the plan's terms; the subscription becomes
`active` with its allowance and cap ids.

## Billing

`/api/cron/billing` (daily, `CRON_SECRET`), cross-tenant:

1. What each submitted pull did, from its digest: a receipt, or a failure.
2. A plan past its term is `ended`; one whose allowance is gone (revoked
   in Splash or not) is `cancelled`; one in grace past `grace_until` is
   `lapsed`.
3. Once per business per calendar month (UTC), when the allowance's own
   window has room for the price, the month's **pull** is built: the
   finance multisig withdraws exactly the price from the business wallet
   under the allowance (`allowance::balance_spend`) and sends it to itself
   (`balance::send_funds`), paying its own gas from its address balance. The
   bytes are stored with their digest and an **invoice**
   (`SPL-<yyyymm>-<org hash>`).

**At most one pull per business per calendar month**: the unique index on
`subscription_pulls (org_id, period)`. A failed pull is tried again on the
same row, at most three times in the month; a succeeded one is never sent
again. The chain's monthly rate limit bounds it too.

The pull is signed by the **finance multisig's** members on their own
devices (Splash's finance ceremony, not the operator); the server never
signs it. `submitPullForStaff` sends the stored bytes with their
signatures: success writes the **receipt** (digest, amount, invoice); a
failure puts the plan in **grace** for seven days (from the first failure,
not extended) and emails the business's owners once per pull ("Your
payments are not affected: billing never holds a payment back."). A network
that does not answer leaves the pull `submitted`, and the next cycle
settles it from its digest, forward only.

## Cancelling and changing

- **Cancel** = the wallet revokes the allowance (`allowance::revoke`). The
  plan is `cancelled` when that executes, or when the cycle finds the
  allowance gone.
- **Change** = revoke the current allowance and grant the new one in one
  transaction the wallet signs. On execution the old plan is `replaced` and
  the new one `active`. One change at a time.

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
- A pending plan whose request executed but whose follow-up step failed
  stays pending until it is handled by hand; a new request is then refused
  (`request_open`).
