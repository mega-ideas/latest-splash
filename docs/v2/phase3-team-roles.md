# v2 Phase 3: Team, the Finance lead, and who may Add funds and Withdraw

Sky's decisions (31 Oct):

- Adding people, changing their role and removing them are an **owner's**
  action in Settings. They are not a Splash support action.
- An owner (the CEO) can give **one** person most of that: the **Finance
  lead**. Not wallet rotation, not bank accounts, not Add funds or Withdraw
  access, not removing owners, not their own limits, not their own role.
- **Anyone can fund the wallet**: money can be sent in from any wallet, and a
  deposit still follows the screening and holds of §4.3. **Who may use Add
  funds and Withdraw inside the dashboard** is granted by an owner only.
- Nothing in Move changes. Adding a signer to the on-chain multisig stays an
  owner-quorum action.

| What | Where |
|---|---|
| The rules and every write | `lib/server/team-admin.ts` |
| The routes | `app/api/team/**` (one gate: `lib/server/team-route.ts`) |
| What each person is offered, and the words | `lib/team/view.ts` |
| Settings → Team | `components/settings/TeamCard.tsx`, `components/team/*` |
| Add funds and Withdraw checks | `requireFundsAccess` in `lib/server/wallet-route.ts` |
| Tables | `wallet_finance_leads`, `wallet_member_access` (migration 0066) |
| Trail | `wallet_authority_events` (append-only) |

## Roles

The four roles are unchanged and still the only values of `memberships.role`:
viewer, staff (`maker`), approver (`checker`), owner (`admin`). Every existing
`role === 'admin'` check still means owner.

The **Finance lead** is not a fifth role. It is an appointment on top of a
membership (the same model as the person in charge): one open row per business
in `wallet_finance_leads`, held by an approver. It grants nothing unless that
person is **still an approver of that business right now**; moving them to
staff, viewer or owner, or removing them, ends it and writes a trail line.
Because it adds nothing to the role enum, a Finance lead fails every owner
check that exists, by construction, and an unknown new owner-only route is
refused for them without anyone remembering to say so.

## What each person may do

| | Owner | Finance lead | Everyone else |
|---|---|---|---|
| Add a person (viewer, staff, approver) | yes | yes | no |
| Add an owner, or move someone to owner | yes | no | no |
| Change or remove a viewer, staff or approver | yes | yes | no |
| Change or remove an owner | yes (not themselves) | no | no |
| Change or remove themselves | no | no | no |
| Appoint or take back the Finance lead | yes | no | no |
| Give or take away Add funds, Withdraw | yes | no (themselves included) | no |
| Start a request to add a signer | yes | yes | no |
| Remove an owner or set the recovery party (wallet) | yes | no | no |
| Rotate the wallet, bank accounts, funding sources, spending rules | yes | no | no |

Nobody changes or removes themselves, so a business always keeps an owner: the
owner who acts is, by that fact, still there.

An owner must name a person who already has a **verified Splash account** and
belongs to no business. A missing account, an unverified one and one that
belongs to another business all get the same answer, so the form cannot be used
to find out who has an account or where.

## Add funds and Withdraw

Owners have both. A staff member or an approver has one or both only when an
owner switched it on for them, separately. A viewer never. The decision is read
from the database on every request (`fundsAccessOf`), for the session's own
person in the session's own business; a stale row for someone who is now a
viewer or has left grants nothing.

- **Add funds**: funding quotes, a top-up, recording or rechecking a deposit,
  cancelling a top-up, and Transfer's step-3 top-up.
- **Withdraw**: a quote, the request, reading the business's bank accounts, the
  payout route, and one withdrawal's bank details. Adding a bank account and
  setting up the payout route stay owner-only. A withdrawal is still **asked
  for**: only the owners' quorum signs.

A member without the access sees no Add funds or Withdraw button (the Wallet
page, its phone row, Transfer, Batch and Home) and a sentence saying an owner
can turn it on; the routes refuse them anyway. While the page does not yet know,
it offers nothing.

Preparing a payment (a quote, a supplier payout, a batch review) is a different
gate (`requireWithdrawalRequester`: owners and staff) and is unchanged.

Funding **from outside** is unchanged: anyone can send USDC to the wallet
address from any wallet, and the deposit watcher still screens and holds it.

## The audit trail

Every grant, change and removal is a line in `wallet_authority_events`, which a
trigger keeps append-only: `member_added`, `member_role_changed` (with the old
and new role), `member_removed`, `finance_lead_appointed`,
`finance_lead_revoked`, `member_access_granted`, `member_access_revoked`, plus
the person-in-charge and offboarding lines that already existed. A line names
the actor, the person, and (for a role or access) what. Splash support's grant in
the staff console is a line too, under `operator:<email>`. A retry writes none:
adding a person twice, the same role again, granting what is granted and taking
back what is not are all no-ops that write nothing. Two requests at once make one
change (a unique index, or a conditional write).

Settings → Team shows the latest lines to an owner and the Finance lead, in plain
words ("Asha made Ben the Finance lead.").

## What the Finance lead means on the chain

The business wallet is controlled by its owners' passkeys (a multisig). The
chain has no concept of a Finance lead and **none was added**.

- The Finance lead can **start** a request to add a signer
  (`POST /api/wallet/business/members`, change `add_owner`), for a person an
  owner has already made an owner and who has a passkey. Nothing happens until
  the wallet's signers sign it on their own devices, each reading the decoded
  bytes first.
- A Finance lead who is **not** one of the wallet's signers cannot add a
  signature: the signing layer answers `not_a_signer`. If the same person were
  also an owner and a signer, they would sign as that, not as Finance lead.
- Rotation, removing an owner, the recovery party, creating the wallet and the
  single-signer consent are owner-only, unchanged.
- Removing a person from the team does not remove them from the multisig. If
  they were an owner and a signer, a change of signers (an owner-quorum
  request) is the step that does, and Settings says so.

`tests/team-finance-lead-wallet.test.mjs` runs that on the model chain.

## Settings → Team

Owners see everyone with their email, role, whether they are the Finance lead or
in charge, what they may do with Add funds and Withdraw, and their spending
rule. **Manage** opens one person: role (saved by its own button), Add funds and
Withdraw switches (owners only, saved as they are switched), Make or take back
Finance lead (owners only), and Remove, which asks first and says what ends with
it. **Add a person** takes an email and a role. The Finance lead sees the same
list with only what they may do, and none of the owner-only controls. Someone
who manages nothing sees who they are and whether they can add funds and
withdraw, and that their owners manage the team.

The team is managed without a business wallet (it needs only the database), so
an owner can add people before the wallet exists. The person in charge, rules
and signers still need the wallet.

## Tests

`tests/team-roles.test.mjs` (the service on a real database: every action, every
refusal, cross-tenant, replay, concurrency, the trail),
`tests/team-routes.test.mjs` (every route's gate and wiring, and that nothing
else changes the team), `tests/team-view.test.mjs` (what is offered and the
words), `tests/team-finance-lead-wallet.test.mjs` (the chain side).

## What needs Sebastian (Move)

Nothing in this change touches `move/`. If Sky wants the **Finance lead to be
known on chain** (for example a signer tier that can only add approvers, or a
threshold rule that counts the Finance lead differently from an owner), that is
a Move change and Sebastian approves every file under `move/`. Today the role is
Splash's, not the chain's.
