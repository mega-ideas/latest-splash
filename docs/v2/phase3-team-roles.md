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
| Invitations, and leaving | `lib/server/team-invitations.ts`, `lib/server/team-leave.ts`, `lib/server/team-leave-rules.ts` (migration 0073) |
| Tables | `wallet_finance_leads`, `wallet_member_access` (migration 0066); `team_invitations`, `team_leave_requests` (migration 0073) |
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
| Add a person directly (viewer, staff, approver) | yes | yes | no |
| Send an invitation (viewer, staff, approver) | yes | yes | no |
| Send an invitation for an owner | yes | no | no |
| Withdraw an invitation | yes (any) | yes, below owner | no |
| See the requests to leave | yes | yes | no |
| Decide a request to leave (anyone) | yes, never their own: an owner's leaving needs another owner | no (an owner decides) | no |
| Ask to leave | any member (the only owner cannot) | yes, and an owner decides it | any member |
| Add an owner, or move someone to owner | yes | no | no |
| Change or remove a viewer, staff or approver | yes | yes, unless that person is in charge of sign-offs or holds Add funds or Withdraw | no |
| Change or remove an owner | yes (not themselves) | no | no |
| Change or remove themselves | no | no | no |
| Appoint or take back the Finance lead | yes | no | no |
| Give or take away Add funds, Withdraw | yes | no (themselves included) | no |
| Start a request to add a signer | yes | yes | no |
| Remove an owner or set the recovery party (wallet) | yes | no | no |
| Rotate the wallet, bank accounts, funding sources, spending rules | yes | no | no |

**A business always keeps an owner.** Nobody changes or removes themselves, so
the owner who acts is still there. Two owners acting on each other at the same
moment is the case that rule does not cover, so changing or removing a member
runs in one transaction that first locks the business's owner rows (`SELECT ...
FOR UPDATE`) and then reads again: the second of two simultaneous changes finds
the first and is refused (403 if its actor is no longer an owner, 409
`last_owner` if the change would leave no owner). Splash support's console
(`revokeRole`) takes the same lock and refuses to remove a business's only
owner; to replace one, add the new owner first. The test database serialises
transactions, so `tests/team-roles-hardening.test.mjs` proves the rule and the
rollback; the row lock is what protects a deployment with several connections.

**The Finance lead and what an owner granted.** The lead may not change Add
funds or Withdraw access or the person in charge, and moving or removing the
person who holds one ends it. So the lead cannot change the role of, or remove,
someone who is in charge or holds Add funds or Withdraw (403 `owner_only`); an
owner takes that back first, or does the change. Settings does not offer Manage
on such a person to the lead and says an owner changes them.

## Adding a person: invite, or add directly

Sky's decision of 1 Nov: an added team member either accepts an invitation or
is added directly, **at the owner's choice**. Settings, Team, Add a person
offers the two in plain words, and invitation is the one selected first.

**Add directly** keeps what it always was. The owner names a person who already
has a **verified Splash account** and belongs to no business. A missing account,
an unverified one and one that belongs to another business all get the same
answer, so the form cannot be used to find out who has an account or where.
There is no step on the person's side, so the owner ticks "I have checked that
this is the right person" first, and `POST /api/team` refuses without
`confirmed: true` (`confirm_person`, before anything is written).

**Send an invitation** (`POST /api/team/invitations`):

- Any email may be invited. An address with no account yet simply waits until
  that email signs up and **verifies**; the sender hears the same thing whether
  the address has an account, has none, is unverified or belongs to another
  business (tested), so this tells nobody who has an account.
- The person sees it after signing in, found by the signed-in account's own
  **verified** email (`GET /api/team/invitations/mine`, a banner on every
  dashboard page). An unverified account is shown nothing. They **accept**
  (joins with the invited role; `grantedBy` is the sender) or **decline**
  (final).
- It **ends 7 days** after it was sent, to the millisecond. The first look after
  that marks it ended and writes one trail line. The owner (or the Finance lead
  for a role below owner) can **withdraw** it any time before an answer.
- One open invitation per business and email. The same again is the same
  invitation (no second line); a different role is refused until the first is
  withdrawn. At most 25 open invitations per business.
- It is honoured only while the person who sent it still manages the team and
  the role is within their reach. If the sender was removed, or the Finance
  lead role was taken back, the invitation is closed on the trail when it is
  next touched (`inviter_no_longer_manages`) and cannot be accepted.
- **A person already on another business is told plainly**: "You already belong
  to a business, and a person can belong to one business at a time. You cannot
  accept this invitation. You can decline it." Nothing about that business is in
  the answer (tested), and nothing changes.
- **No token.** There is no link, code or secret: the signed-in person's own
  verified email finds the invitation. So there is nothing to put in a URL or a
  log, to forward, or to replay, and `team_invitations` has no such column
  (tested). The invitation id is random (`inv_` and a UUID) but grants nothing:
  for anyone else it reads as "not found", exactly like an id that does not
  exist. Accepting twice is "already joined" (one membership, one trail line),
  and accepting or declining after any other outcome is refused
  (`no_longer_open`, or `expired`).
- Two businesses inviting the same person: whichever is accepted first wins and
  the other is refused with the plain sentence above; a race between two
  accepts rolls back the later one.

Nothing is emailed: the invitation is waiting when the person signs in. If Sky
wants a notification email as well, it goes through the Resend adapter (with a
sandbox implementation, failing closed in production without a key), and the
email would carry no link that grants anything.

## Leaving the team

A member **cannot leave without an owner's approval.** From Settings, Team,
Leave this business, any member (every role) can **ask to leave**
(`POST /api/team/leave`).

- **Nothing changes when they ask.** They keep their access, their spending
  rule and their place in charge until an owner approves. Asking twice is the
  same request. They can withdraw it.
- **The last owner cannot leave** (`last_owner`, in words, and the page says why
  instead of offering the button). **An owner leaving needs another owner**:
  nobody decides their own request (`own_request`).
- **Who decides** (one rule, `leaveDecisionRefusal` in `lib/team/view.ts`, used
  by the server and the page): **an owner alone**, for anyone but themselves
  (Sky: approval comes from the highest authority). The **Finance lead** sees
  every request and decides none: approving ends access at once but the lead
  cannot take the person's spending rule back, so a lead's approval would leave a
  live rule behind. Everyone else decides nothing. (A first build let the lead
  approve for people below owner who held nothing granted; the independent
  review asked for the stricter reading and it is now the only one.)
- **Approving** runs in one transaction under the owner lock: the membership
  ends (access is gone at once), the place in charge, Finance lead role, Add
  funds and Withdraw access and sign-offs end (`offboardMember`), and the
  person's passkey addresses are recorded in `wallet_offboarded_spenders`.
- **What follows an approval** (`runLeaveFollowUp`, `lib/server/team-leave-followup.ts`,
  after the transaction commits; the chain steps are `lib/server/team-leave-rules.ts`):
  1. **The rule is taken back through the spending-rules revoke path.** The route
     calls `revokeOrphanedRules` (the same call as Settings, Spending rules, take
     back the rules of former members): one transaction that revokes the person's
     allowances and removes them from the policy, **signed by the wallet's owners
     on their own devices**. The answer says which of three things happened: the
     request is open, there was nothing to take back, or it could not be opened (no
     wallet, the chain unreadable, no gas sponsor).
  2. **A person who leaves is still a signer until the signers are changed.**
     Leaving the team does not remove anyone from the business wallet's multisig;
     that is a separate request the owners sign (a change of signers). For an
     owner who leaves this is the step that matters most. The follow-up reads the
     wallet's recorded members and says in words whether the person is still a
     signer, or that Splash could not tell. It opens nothing for this: choosing
     the new signers and the threshold is the owners' decision. The approval
     dialog says it before the owner confirms.
  3. **Every outcome is one trail line**, `leave_follow_up` (migration 0075), with
     what became of the rule and the signer state, shown in Recent changes in
     plain words. A throw anywhere is recorded as "not opened" or "unknown", never
     lost, and a repeat writes no second line.
  A step that was skipped is not hidden: a rule that outlives its holder reads as
  orphaned on the wallet page and in Settings (state, not a message), so a
  follow-up lost between the commit and the call cannot sit unnoticed. Until the
  owners sign, the rule still exists on the chain, as it does after any removal.
  The live path was only simulated here (no real transaction is sent from this
  work); it still needs one run on testnet.
- **Declining** keeps the person on the team and says so in words on their own
  page: "<name> declined your request to leave. You are still on the team, with
  the same access as before. You can ask again."
- If the person is removed another way while a request is open, it is closed
  (`closed`) and cannot be approved later. A role change is not a removal; the
  request stands.
- A repeat of any step (ask, approve, decline, withdraw) changes nothing and
  writes no second line. Another business's request reads as absent.

## Add funds and Withdraw

Owners have both. A staff member or an approver has one or both only when an
owner switched it on for them, separately. A viewer never. The decision is read
from the database on every request (`fundsAccessOf`), for the session's own
person in the session's own business; a stale row for someone who is now a
viewer or has left grants nothing.

- **Add funds**: funding quotes, a top-up and reading a top-up's details,
  recording or rechecking a deposit, cancelling a top-up, and Transfer's
  step-3 top-up. The funding options and the deposit history are not Add funds:
  the Wallet page shows them to every member who can read the wallet.
- **Withdraw**: a quote, the request, reading the business's bank accounts, the
  payout route, and one withdrawal's bank details. Adding a bank account and
  setting up the payout route stay owner-only. A withdrawal is still **asked
  for**: only the owners' quorum signs.

A member without the access sees no Add funds or Withdraw button (the Wallet
page, its phone row, Transfer, Batch and Home) and a sentence saying an owner
can turn it on; the routes refuse them anyway. While the page does not yet know,
it offers nothing.

Preparing a payment (a quote, a supplier payout, a batch review) is a different
gate (`requireWithdrawalRequester`: owners, approvers and staff; a viewer
never) and is unchanged. A withdrawal is asked for by an owner or by a staff
member or approver with Withdraw, and signed only by the owners' quorum on
their own devices; an approver's approval is not part of a withdrawal, so an
approver who asked for one has no further say in it.

Funding **from outside** is unchanged: anyone can send USDC to the wallet
address from any wallet, and the deposit watcher still screens and holds it.

## The audit trail

A role change is a role change on the trail (`member_role_changed`, with the old
and new role) and, when the new role cannot carry them, the lines that end a
place in charge, the Finance lead role or access (reason `role_changed`). It is
**not** an offboarding: no `member_offboarded` line and no "removed" spender row,
because the person is still on the team. A removal writes both. A spending rule
a person holds lives on the chain, so moving them to viewer does not stop it: a
viewer who holds a passkey can still pay inside it until the owners' quorum
revokes the rule. Settings says so before the role is saved (`roleChangeNote`),
shows the rule under the person's name ("Belongs to a viewer") and the Finance
lead words say the lead cannot take a rule back. Making someone staff again
reads their rule as theirs again.

A change and its clean-up (the role or the membership, the Finance lead role,
grants, place in charge, sign-offs and the trail lines) commit in one
transaction, so a failure between them keeps neither.

Every grant, change and removal is a line in `wallet_authority_events`, which a
trigger keeps append-only: `member_added`, `member_role_changed` (with the old
and new role), `member_removed`, `finance_lead_appointed`,
`finance_lead_revoked`, `member_access_granted`, `member_access_revoked`, plus
the person-in-charge and offboarding lines that already existed, and (migration
0073) one line for every invitation and leave step: `team_invitation_sent`,
`team_invitation_accepted` (by the person; `member_added` follows under the
sender), `team_invitation_declined`, `team_invitation_withdrawn` (also when the
sender stopped managing the team), `team_invitation_expired` (actor
`system:invitation_expiry`), `leave_requested`, `leave_withdrawn`,
`leave_approved` (followed by `member_removed` with reason `left`, which the
page folds into the one sentence), `leave_declined` and (migration 0075)
`leave_follow_up` (what became of the rule, and whether the person is still a
signer). An invitation line keeps
a **masked** address (`f***@example.com`), because a trail line can never be
deleted; the full address lives only in `team_invitations`. A line names
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
rule, then Add a person (the two choices), Open invitations (with Withdraw) and
Requests to leave (Approve asks first and says what ends; Decline), and at the
bottom Leave this business. **Manage** opens one person: role (saved by its own button), Add funds and
Withdraw switches (owners only, saved as they are switched; they stay focusable
while saving, and giving Withdraw asks first), Make or take back
Finance lead (owners only), and Remove, which asks first and says what ends with
it. **Add a person** takes the choice, an email and a role. The Finance lead sees the same
list with only what they may do, and none of the owner-only controls. Someone
who manages nothing sees who they are and whether they can add funds and
withdraw, that their owners manage the team, and Leave this business (ask to
leave, where the request stands, or why they cannot ask).

The team is managed without a business wallet (it needs only the database), so
an owner can add people before the wallet exists. The person in charge, rules
and signers still need the wallet.

## Tests

`tests/team-roles.test.mjs` (the service on a real database: every action, every
refusal, cross-tenant, replay, concurrency, the trail),
`tests/team-routes.test.mjs` (every route's gate and wiring, and that nothing
else changes the team), `tests/team-view.test.mjs` (what is offered and the
words), `tests/team-finance-lead-wallet.test.mjs` (the chain side),
`tests/team-invitations.test.mjs` (send, replay, concurrency, the wait for an
account, one answer for every address, another business named nowhere, accept,
decline, withdraw, the 7 days, cross-tenant, no token, the trail),
`tests/team-leave.test.mjs` (ask, last owner, another owner, every hold cleared,
addresses recorded, the Finance lead's limits, decline in words, replay,
concurrency, cross-tenant), `tests/team-invite-leave-view.test.mjs` (the one
decision rule, the words, the copy rules), `tests/team-leave-followup.test.mjs`
(the follow-up: order, record, words), `tests/team-one-business.test.mjs` (one
business per person) and `tests/team-invite-polish.test.mjs`.

## One business per person (migration 0074)

A person belongs to one business at a time. The services check it, but a check
followed by an insert is not enough: two requests at the same moment cannot see
each other's uncommitted row under READ COMMITTED, so both used to pass. Now:

- `memberships(user_id)` is **unique** (`memberships_user_unique`), so the
  database refuses the second row whatever the code checked. The migration stops
  with a message if any person already holds two memberships; resolve those first
  (remove the extra membership), then run it again.
- `lockPerson` (`lib/server/team-admin.ts`) takes a `FOR NO KEY UPDATE` row lock on
  the person at the start of accepting an invitation and of adding directly, so
  two such requests for one person run in turn and the second reads the first's
  row.
- A refused insert is the plain answer (`already_on_a_business`, or `cannot_add`
  when adding directly) and nothing is kept. PGlite serialises transactions, so
  the race itself cannot be shown in tests; they pin the constraint, the order of
  the lock call, and the stale-read refusal. A two-connection test against a real
  Postgres still wants running once.

Adding a person directly also closes any open invitation to the same business
(`team_invitation_withdrawn`, reason `added_directly`). A person's own page stops
saying "declined" 14 days after a decline.

## What needs Sebastian (Move)

Nothing in this change touches `move/`. Invitations and leave requests are
Splash's database only, and taking a leaver's rule back uses the existing
spending-rules revoke (a quorum request) with no new Move function. If Sky wants the **Finance lead to be
known on chain** (for example a signer tier that can only add approvers, or a
threshold rule that counts the Finance lead differently from an owner), that is
a Move change and Sebastian approves every file under `move/`. Today the role is
Splash's, not the chain's.

## Release note: existing members lose Add funds and Withdraw until an owner grants them

Migration 0066 grants nothing. The moment it ships, every existing staff member
and approver is refused on Add funds, Withdraw and Transfer's top-up, and sees a
sentence that an owner can turn it on, until an owner opens Settings > Team and
switches it on for them. Owners are not affected. Decision for the product
owner: tell owners in the release notes, or run a one-off grant of both to
today's staff and approvers so nothing changes on day one. Neither is done.
