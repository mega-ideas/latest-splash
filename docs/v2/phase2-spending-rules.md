# v2 Phase 2 §4.2: spending rules (sub-accounts)

Spec: `SPLASH_SUI_V2_PROMPT.md` §4.2 and decision D2; review items A2–A4 and
B8–B10 of `SPLASH_SUI_V2_CODE_REVIEW.md`; amendment A1 §2.3 (the WALLET tag).
It is the backend Settings → Team & rules (Phase 3) calls, on top of the
Phase 1 Move API (`docs/v2/phase1-move-design.md` §5) and the §4.1 signing
flow (`docs/v2/phase2-business-wallet.md`).

## What a rule is

A **spending rule** is two things on chain:

1. An **app-bound allowance** (`0x2::allowance`) from the business wallet to
   one staff member's address, bound to `splash_spend::SPLASH_SPEND`, named
   `splash-policy:<policy id>` (64 hex digits). It carries the rule's
   **recurring cap** (per day: `periodic_rate_limit(86_400_000, cap)`, a
   24-hour window from the first charge; or per calendar month:
   `monthly_rate_limit(cap)`, renewing on the first charge's day at 00:00 UTC,
   clamped to short months), its **expiry** (required here), optionally a
   start and a **lifetime cap**. The allowance charges what each payment
   withdraws: the principal **plus the fee bound** the spender signed for
   (A1 §2.6, at most 1% of the principal). The unused part of the fee goes
   back to the wallet, but the cap has counted it.
2. The staff member's place on the business's **SpendPolicy** (one per
   wallet generation), with their own **per-payment maximum** (no higher
   than the business's).

The policy itself is business-wide: verified **recipients** (tagged WALLET or
EXCHANGE), bank **beneficiaries** bound to their partner deposit address, the
business's per-payment maximum, the **second-approval threshold** (default
10,000 USDC) and the **running-total window** (default 24 hours, an hour to
thirty days; decision 4: split payments to one recipient count together).

Inside the rule a staff member pays alone (`splash_spend::pay_intent`, from
their own device). Above the threshold, one owner's second approval
(`approve_payout`). Outside the rule (over the per-payment maximum, past the
cap, to an unverified recipient), the owners pay it from the wallet. Either
way the staff member asks through an **approval ask**
(`POST /api/wallet/approval-asks`).

## Modules

| File | What it does |
|---|---|
| `lib/server/spend-rules-builders.ts` | The PTBs: `create_policy`, every policy mutator, `allowance::revoke`, the rate limit, `option::some`, `propose_for_app` + `accept`, and `approve_payout`. Offline, sponsored like every wallet transaction. No `rotate_spender`, no `allowance::new`, no spend. |
| `lib/wallet/wallet-tx-describe.ts` | Now also reads those commands (only with splash_spend configured) and refuses: an allowance for any other app, a non-USDC rule, a proposal not accepted in the same transaction, a name for another policy, a policy, allowance or cap that is not this business's (`expect.spend`, read from the chain and stored with the request), a recipient off Sui, `rotate_spender`, `allowance::new`. |
| `lib/server/wallet-signing.ts` | Three purposes: `spend_policy`, `spend_rule` (only the policy and allowance commands above, one policy, a recurring cap and an expiry on every rule, and the WALLET tag only for proven addresses), `spend_approval` (one `approve_payout`, naming the expected payer, lasting no longer than its settle-by time). |
| `lib/wallet/allowance-window.ts` | The window maths, ported from `allowance::index_at` / `elapsed_windows` / `civil_from_ms` and `spend_policy::counted`. |
| `lib/wallet/spend-rules-bcs.ts` | BCS layouts of `Allowance`, `AllowanceCap`, `SpendPolicy` and its table entries, `RuleSpend`; the allowance name; the policy id (`derived_object` under the `PolicyRegistry`). |
| `lib/server/spend-rules-index.ts` | Pure: the rules as the chain has them now. |
| `lib/server/spend-rules.ts` | The flows (below). |
| `lib/server/ownership-proofs.ts` | The WALLET-tag gate (`wallet_ownership_proofs`, migration 0036). |
| `lib/server/spend-rules-deps.ts`, `-env.ts`, `-route.ts` | Live chain reads, `SPLASH_SPEND_PACKAGE_ID` and `SPLASH_SPEND_POLICY_REGISTRY_ID`, the route front. |
| `app/api/wallet/spending-rules/*` | Routes for Phase 3. |

## Flows

Every change is signed by the wallet's quorum through the §4.1 signing flow:
the server builds the bytes, decodes them, checks their shape, the sponsor
and the per-business gas budget, simulates them, and only then asks the
signers. A second approval is signed by one owner's own passkey.

| Route | Who | What |
|---|---|---|
| `GET /api/wallet/spending-rules` | any member | The index (below). Owners and approvers see every rule; anyone else only their own. |
| `POST /api/wallet/spending-rules/policy { perPaymentMaxMinor }` | owner | Create the policy for the current wallet generation (`spend_policy`). Once per generation. |
| `PATCH /api/wallet/spending-rules/policy { perPaymentMaxMinor?, secondApprovalThresholdMinor?, runningWindowMs? }` | owner | `set_limits`, `set_running_window`. |
| `POST /api/wallet/spending-rules { staffUserId, perPaymentMaxMinor, cap: { period, limitMinor }, expiresAtMs, startsAtMs?, lifetimeCapMinor?, recipients? }` | owner | Give a rule: `add_spender` (STAFF) and `propose_for_app` + `accept`, with any recipient changes, in one transaction. The address is the staff member's own active passkey here, never one from the request. Refused: a viewer, someone of another business, a per-payment maximum above the business's, a zero cap, an expiry in the past or more than a year away, a second rule for the same person. |
| `PUT /api/wallet/spending-rules/:staffUserId` | owner | **Change = revoke + reissue**: the rule's allowance is revoked and a new one issued in the same transaction. A changed per-payment maximum also removes and re-adds the spender (Move's only way), which retires every outstanding approval (`generation`); an unchanged one leaves the spender alone. Running totals stay: they are the address's. |
| `DELETE /api/wallet/spending-rules/:staffUserId` | owner | **Revoke**: every allowance the current wallet gave this person is revoked (`allowance::revoke`, which destroys it with its cap) and they are removed from the policy, which also stops their open intents at once. |
| `POST /api/wallet/spending-rules/recipients { add, remove, addBeneficiaries, removeBeneficiaries }` | owner | Verify or remove recipients and bank beneficiaries. |
| `POST /api/wallet/spending-rules/reissue {}` | owner | After a rotation (below). |
| `POST /api/wallet/spending-rules/reissue { revokeStaleFrom }` | owner | The old wallet's quorum revokes the allowances it funded. |
| `POST /api/wallet/approval-asks/:id { action: 'accept', mode: 'second_approval', maxFeeMinor, settleByMs }` | owner | One owner's `approve_payout` for a staff member's payment within their rule but above the threshold: the staff member is the payer, `max_total` is the principal plus the fee shown (at most 1%), the deadline is the quote's. Not by the maker or the payer; the payer must be on the policy. |

### The WALLET tag (A1 §2.3)

A recipient tagged WALLET is charged Splash's wallet fee (0.02%, min 0.25
USDC) and is a self-custody address, which D5 allows only after the payee
signs an ownership proof. §4.7 builds the proof; this section builds the
gate: an address may be verified with the WALLET tag only while
`wallet_ownership_proofs` holds a live row for this business (another
business's proof does not count). Refused before anything is built
(`409 ownership_not_proven`, with the addresses), and again by the signing
flow's shape check if bytes tagging an unproven address are put to it. An
EXCHANGE tag needs no proof.

## The index

Allowances emit no events, so the rules are read from:

- the `AllowanceCap<Balance<USDC>>` objects each wallet of the business
  (current, and earlier ones still on record) owns; a cap that is gone
  means the allowance was revoked;
- the shared `Allowance` each cap points to (BCS): funder, spender, app,
  name, lifetime cap, start, expiry, the rate limit's `limit`, `spent`,
  `anchor_ms`, `index` and window, and `current_spend`;
- the business's `SpendPolicy` for the current generation, its id derived
  from the account and `wallet_epoch` under the `PolicyRegistry`, with its
  tables (spenders, recipients, beneficiaries, running totals) read entry by
  entry;
- `splash_spend::RuleSpend` events for that policy (the intent, allowance,
  approval, recipient, kind charged and fee of each payment), newest first.

For each staff member on the policy:

- **live spend**: `current_spend` (everything ever charged) and what is left
  of a lifetime cap;
- **the window**: its limit, what was spent in the window that is current
  now, what is left, when it started and ends. The `spent` an allowance
  stores is reset only by the next charge in a later window, so a window
  that has passed is shown as the next charge will see it: rolled over, with
  its whole cap (review B8: "remaining matches `current_spend` after window
  rollover (UTC, fixed windows, month-end rule)");
- **spendable now**: the smaller of the window's and the lifetime's
  remaining, zero unless the rule is active;
- **expiry** and a status: active, not started, expired, or no allowance
  (revoked);
- **running totals toward the second approval**, per recipient (or bank
  beneficiary): what the threshold check counts now (this window and what it
  still carries), until when, and how much more can be paid before an owner
  must approve; `nearThreshold` at 80%;
- **recent payments** from `RuleSpend`.

An allowance of the current wallet whose spender is no longer on the policy
is `unattached` (it cannot pay; revoke it). One funded by an earlier wallet
or named for an earlier generation's policy is `stale`.

## After a rotation

A rotation moves the account to a new wallet generation. The earlier
generation's policy stops paying (`splash_spend` checks the generation),
and its allowances are funded by the old wallet, whose USDC has moved: the
index shows them `stale` and `reissueNeeded`, and no rule can be given until
the new wallet has its policy.

`POST /api/wallet/spending-rules/reissue` creates the new wallet's policy
(with the earlier per-payment maximum), and once that lands it opens, by
itself, one request that copies the earlier generation's limits, window,
recipients (a WALLET tag only while its proof still holds), beneficiaries,
staff spenders, and each unexpired rule's allowance with the same cap and
expiry (a lifetime cap carries what is left of it). What could not be
carried is listed in `skipped`: an expired rule, a cap that is neither daily
nor monthly, a used-up lifetime cap, a WALLET recipient whose proof was
withdrawn, the operator's executor rule. The old wallet's own quorum then
revokes the stale allowances (`{ revokeStaleFrom }`); nothing else moves.

## Open, not built here

- **Running totals restart after a rotation.** The new policy's totals are
  empty, so a staff member could pay up to the threshold again to a
  recipient they paid just before the rotation. Rotations are owner
  decisions and rare; the Move cannot carry another policy's totals.
- **RuleSpend is read from the most recent events chain-wide** (four pages
  of fifty), filtered to the policy. For a busy chain the list is recent
  payments only; the amounts that matter (`current_spend`, the window, the
  running totals) come from the objects, not the events.
- **The operator's executor rule** (scheduled payments and batches) is not
  exposed: only STAFF rules are given here.
- **The ownership proof itself** (§4.7): the gate reads the table, which
  nothing writes yet but `recordOwnershipProof`.
- **No testnet run.** The PTB shapes (in particular `propose_for_app`'s
  result going straight into `splash_spend::accept`, and a rate limit made by
  a Move call wrapped in `option::some`) follow the Sui TypeScript SDK's own
  allowance guide and the Move tests, and simulation refuses a shape the
  chain rejects before anyone signs, but none has been simulated on a
  network.
