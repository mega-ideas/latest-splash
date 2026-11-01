# v2 Phase 3, brief 5.9: Everything else

Recipients, History, Settings and Setup. Same style as the rest of the
dashboard (the same `dash-surface` cards, kicker, tokens and spacing); the
words and the data follow the decisions in the brief. Each page is a thin
route over a component folder and a pure module that words the facts; nothing
on any of them is invented, and nothing on them names a business, a wallet or
an address of the page's own choosing: every call goes to a route that reads the
signed-in person's own business from the session (`requireSessionAccount`).

| Page | Route | Components | Words and rules (pure) |
|---|---|---|---|
| Recipients | `/dashboard/recipients` | `components/recipients/` | `lib/recipients-page/` |
| History | `/dashboard/history`, `/history/[ref]`, `/history/batch/[id]` | `components/history/` | `lib/history-page/entries.ts` |
| Settings | `/dashboard/settings` | `components/settings/` | `lib/team-rules/`, `lib/settings-page/` |
| Setup | `/dashboard/setup` | `components/onboarding/SetupStepper.tsx` | `lib/setup-page/view.ts` |

## Recipients

Five types, in the order the brief names them: bank account, Splash business,
exchange account, self-custody wallet, another chain. Each row says where it
stands in words, in the order the payment gate checks (`walletDeliveryGate`):
a failed screening, a proof the supplier has not given, a screening still to
do, an owner's approval. Only the buttons the server would accept from that
role are shown: send the proof link, approve (an owner, never for what they
saved themselves), withdraw a proof and remove (both ask first). A viewer
reads and changes nothing. An exchange is described by its role, never by name
(`SIGNED_PARTNERS` is empty). Adding a wallet recipient is the form Transfer
step 2 uses. The list route no longer sends the business id, the supplier's
email, the travel-rule record or a whole bank account number.

## History

One list of the business's payments, batches and withdrawals (and the earlier
transfers of the first product, marked as earlier), newest first, each with
its receipt. A payment the owners have not accepted has no receipt and says so.
"Sent this month" counts only what was paid, this month, in USDC. The export
is a plain table with the receipt path; a cell that starts like a formula is
made text. It carries no fee: the list knows only the most a fee could be, and
the chain's charge is on each receipt. The page asks again every 15 seconds
only while something can still change by itself (in progress, or a failed
withdrawal whose USDC is on its way back) and the tab is visible. A count is coloured
as an alarm only when it is not zero.

A row is in exactly one of four groups, each with its own filter and count:
**Paid**; **In progress** (moving, or waiting for a person); **Failed**
(something broke: a payment, batch or withdrawal that did not go through, a
withdrawal that came back, an earlier transfer that failed or was refunded);
**Not paid** (a person declined, cancelled or withdrew it, or the time to sign
ran out). A payment or batch whose request its sender took back, or that the
owners declined, is Withdrawn or "Declined by Aisha" under Not paid and
never Failed: the history reads the request's close, not only its status.
Who declined comes from the signing request's own record (`declined_at` on its
signers, or the owner who declined a staff member's ask), in the order they
declined: "Declined by Aisha", "Declined by Aisha and Ben", "Declined by Aisha,
Ben and 1 more", and "Declined by an owner" when no usable name is on record.
A name is cleaned to plain words (no link, markup, number or symbol; at most
30 characters) by `lib/team/declined-by.ts`, read only through the business's
own request (another business reads none of it), and said the same in History,
the batch list and the batch's own page. "Withdrawn" names nobody, even if an
owner had declined before the sender took the request back
(`tests/declined-by.test.mjs`, `tests/declined-by-history.test.mjs`). A failed row carries two sentences in plain words, what happened and
what to do next, from `EXPLAIN` in `lib/history-page/entries.ts`. Failed takes
the alarm colour; Not paid never does. When a refresh fails the loaded counts
and list stay, and one sentence above the list says they are the last ones
loaded for a list that has answered before, and that a list that never
answered is missing from them (`mergeLists` reports it as `missing`). The
sentence sits in a live region that is always on the page. `tests/history-failed.test.mjs` holds these rules.

## Settings

Sections an owner can reach by name: Team, Spending rules (with the spending
policy), Signers, Funding sources, Approvals, Upgrade alerts, Billing (only
when `FEATURE_SUBSCRIPTION_BILLING` is on; it is not, and the card, its routes
and the cron answer as if absent), Controls, How Splash operates.

- **Team and rules (4.2).** An owner gives, changes (revoke and reissue, what
  was spent carries over) and takes back a rule; sets the policy (the most any
  payment under a rule may be, the amount at which an owner approves, default
  10,000 USDC, the window that adds one recipient's payments together); and
  chooses which verified recipients staff may pay alone. Each is a request the
  owners sign on their own devices (`SignFlow` over `SignPanel`: the device
  decodes the bytes before anyone signs) and takes effect at once. Owners' own
  changes have no cooldown; Splash's own changes keep the 24-hour notice and
  appear under Upgrade alerts. A rule shows its live spend, what is left of its
  window, when it renews and when it ends, read from the chain as it stands now.
  Near-threshold flags (owners only) and the housekeeping a rotation leaves
  (a reissue, rules of people who left) are said in one place with the button
  that fixes them.
- **Team (Sky, 31 Oct).** The owners run the team here, not Splash support: add
  a person by email with a role, change a role, remove, choose who may use Add
  funds and Withdraw, and name one Finance lead who can do the adding, changing
  and removing for viewers, staff and approvers. Each change is a line of the
  trail, shown under Recent changes. It works before a business wallet exists. See
  `phase3-team-roles.md`.
- **Person in charge.** An owner appoints and takes back the person who signs
  off a team member's move of their own USDC (see the Wallet doc). The team is
  read once and shared by the list and the appointment.
- **Signers and wallet rotation (4.1).** "2 of 3", who, and a change of
  signers the current signers approve and the new signers confirm.
- **Funding sources (4.3), Approvals, Upgrade alerts.** The Wallet page's
  sections, here by name. Upgrade alerts read the governance monitor's state
  (`FeeScheduleProposed`, `FeeRecipientProposed`, upgrades), the same one the
  layout banner reads.
- **How Splash operates.** What is true: the business's USDC is in its own
  wallet, Splash has no key; Splash is software that prepares payments for the
  owners to approve; local-currency payouts are made by partners; Treasury is
  USDY in the business's own wallet (not Shariah); records are encrypted;
  Splash's changes keep a 24-hour notice. No custody, licence or regulator
  progress claim and no sweep ladder.

With no business wallet the page says so once, in one card, and shows only what
does not need a wallet (`lib/settings-page/wallet-gate.ts`); a request waiting
for an owner's signature is shown while the wallet is being set up.

### Refusals for a customer

`lib/server/wallet-route.ts` and the bill payment flow word a refusal for a
missing server setting or an unreachable chain as a sentence ("Business wallets
are not available for your workspace right now. Nothing was changed.") with the
status unchanged (the Wallet and Home pages read 503 as "not open yet"). The
reason is written to the server log, never sent to the browser
(`lib/server/wallet-refusal.ts`).

## Setup

Four steps are required (terms, business profile, verification, approvals); the
fifth, a first recipient, is optional and never counted. The page says how many
are done, which is next (the first still to do, in order; a step waiting on
someone else, such as verification in review, is not the next), and, once the
four are done, that setup is complete and what usually comes next (create the
business wallet, save a first recipient, give the team their rules). Each step in
the rail links to its card; a step already done takes less room. An unreadable
state is a sentence a customer can act on.

## Tests

`tests/recipients-page.test.mjs`, `tests/history-page.test.mjs`,
`tests/settings-team-rules.test.mjs`, `tests/setup-page.test.mjs` and
`tests/everything-else-review.test.mjs` (refusals for a customer, the
no-wallet page, a phone's columns, pressing twice). The chain rules behind
Team and rules are tested in `tests/spend-rules.test.mjs`; the recipient gates
in `tests/wallet-recipients*.test.mjs`.

## Second review (the independent findings)

What an independent reviewer found, and what the pages now do:

- **Remove, on a wallet that is on the spending policy.** The policy is on the
  chain; this page's list is Splash's. An owner's Recipients page reads the
  policy, and the Remove step says when the address stays allowed (staff can
  still pay it under their rule until the owners Stop allowing it) and links to
  Settings. When the policy cannot be read it says what to check.
- **Approve for payment** opens a step with the recipient's name and type, the
  screening result and the whole address with a copy button. It is offered only
  once the address screened clean (and, for a wallet, was proven).
- **History** folds its four lists one by one (`mergeLists`): a list that fails
  keeps what it held and is named in a sentence; the empty-state sentence shows
  only when every list answered. A viewer's 403 is the business's rule, not a
  failure, and a viewer is not given a withdrawal receipt link they cannot open.
- **Settings** builds its privacy line from Zeke's own disclosure lists. The
  Team card waits instead of flashing an empty alert; Change this rule keeps the
  rule's end date; Operating controls are read-only for everyone but an owner or
  a finance admin, with one line saying how the dollar limits differ from the
  spending policy; near-threshold is said once; the wallet refusal is logged
  once per business per ten minutes without an address.
- Smaller: an older bank entry is not called verified; staff are offered the
  proof link only when an email is on file; two Splash businesses with one name
  and different wallets are two rows; filters are toggle buttons at 44px; the
  add-recipient chooser too; a single payment's receipt polls only from a visible
  tab and can be asked for again; the Setup rail marks the optional step.

Not changed: a bank account on the policy is named there by a commitment the
Recipients page does not hold, so Remove on a bank account does not warn about
it. A business that changes its wallet shows as a second row on Recipients.

Tests: `tests/p3-59-second-review.test.mjs`.
