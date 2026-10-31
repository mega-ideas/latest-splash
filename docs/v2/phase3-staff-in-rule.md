# v2 Phase 3: staff payments inside a rule

Sky's rule: anyone can fund the wallet, but they can only spend what the rule
allows, and anything outside the rule needs the person in charge.

A staff member who has a spending rule pays alone from Transfer when the
**amount**, the **recipient** and the **time window** all fit the rule. The
payment goes through `splash_spend::pay_intent` under the person's allowance
and is signed by that person's own passkey. Anything else becomes an ask to the
owners, and Transfer says why in plain words (the amount is above the person's
limit, the cap is used up and renews in 14 hours, the recipient is not on the
rule).

No Move code changed. Nothing here signs or sends on any network.

## The path

```
Transfer step 4 (staff)              POST /api/wallet/transfers { …, via? }
        │                                         │
        ▼                                         ▼
 lib/transfer/plan.ts  ◄── the same rule ──►  lib/server/wallet-transfers.ts
 (page: says why)                              createTransfer → decideStaff
                                                     │
                       reads the chain: readStaffRule (spend-rules.ts)
                                                     │
              ┌──────────────────────────────────────┴───────────────────────┐
         fits the rule                                              outside the rule
              │                                                              │
   claim + in-flight read, one step                          via 'rule' → 409 outside_rule, nothing stored
   under a lock per person                                   otherwise  → an ask to the owners, reasons in the note
              │
   openStaffRulePayment (spend-rules.ts)
   staffRulePaymentTx → openSigningRequest
   purpose staff_rule_payment, one signer
              │
   the person reviews the decoded bytes on their own
   device and signs with their passkey; Splash sponsors
   the gas and submits at the first signature
```

The transaction (`staffRulePaymentTx`, `lib/server/spend-rules-builders.ts`) is
five commands from the staff member's own passkey address:

1. `splash_spend::create_intent<USDC>` as STAFF on the business's current policy
2. `0x1::option::none<PayoutApproval>`: no second approval, it is inside the rule
3. `splash_spend::pay_intent<USDC>` drawing the principal and the fee bound from the
   person's allowance (the unused part of the fee goes back to the wallet)
4. `audit_anchor::anchor` with the receipt
5. `payment_intent::delete_finalized`

It always declares kind WALLET (the tag the owners verified after the payee's
ownership proof). A rule pays no exchange, bank or other chain.

## Who checks what

The same question is asked four times, by four different things, so no one of
them has to be right alone.

| Layer | What it checks | Where |
|---|---|---|
| The page | Plans with the rule it read, says which route and why | `lib/transfer/plan.ts`, `StepReview.tsx` |
| The server, before it builds | Re-reads the rule from the chain, runs **the same function**, counts payments already on their way; a stale page cannot claim a rule the chain does not show | `createTransfer` → `decideStaff` |
| The signing layer | The bytes are decoded again, must be exactly the five commands above, sent by the person the rule is for, to the payee, for the amount and fee bound stored, drawing exactly amount plus fee under the stored allowance and policy; the dry run must pass; the recipient is re-screened before each signature | `describeWalletTransaction`, `assertPurposeShape('staff_rule_payment')`, `paymentBeforeSign` |
| The chain | `splash_spend::pay_intent` (recipient verified for this kind, per-payment maximums, running total against the threshold, fee ceiling) and the allowance itself (cap window, lifetime cap, start, expiry, spender) | Move, as built |

### What the server refuses, and the words

| Situation | `via` absent | `via: 'rule'` |
|---|---|---|
| No rule | ask, `no_rule` | 409 `outside_rule` |
| Rule ended / not started / taken back | ask, `rule_expired` / `rule_not_started` / `rule_revoked` (a rule the owners removed whole reads `no_rule`) | 409 `outside_rule` |
| Rule ends before the payment could be signed | ask, `rule_ends_soon` | 409 |
| Over the rule's per-payment limit | ask, `over_payment_max` with the limit in the words | 409 |
| Cap window used up | ask, `cap_used_up` with when it renews | 409 |
| Cap too small for this one | ask, `over_cap` with what is left | 409 |
| Recipient not on the rule | ask, `recipient_not_on_rule` | 409 |
| Exchange account | ask, `exchange_needs_owners` (its Travel Rule message goes first) | 409 |
| Running total above the second-approval threshold | ask, `above_threshold` | 409 |
| Another asset than USDC | 400 `wrong_asset`, for staff and owners alike | same |
| Recipient not a fresh CLEAR / not a proven wallet | refused with the screening or recipient reason | same |
| Funds on hold | 409 `funds_on_hold` | same |
| No chain client for spending rules | ask, `staff_rule_not_wired` | 503 `staff_rule_unavailable` |
| Chain unreadable | ask, `policy_unreadable` | 502 `rule_unreadable` |
| No gas sponsor | ask, `staff_rule_not_wired` | 503 `no_sponsor` |
| Rule held by a passkey that cannot sign here | ask, `rule_needs_passkey` | 409 `no_passkey_for_rule` |

`via: 'rule'` is what the page sends when it said "within your spending rule":
if the server finds otherwise it answers with the reason, the page reads the
rule again, and nothing is quietly turned into an ask. `via: 'ask'` always asks.
An owner's payment is the owners' whatever `via` says.

Nothing falls back to a stand-in: no mock rule, signer, sponsor or chain read is
reachable in production or out of it. In production, without the chain client,
a staff member who insists on paying alone gets 503 and nothing is stored.

## Races and replay

- **Intent id.** `wallet_transfers` is unique on `(org, client_key)`: the same
  intent id with the same payment answers the payment already made; another
  payment under it is 409; two sends racing make one. The chain's payment
  reference (a hash of the business and the intent id) is claimed once, ever.
- **The last of a cap.** A payment the chain has not counted yet is invisible
  to the chain's own figures. The claim and the read of what this person has
  already asked for (requests collecting or on their way, a claim being made,
  and requests that executed after the rule was read) are one step under an
  advisory lock per person, with the plan run again over them. Two sends
  racing for the last of a cap: one pays alone, the other is asked of the
  owners with `over_cap`. A request that is withdrawn, declined, expired or
  failed holds nothing. The chain would refuse the second anyway; this keeps
  the person from being told otherwise, and keeps a failed transaction out of
  their history.
- **Two staff.** Each has their own allowance. Both go through, independently.
- **The same recipient through several spenders.** The chain checks the
  second-approval threshold per (payer, recipient), so several spenders can
  each stay under it. That stays detective (`near_threshold_repeat`,
  `same_recipient_many_spenders`): the alerts read the running totals and
  `RuleSpend`, which these payments produce. A test pays one recipient through
  two spenders and shows the alert.
- **A signature sent twice** is refused once the request has closed, and the
  same transaction cannot land twice.

## Ask: who is told

The ask carries the reasons in its note, so the owners see why it came to them.
Owners are told as before. The Finance lead, where the role allows, is told too
and sees the ask as an approver, but only an owner can accept it (403
`not_an_owner`).

## Tenancy

`createTransfer` takes the org from the session. The spending-rule context is
refused if it was made for another business (`sc.orgId`). A staff member's
request, recipient and transfer are absent from another business by id (404);
a request can be read and signed only by its signer, and the person who asked.

## What changed

| | |
|---|---|
| `lib/transfer/plan.ts` | The rule, with the dates, asset, in-flight payments and the reasons; `approvalReasonLines` says them with numbers |
| `lib/transfer/context.ts` | The rule's dates and renewal from the allowance that would pay |
| `lib/server/spend-rules-builders.ts` | `staffRulePaymentTx` |
| `lib/wallet/wallet-tx-describe.ts` | `expect.staffPay`; understands the five commands; allowance withdrawals only as `pay_intent`'s argument |
| `lib/server/wallet-signing.ts`, `-store.ts` | purpose `staff_rule_payment`; the stored payment the bytes must match |
| `lib/server/spend-rules.ts` | `readStaffRule`, `openStaffRulePayment` |
| `lib/server/wallet-transfers.ts` | the decision, the lock, the route `staff_rule`, `via`, `asset`, `plan` |
| `lib/server/payment-approval-asks.ts`, `approval-requests.ts` | the Finance lead is told of an ask |
| `app/api/wallet/transfers/*` | `via`, `asset`, `plan`; the context reports `staffRulePaymentsWired` from the business, not a constant |
| `components/transfer/*`, `components/approve/ApproveDetail.tsx` | the words and the signing panel |
| `drizzle/0068_staff_rule_payments.sql` | the purpose and the route the tables allow; an index for the in-flight read |
| `tests/staff-rule-*.test.mjs`, `tests/fixtures/spend-world.mjs` | the tests, and the model chain's staff payment |

## Not done here

- **A payment above the threshold, or one that needs an owner's second
  approval, is not paid by the staff member.** It goes to the owners, who pay it
  from the wallet. The `approve_payout` route for an intent a staff member
  opened (`docs/v2/phase2-spending-rules.md`) stays as built; opening and
  sharing an intent for it from Transfer is not built.
- **An exchange account is not paid under a rule.** Its Travel Rule message is
  sent first and is keyed to the payment; owners send it. A rule pays wallets
  the supplier holds and has proven.
- **A bank payout and USDC to another chain** are the owners' (unchanged).
- **No testnet run.** The five-command PTB, in particular `pay_intent` taking
  an `AllowanceWithdrawal` input and an empty `Option<PayoutApproval>` made by
  `0x1::option::none`, follows the Sui SDK's allowance guide and the Move tests.
  Simulation refuses a shape the chain rejects before anyone signs, but none
  has been simulated on a network. The hardware check of a passkey's signature
  on a sponsored single-signer transaction is part of the owed Phase 2 run.
- **Gas.** The operator sponsors each payment (the cap is the business's 1 SUI
  in 24 hours already counted by the signing layer).
