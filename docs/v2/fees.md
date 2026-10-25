# Splash's fee (Amendment A1)

Status: Phase 1, 25 Oct 2026. Source of truth: `move/splash_core/sources/fee_config.move`
and `address_registry.move`, mirrored off chain by `lib/fees/`. Amendment A1
(Sky, 24 Oct 2026) and Sky's fixups of the same day set the rules. Design
record: `docs/v2/phase1-move-design.md`, revision R5.

No intent carries a fee. The chain computes Splash's fee at settlement from
two things only: the payment's **kind**, which it derives from where the money
goes, and its **principal**. The fee is charged on top of the principal, split
inside Move and sent to the fee recipient that `FeeConfig` holds. A payout
partner's fee and Circle's fee are not Splash's. They come from the partner's
or Circle's own quote, are shown as their own lines, and Splash neither
collects nor marks them up.

## Fees are off until the first recipient is applied

`FeeConfig` is published with the launch schedule and **no fee recipient**.
While it has none, `fee_config::splash_fee` returns 0 for every kind and
amount. So every settle path, and `splash_spend`, which calls the same
function, charges nothing, sends no fee leg and emits no `FeeCharged`, and the
payer's whole `max_fee` goes back to the business wallet. Nothing is ever paid
to the publisher.

Fees turn on only when governance proposes the finance multisig as fee
recipient and applies it after 24 hours' notice (below). After that there is
always a recipient: a later change replaces it, and nothing clears it.

Every surface says so while fees are off. `lib/fees/copy.ts` exports
`FEES_OFF_NOTICE` ("No Splash fee is charged yet. Fees start only after 24
hours' public notice."), and `pricingLine`, `pricingSummary` and
`feeBreakdownRows` take `feesOn` from the live `FeeConfig`.

## The launch schedule

Rendered from `lib/fees/vectors.json`'s launch rows and `LAUNCH_SCHEDULE` in
`lib/fees/schedule.ts`, which are the same as `fee_config::launch_schedules`.
Amounts are USDC; on chain they are minor units (6 decimals). A tier is chosen
by the principal, and every upper bound is exclusive.

| Kind | Number | Rate | Minimum | Maximum |
|---|---|---|---|---|
| Splash business | 0 | free | none | none |
| Sui wallet | 1 | 0.02% on any amount | 0.25 USDC | 5 USDC |
| Exchange | 2 | 0.15% under 1,000; 0.12% from 1,000 to under 10,000; 0.10% from 10,000 to under 50,000; 0.07% from 50,000 to under 100,000; 0.05% from 100,000 | none | none |
| Another chain (CCTP) | 3 | 0.30% under 1,000; 0.20% from 1,000 to under 10,000; 0.12% from 10,000 to under 50,000; 0.07% from 50,000 to under 100,000; 0.05% from 100,000 | none | none |
| Bank payout | 4 | the same tiers as another chain | none | none |

"None" for an exchange, a chain or a bank means a minimum of 0 and a maximum
of `u64::MAX`.

Worked examples, from the vectors (`tests/fee-schedule.test.mjs` and the
generated `move/splash_core/tests/fee_vectors_tests.move` run every row):

| Payment | Fee |
|---|---|
| Bank payout of 999.999999 USDC | 2.999999 USDC |
| Bank payout of 1,000 USDC | 2.00 USDC |
| Bank payout of 5,000 USDC | 10.00 USDC |
| Bank payout of 5,000 USDC, 10 bps discount | 5.00 USDC |
| Bank payout of 100,000 USDC | 50.00 USDC |
| Exchange, 999.999999 USDC | 1.499999 USDC |
| Wallet, 10 USDC | 0.10 USDC (the 1% ceiling beats the minimum) |
| Wallet, 25 USDC | 0.25 USDC |
| Wallet, 25,000 USDC | 5.00 USDC (the maximum) |
| Wallet, 1,000,000 USDC | 5.00 USDC |
| Splash business, 50,000 USDC | 0 |

The schedule is data, not code. Governance can change any kind's schedule
through the 24-hour path below without a package upgrade. What it cannot
change is the computation, which is frozen at first publish, and the 1%
ceiling.

## How the fee is computed

`fee_config::splash_fee(cfg, business, kind, principal)`, in this exact
order, with no step that aborts except an unknown kind (1305), which is
checked first:

1. If no fee recipient has been applied, the fee is 0.
2. The tier's rate: the first tier whose upper bound is above the principal,
   else the last tier.
3. Less the business's discount, never below zero.
4. `principal × rate / 10,000`, rounded down in a `u128` intermediate. Floor
   rounding favours the payer.
5. Raised to the kind's minimum, then lowered to its maximum.
6. Lowered to the ceiling, `principal × 100 / 10,000`, rounded down. The
   ceiling beats the minimum, which is why a 10 USDC wallet payment pays
   0.10 USDC rather than 0.25.

`lib/fees/schedule.ts` mirrors it step for step in `bigint`: `splashFee` is
the computation on a schedule, and `feeUnderConfig` adds step 1.

## The ceiling

No fee is ever more than **100 bps (1%) of the principal**. It is written in
three places:

- `splash_core::fee_config::FEE_CEILING_BPS`. No proposed rate and no discount
  may exceed it (1301), and `splash_fee` clamps every fee to it.
- `splash_spend::splash_spend::FEE_CEILING_BPS`, the immutable package's own
  constant. A rule payment's `max_fee` must be within it (1037), and after
  core settles, the fee core hands back is checked against it again (1032).
  So even an upgraded core, or a `FeeConfig` it rewrote, cannot make a
  spending rule pay Splash more than 1%.
- `lib/fees/schedule.ts`.

`npm run check:fees` (rule b) fails unless all three are defined once, equal
and exactly 100, with the same `BPS_DENOM` of 10,000.

## The kind is derived, not declared

`address_registry::derive_kind(registry, recipient, declared, via_cctp)`:

1. On the cross-chain path the payment must be declared cross-chain, and is.
2. A recipient that is a registered business wallet is a Splash business
   (kind 0), free inside the network.
3. A recipient in the partner deposit-address registry is a bank payout
   (kind 4), whatever was declared.
4. Anything else must be declared a wallet (1) or an exchange (2), and is
   charged as declared.

What `declared` is depends on the path. On the owners' own path it is the
intent's kind. Under a spending rule it is the recipient's tag in the
`SpendPolicy` (a wallet or an exchange), or a bank payout for a beneficiary
bound to its partner deposit address.

**Every settle path then refuses a kind that does not fit** (Sky, 24 Oct;
`address_registry::assert_kind_fits`, abort 1400). The derived kind must equal
the declared one, with one exception: a payment declared a wallet or an
exchange that reaches a registered business wallet is settled as a free
Splash-business payment. On the app path both the spending rule's tag and the
intent's own kind must fit. So:

| Declared | Recipient | Result |
|---|---|---|
| wallet or exchange | a plain address | charged as declared |
| wallet or exchange | a business wallet | free (kind 0) |
| wallet or exchange | a partner deposit address | refused: core 1400, `splash_spend` 1029 first |
| Splash business | a business wallet | free |
| Splash business | anything else | refused (1400) |
| bank payout | a partner deposit address | bank fee |
| bank payout | a business wallet | refused: core 1400, `splash_spend` 1030 first |
| bank payout | any other address | refused (1400) |
| cross-chain | through CCTP, the owners' path only | cross-chain fee |

A partner deposit address can therefore never be paid as a cheap wallet
transfer that skips the bank payout's floor and beneficiary. The vector row
"Partner address declared WALLET, 5,000 → BANK, 10 USDC" pins what
`derive_kind` and `splash_fee` give; no settle path pays that payment.

**The registries only classify.** They hold no address any payment is sent
to: every settle path pays the intent's own recipient.

- Business wallets are written only by `business_account`. An account's
  wallet is in the registry exactly while the account has a wallet, is
  KYB-verified and is not compliance-frozen (an owner freeze does not remove
  it). `register_wallet`, `confirm_wallet_rotation` (which clears the old
  wallet), `verify_business` and `admin_unfreeze` enter it;
  `revoke_verification` and `admin_freeze` clear it.
- Partner deposit addresses are added and removed by the holder of
  `OpsCap` (`add_partner_address`, `remove_partner_address`). A change takes
  effect at once and emits `PartnerAddressAdded` or `PartnerAddressRemoved`.
  The zero address is refused (1403).

So the most a stolen `OpsCap` can do is make payments abort: a declared bank
payout to an address it removed, or a wallet or exchange payment to an address
it added. It cannot redirect funds, and no payment pays more than its
`max_fee` and the 1% ceiling.

Accepted residual risk (A1): owners can tag an exchange's address as a wallet
and pay 2 bps instead of 5 to 15. Phase 2's KYT attribution is to flag it.

## What the payer signs: `max_fee`

Every money path takes `max_fee`, the fee the payer was shown. The chain
computes the fee itself and aborts if it is higher (435 on the owners' path,
1031 under a spending rule). A schedule raised after the quote was shown can
stop a payment; it can never make one pay more than it showed.

- **The owners' path** (`confirm_from_business_wallet`, `_balance`,
  `confirm_cross_chain_from_business_wallet`): the payment must cover
  principal and fee (402). The principal goes to the recipient (or, on the
  cross-chain path, back to the transaction for the bridge to burn), the fee
  to the fee recipient, and every remainder, an overpayment or the unused
  part of `max_fee`, to the account's business wallet, never to the
  transaction's sender.
- **Spending rules** (`splash_spend::pay_intent`): the allowance withdrawal is
  exactly principal plus `max_fee` (427), and `max_fee` is at most 1% of the
  principal (1037), so the allowance's caps cover both and cannot be used up
  on headroom. The unused part of `max_fee` goes back to the business wallet.
- **Approvals**: an owner's `approve_payout` and the wallet's
  `delegate_execution` name `max_total`, the principal plus the fee the
  approver was shown, at least the principal (1034). Paying aborts when
  principal plus fee is above it (1033), for example after the schedule rose;
  the owners then approve again.
- **CCTP**: Splash's fee is taken in USDC on Sui before the burn. Circle's
  fee is the intent's `bridge_max_fee`, shown separately.

The tier ceilings and a spending rule's limits and second-approval threshold
count the principal only; the allowance's caps count principal plus
`max_fee`.

The quote API (`POST /api/quotes`, `lib/server/quote.ts`) returns A1 §4's
shape at the top level: `splashFee { kind, kindLabel, tierLabel, bps, minor,
basis }`, `partnerFee` or `circleFee` `{ minor, source }`, `totalDebitMinor`
(principal plus Splash's fee), `maxFeeMinor` (exactly the fee shown),
`feesOn`, `principalMinor` and `destination`. Every amount is a decimal string
of USDC minor units. The request must say where the payment goes
(`destination`: `bank`, `sui_wallet`, `exchange` or `splash_business` with an
address, or `cross_chain`); without one it answers 400 `destination_required`.
Today the engine prices only `bank`; any other destination answers 400
`destination_not_quoted` until a flow can pay it through the v2 settle path.
When `FeeConfig` cannot be read it answers 503 `fee_unavailable` and quotes
nothing. `/api/transfers/authorize` refuses with 409 `fee_above_shown` when its
own re-quote is above the `maxFeeMinor` the payer was shown.

The Send USDC desk is a plain wallet transfer, not a settle path. Its fee
(`STABLECOIN_ANCHOR_FEE=on`, off by default) is the WALLET schedule's, read
from the mainnet `FeeConfig` with its recipient, and nothing is charged while
`FeeConfig` has none (`lib/server/stablecoin-fee.ts`). Transfers to a Splash
user's wallet are free.

## Changing the fee: 24 hours' notice, then seven days

All changes need `FeeAdminCap`. Every proposal is validated when it is made.

| Function | What it does |
|---|---|
| `propose_schedule(cap, cfg, kind, uppers, rates, min_minor, max_minor, clock)` | Proposes a schedule for one kind, applicable 24 hours later. Replaces any proposal already pending for that kind, which starts its own 24 hours. |
| `apply_schedule(cap, cfg, kind, clock)` | Puts it in force once the notice has run (1302 before) and before the seven-day window after it closes (1306 after: propose again). |
| `cancel_schedule_proposal(cap, cfg, kind)` | Withdraws the pending proposal, lapsed or not. Changes nothing in force, so it needs no notice. |
| `propose_fee_recipient(cap, cfg, keys, weights, threshold, clock)` | Proposes the fee recipient, applicable 24 hours later. The proposal names the multisig's members, weights and threshold, and the address is derived on chain, never typed in. |
| `apply_fee_recipient(cap, cfg, clock)` | Puts it in force, in the same window. The first time, this turns fees on. |
| `cancel_fee_recipient_proposal(cap, cfg)` | Withdraws the pending recipient proposal. The recipient in force, or none, is unchanged. |
| `set_discount(cap, cfg, business, discount_bps)` | The one immediate change: a business's discount, at most 100 bps (1301); 0 clears it. It only lowers the rate, and the minimum and the ceiling still apply after it. |

Validation of a schedule (1300 unless noted): one to eight tiers; as many rates
as upper bounds; upper bounds strictly ascending, the last `u64::MAX`; every
rate at most 100 bps (1301); minimum at most maximum; kind 0 to 4.

The fee recipient must be a multisig no single member can sign for: a lone
key, a 1-of-N, or a member whose weight meets the threshold is refused
(1304). A configuration Sui itself would refuse aborts with `multisig`'s own
code (1200 to 1207), and one key listed under two schemes counts as one
member (1205). So the recipient can never be the KMS operator. Who the members
are is for the ceremony to check: the chain only knows that no single one of
them can move the fees.

A pending proposal can be applied by no one but the `FeeAdminCap` holder, and
a lapsed one never applies. `npm run check:fees` (rule d) fails if
`fee_config` gains any other way to change what is in force.

There is no version gate on `FeeConfig`, on purpose: `splash_spend` is
immutable and stays linked to the core version it was published against, so
it runs that version's `splash_fee` for ever. A gate would make those calls
abort.

## Events

| Event | Fields | Emitted |
|---|---|---|
| `FeeCharged` | `intent_id`, `business`, `derived_kind`, `fee`, `fee_recipient` | a fee leg was paid (never when the fee is 0) |
| `FeeScheduleProposed` | `kind`, `tiers`, `min_minor`, `max_minor`, `eta` | `propose_schedule` |
| `FeeScheduleApplied` | `kind` | `apply_schedule` |
| `FeeScheduleProposalCancelled` | `kind`, `eta` | `cancel_schedule_proposal` |
| `FeeRecipientProposed` | `recipient`, `eta` | `propose_fee_recipient` |
| `FeeRecipientApplied` | `recipient` | `apply_fee_recipient` |
| `FeeRecipientProposalCancelled` | `eta` | `cancel_fee_recipient_proposal` |
| `FeeDiscountSet` | `business`, `discount_bps` | `set_discount` |
| `PartnerAddressAdded`, `PartnerAddressRemoved` | `partner_address` | `OpsCap` changes |
| `RuleSpend` (`splash_spend`) | `policy_id`, `intent_id`, `allowance_id`, `approval_id`, `spender`, `recipient`, `derived_kind`, `fee` | a payment under a spending rule |

Why an event may carry a fee, a recipient or a fee address is in
`docs/commitments.md`. No event carries the principal.

## Who holds what

| Holder | Holds | Power |
|---|---|---|
| Governance multisig (2-of-3: Sky, Sebastian, cold backup) | `FeeAdminCap` | propose, apply and withdraw schedule and recipient changes; set discounts |
| Governance multisig, or a separate ops multisig (`SPLASH_OPS_ADDRESS`) | `OpsCap` | add and remove partner deposit addresses |
| Splash finance multisig | nothing; it is the fee recipient | receives every fee leg |
| KMS operator | neither cap | none over the fee |

Both caps are minted to the publisher at publish. The ceremony moves them
(`docs/MAINNET-CHECKLIST.md`), and the verify step
(`scripts/e2e-testnet.mjs` through `scripts/v2-end-state.mjs`) checks who holds
each and whom `FeeConfig` pays.

## Off chain

- `lib/fees/schedule.ts`: `splashFee`, `feeUnderConfig`, `deriveKind`,
  `settlementKind` (`derive_kind` plus `assert_kind_fits`), `LAUNCH_SCHEDULE`.
- `lib/fees/fee-config.ts` (server only): reads the shared `FeeConfig`
  (`SPLASH_FEE_CONFIG_ID`) over GraphQL and caches it. It fails closed: an
  unreadable or malformed config is refused, never defaulted, and no payment
  is built. The cache refreshes when it expires, on `FeeScheduleApplied` and
  `FeeRecipientApplied` from the config's own package, and early when a
  pending proposal reaches its eta. It does not refresh on the two
  `…ProposalCancelled` events: after a withdrawal it keeps treating the
  proposal as pending until its eta and refreshes then, which is early, not
  late. Copy is the one exception to failing closed: the pricing line falls
  back to the launch schedule when the live one cannot be read
  (`publishedFeeSchedule`).
- `lib/fees/destination.ts`: the kind a quote is priced as, from where the
  payment goes.
- `lib/fees/quote.ts` and `lib/fees/copy.ts`: the quote shape, the pricing
  line, the fee breakdown (Splash fee with its kind, tier and the bound that
  set it; partner or Circle fee with its source; total debited) and
  `pricingSummary`, whose `feesOn`, `bankFee`, `bankFeePhrase` and `notice`
  say "none yet" while fees are off.
- `lib/fees/vectors.json`: every vector, in one file.
  `node scripts/gen-fee-tests.mjs` writes the Move test from it.
- `npm run check:fees`, in `npm run lint`: (a) the generated Move vector test
  is up to date; (b) one ceiling; (c) no literal fee rate in `app/`,
  `components/`, `content/`, `lib/agent/` or the Send USDC lane; (d) no
  immediate setter in `fee_config` but `set_discount`.

## Phase 2, not built

- **Subscription billing**, behind `FEATURE_SUBSCRIPTION_BILLING`, off. No
  code for it exists yet; the flag is not declared. A1 §6 describes it: plans
  in the database, a direct `0x2::allowance` from the business wallet to the
  finance multisig with a monthly rate limit, at most one pull per calendar
  month, invoices and receipts, a grace period on a failed pull, and payments
  never blocked by billing.
- **Owner alerts for fee proposals: built (Phase 2).**
  `/api/cron/governance-alerts` reads the canonical `FeeConfig`'s state
  with the wrapper and the `ComplianceConfig` (one GraphQL query;
  `lib/server/governance-events.ts`). Each pending schedule slot and the
  pending fee recipient alerts every owner (in-app, email, verified
  WhatsApp), with the proposed schedule against the one in force in words
  rendered by `lib/fees/copy.ts`; an applied schedule or recipient is told
  against the stored state, and the first recipient says the fees start. A
  withdrawn or lapsed proposal stops being shown (as an upgrade's does); the
  withdrawal is not a message of its own. Migration 0050. Tests:
  `tests/fee-governance-alerts.test.mjs`.
- **Near-threshold alerts: built (Phase 2).** Read from the policy's
  running totals and `RuleSpend`, detective only, owner-facing
  (`docs/v2/phase2-spending-rules.md`, "Near-threshold alerts"). The
  threshold itself is enforced on chain over a running total
  (`docs/v2/phase1-move-design.md`, R5).
- **The partner payout-instruction API**, keyed by the intent id as the
  idempotency key. It must build the instruction strictly from the intent's
  `beneficiary_ref` and refuse when they differ.
- **KYT attribution** of exchange addresses tagged as wallets.
