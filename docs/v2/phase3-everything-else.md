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
only while something is in progress and the tab is visible. A count is coloured
as an alarm only when it is not zero.

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
