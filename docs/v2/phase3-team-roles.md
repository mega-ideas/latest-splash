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

### The email (Sky's decision of 1 Nov: invitees also get an email, through Resend)

`lib/server/invitation-email.ts`, words and markup in `lib/team/invitation-email.ts`,
migration 0082. Reused, not rebuilt: the Resend transport in
`lib/auth/email-transport.ts` (plain `fetch`, the key read from `EMAIL_API_KEY`
and never printed), now taking an optional page of its own and an
`Idempotency-Key`.

- **What it says.** Subject "Aisha invited you to join Acme on Splash". Plain
  text and a simple 600px page: who invited them (the sender's name), the
  business, what it is, that it is open for 7 days and the date it ends (UTC),
  and one button, "Open the invitation". Sentence case, no emoji, no images (so
  no tracking pixel), no marketing, no amount, no other business, no other
  person. Every inserted value is cleaned to plain words (control characters and
  line breaks become spaces, long names are cut) and escaped.
- **What the link is.** The app address plus `/dashboard/invitation/<id>`: an
  id, no token, no query. Opening it asks the person to sign in (the dashboard
  sends a signed-out visit to sign in and back to that page only) and shows the
  invitation **only to the account whose verified email it was sent to**. Anyone
  else, link in hand or not, reads "not found", exactly as for an id that does
  not exist. Nothing is accepted by opening the page: Accept is a button. So a
  forwarded email grants nothing. In production the link is made only on https
  and a public name; otherwise nothing is sent and the owner is told email is
  not set up.
- **Once.** The invitation is made first and stands whatever happens next. The
  send is *claimed* with one UPDATE of `email_state` to `sending`; only the call
  that wins sends, and the outcome is recorded on the invitation (`sent` with the
  time and the provider's message id, `failed`, or `not_configured`). A retry of
  the invitation, a repeat of the delivery, a double click and two owners at
  once send once. The provider also gets the key `splash-invitation-<id>-<n>`,
  so a send whose outcome was lost, claimed again after 5 minutes, is recognised
  and dropped by the provider.
- **A failed send loses nothing.** The invitation still shows after sign-in.
  Settings, Team, Open invitations shows, in an alert, "We could not send the
  email. The invitation is still waiting for them. Try sending the email again."
  with a **Send the email again** button.
- **The button.** Owner-only (the Finance lead sees the state and "An owner can
  send the email."), one send per click, none for an email that already went,
  none once the invitation has ended or been withdrawn (the link then says so in
  plain words: "This invitation ended after 7 days..." or "The person who sent
  this invitation took it back..."). Another business's invitation reads as
  absent. A never-tried invitation from before the migration shows "No email has
  been sent for this invitation yet" with the same button.
- **No sender set up.** The invitation works in the app only, and the owner is
  told in an alert, never silently: "No email was sent. Email is not set up for
  Splash, so this invitation is waiting in the app only." A console sender (the
  development default) is not counted as sent. Once email is set up the owner
  can send it with the same button.
- **Logs.** An id and the kind of failure ("resend returned HTTP 422...", or the
  error's name). Never the key, the address or the link.

There is no per-sender invitation limit for now; it is to be revisited before launch.
(The one cap that already existed, 25 open invitations per business, is unchanged
and is not a per-sender limit; no rate limit or daily cap was added for the email.)

Tests: `tests/invitation-email.test.mjs`.

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

## Can pay exchange accounts alone

Sky's decision (2 Nov): staff may pay an **exchange account** alone, but only
when an owner allows it for that person, and the owner can change it at any
time.

| What | Where |
|---|---|
| The switch (stored per member) | `wallet_member_access`, kind `pay_exchange_alone` (migration 0077); `exchangeAloneOf` in `lib/server/exchange-alone.ts`; granted and taken back by `setMemberAccess` |
| The words | `EXCHANGE_ALONE_LABEL`, `EXCHANGE_ALONE_WORDS` in `lib/team/view.ts` |
| Settings → Team → Manage | the switch in `components/team/MemberDialog.tsx`; `PUT /api/team/members/:id/access { access: 'pay_exchange_alone', allowed }` |
| Honoured before anything is built | `createTransfer` (`lib/server/wallet-transfers.ts`) and the plan (`exchangeAlone` in `lib/transfer/plan.ts`) |
| Honoured again before every signature | `staffExchangeHold` in `lib/server/payment-compliance-gate.ts` |
| The Travel Rule message | `lib/compliance/exchange-disclosure.ts` (pure), `lib/server/exchange-disclosure.ts`, `POST /api/wallet/transfers/exchange-disclosure`, `components/transfer/ExchangeDisclosure.tsx` |

**The switch.** Off for everyone. Migration 0077 only widens the allowed kinds
and adds a table: nothing is granted to anyone already on the team (a test
reads every migration for an insert into `wallet_member_access`). Only an owner
turns it on or off; the Finance lead, the person themselves, an approver and
another business's owner are refused (`owner_only` or `not_allowed`, or 404 for
a person of another business). **It is instant**: an owner's own change, so no
notice, no cooldown and no second signature; taking it back in the same second
it was given works. It is for staff and approvers: a viewer cannot hold it
(`cannot_hold_access`), and an owner has no use for it (`not_needed`: the
owners' payments are signed by the owners together). Every change is a
`member_access_granted` or `member_access_revoked` line on the append-only
trail, in words: "Asha let Ben pay exchange accounts alone." Moving the person
to viewer, or removing them, ends it and says so (the same path as Add funds
and Withdraw). A person who holds it is one an owner granted something to, so
only an owner changes their role or removes them.

**What it widens, and nothing else.** It only lets an exchange account be judged
by the person's spending rule like any other recipient. The rule's per-payment
maximum, cap, start and end dates and second-approval line (counted across
every person and every payment on its way) all still bind, and the recipient
must be on the rule as an **exchange** account: one the owners tagged an
exchange after the exchange confirmed it. A wallet is never paid as an
exchange account and an exchange account is never paid as a wallet. A bank
payout and USDC to another chain stay the owners', whatever the switch says.
With the switch off, or with a rule that does not hold the account as an
exchange, the payment goes to the owners with the reason in plain words
(`exchange_needs_owners`, `exchange_not_verified_as_exchange`); a person who
insisted on paying alone is refused with 409 `outside_rule` and nothing is
stored. The owners' own payments to an exchange are unchanged.

**It is read on the server, every time.** `createTransfer` asks
`exchangeAloneOf` (default deny: a viewer, an owner, a stranger, another
business's member and a stale row all read as no) before it builds anything.
The signing gate asks again before **each** signature, so an owner who turns it
off stops a payment the person already opened: the signature is refused with
`exchange_alone_off`, nothing moves, and turning it on again lets the same
payment through. The page never decides: it reads `payExchangeAlone` from
`GET /api/wallet/transfers/context` only to plan the same way.

### The Travel Rule message

Before the staff member signs, Transfer shows what will be shared with the
exchange and asks them to confirm it.

1. **Show.** `POST /api/wallet/transfers/exchange-disclosure` (the payment's
   Idempotency-Key is the intent id) builds the message **on the server**:
   who is sending (the signed-in person's name), the business (the name and
   registration number the provider verified, not the editable profile, and its
   wallet), the beneficiary and its country, the exchange and the account at it
   (the saved recipient's own), the amount, and the purpose the person picks
   from a short fixed list. It returns the words, the structured rows and the
   sha256 of the exact text. It stores nothing and shares nothing. Anything the
   message needs that is missing (the business's registered country, its KYB
   approval or case with the provider, the recipient's name, country or
   exchange, the person's own name, a purpose from the list) is refused with a
   plain reason and nothing is built. An exchange is named only when its
   agreement is signed (`SIGNED_PARTNERS`); otherwise it is described as
   Recipients describes it ("Exchange you saved this account at: our Philippines
   payout partner"), which is one for one with the exchange the provider is told
   by id. The last row, "Payment details as sent", is the exact string the
   provider receives: "Sent by NAME: purpose", the name cut at 40 characters.
   Sharing the staff member's name there needs Sky's confirmation.
2. **Confirm.** The person reads it, ticks "I have read this and it is right",
   and pays. The payment carries `{ purpose, confirmedHash }`. The server builds
   its own message again and compares: a different hash (an amount, an address,
   a detail of the business changed since) is 409 `exchange_disclosure_changed`
   with the new message to read; none is 409 `exchange_disclosure_required`. The
   fee shown is passed as `max_fee` exactly as for every payment, and an
   exchange payment takes the EXCHANGE fee kind (kind 2) computed on chain.
3. **Store.** The exact payload and the exact text it was hashed from are
   written to `wallet_transfer_disclosures` **in the same step as the payment's
   claim**, bound to the intent id (`intent_id`, `payment_ref`), the transfer
   and, once it exists, the signing request. A trigger refuses any rewrite. The
   hash is also inside the transaction's `commitment`, so what is on chain
   covers it.
4. **Send.** Once the signing request is open the Travel Rule message is sent
   to the provider, **made from the stored payload and nothing else**
   (`travelRuleInputFromDisclosure`): the business as originator, the beneficiary
   at its exchange, the amount, and a purpose that begins with who sent it.
   Replays and races make one message (`sendTravelRule` is once per payment).
   If the provider cannot be reached the payment is still open but cannot be
   signed (the gate needs the message with the provider), the page says so, and
   "Send the message again" (`POST /api/wallet/transfers/:request/exchange-message`)
   sends it again from the stored payload, once. The state is read from the
   provider's own row each time the payment is shown (`GET` on the same route,
   `ExchangeMessage` in the signing panel), so it survives a reload and a
   replayed send; a replay that confirms another purpose says which purpose the
   exchange was already told.
5. **Check at the signature.** Before each signature the gate reads the stored
   message back and compares it with the decoded bytes: it must still hash to
   its hash, be the payload it carries, and be for this payment; the
   transaction must pay the account and the amount it names, carry the payment
   reference it is bound to, and carry the commitment the gate derives again
   from the business, the transfer, the account, the amount, the fee bound, the
   kind (2) and the stored hash (`transferCommitmentHex`). The describer shows
   the reference and the commitment of a payment opened under a rule
   (`open_intent.paymentRef`, `open_intent.commitment`; TypeScript only, no
   Move change). A record that is gone is `disclosure_missing`, one that does
   not match is `disclosure_mismatch`; neither is signed.
6. **The switch is asked last, too.** After the signing request is opened and
   immediately before the message goes, the switch is read again. If an owner
   turned it off meanwhile, the message is not sent, the request is withdrawn,
   and the payment is the owners' (or, for a person who insisted on paying
   alone, refused in words with nothing kept). The claim itself reads the switch
   inside the business's lock, on its own connection, so a stale first read never
   decides the route. At the signature the switch is the first question, so the
   reason a person reads is the owner's switch, whatever else is also missing.

**Fails closed.** In production without Sumsub's Travel Rule configured the
preview and the payment are refused (503 `travel_rule_not_configured`) and
nothing is built, stored or shown as sent; a sandbox message on file is refused
at the signature in production (`travel_rule_missing`). No verdict, reference
or message is made up. The recipient must still be a fresh screening CLEAR,
the same screening gate as every payment. Where the provider or the business's
verification is missing the page hands the person to asking the owners, who
send their own message.

**Replay and tenants.** The intent id answers only the person who made the
payment (another member gets 409 `idempotency_key_reused` and sees nothing); a
second send with another purpose still answers the payment already made and
changes what was shared by nothing. Another business reads none of it: the
stored message, the switch and the recipient are absent (404/409), and a
person cannot send another person's message again.

**What this is not.** Nothing here claims the exchange will accept the
payment. The first payment to an account still waits for the exchange's
confirmation, and a message the exchange puts on hold or rejects holds or
refuses the signature as before.

### Tests

`tests/exchange-alone-switch.test.mjs` (the switch: default, owner-only,
instant, trail, tenants, role changes), `tests/exchange-alone-payment.test.mjs`
(switch off, on, on then off mid-flow, the rule still binds, the message, the
payload bound to the intent id, replay and races, the gate, fail-closed,
cross-tenant, second-approval and alerts), `tests/exchange-alone-ui.test.mjs`
(the words, the wiring and the migration) and
`tests/exchange-alone-review-fixes.test.mjs` (the switch flipping between the
first read, the claim and the send; the payment reference and the commitment
checked against the bytes; the message state after a replay or reload; the
purpose a replay already shared; a Splash business on a rule; the reason at the
signature; the words on screen).

### What needs Sebastian (Move)

Nothing. `splash_spend::create_intent` already takes kind 2 for a recipient the
owners tagged an exchange and refuses any other kind
(`E_WRONG_DELIVERY_KIND`); `pay_intent` derives the kind and the fee on chain.
No file under `move/` changed.

## Release note: existing staff and approvers start without Add funds and Withdraw

Sky decided (1 Nov): **day one for existing staff and approvers is that they do
not have Add funds or Withdraw until an owner turns it on. No backfill.**

Migration 0066 grants nothing, and nothing grants anything for anyone. The
moment it ships, every existing staff member and approver is refused on Add
funds, Withdraw and Transfer's top-up, and sees a sentence that an owner can
turn it on, until an owner opens Settings > Team, chooses Manage on that person
and switches it on. Owners are not affected, and a viewer never has either.

- **Tell owners in the release notes**: staff and approvers who were already on
  the team lose Add funds and Withdraw until an owner switches them on, one
  person at a time.
- **The product says it too**: Settings > Team shows owners one plain sentence
  (`EXISTING_MEMBERS_FUNDS_NOTE`, `lib/team/view.ts`): "Staff and approvers who
  were already on the team do not have Add funds or Withdraw until an owner
  turns them on, one person at a time, under Manage." The Finance lead and
  members who manage nothing do not see it: they cannot grant the access, and
  the member already has the sentence about asking an owner.
- **No one-off grant.** No migration, route or seed inserts into
  `wallet_member_access` for existing members (`tests/team-view.test.mjs` fails
  if a migration backfills it).
- Nothing here touches `move/`.

## Declined by: name, title, and who sees it

Sky's decisions (2 Nov), on the status words of a payment or batch the owners
declined:

1. **The signing panel names everyone who declined**, all names, not a count:
   "Declined by Aisha (CFO) and Ben (Finance lead)". The names go only to
   members of the same business. History keeps its cap (two names, then "and N
   more"); the panel and History read the same facts and only the panel says
   all of them.
2. **A person who has since left still shows.** The name and the title are
   written on the signing request's own decline record, in the same statement
   that records the decline, and read from there, never from the live team
   list. Leaving the business, a rename, a role change or removing the account
   does not change or blank an old label.
3. **The label always carries the title in brackets**: "Aisha (CFO)".

| What | Where |
|---|---|
| The words, and cleaning a name and a title | `lib/team/declined-by.ts` (`declinerLabel`, `declinedByLabel` for History, `declinedByAllLabel` for the panel) |
| The title | `lib/team/member-title.ts` |
| The snapshot, and reading it | `recordDecline`, `declineSnapshot`, `declinersOfRequests`, `askDeclinerOf` in `lib/server/wallet-signing-store.ts`; `declineApprovalAsk` in `lib/server/payment-approval-asks.ts` |
| What the panel receives | `declinedBy` on the request view (`RequestView` in `lib/server/wallet-signing.ts`, `SigningView` in `components/transfer/api.ts`) |
| Where it is said | `components/transfer/SignPanel.tsx`, `components/approve/ApproveScreen.tsx` (the phone), `components/approve/ApproveInbox.tsx`; History through `lib/history-page/entries.ts` |
| Migration | `drizzle/0081_decliner_snapshot.sql` |
| Tests | `tests/declined-by-titles.test.mjs` (the words), `tests/declined-by-history.test.mjs` (a real database: the panel, History, the snapshot, leavers, renames, old rows, other businesses) |

**What a member's title is.** A membership is a user, a business and a role; a
member has no title or job field of their own in this code. The title is
therefore the member's own title when one is set (`memberTitle` reads it first,
so adding the field later changes nothing else), else the role's word: Owner
(`admin`), Staff (`maker`), Approver (`checker`), Viewer (`viewer`), and
**Finance lead** for the approver the owners appointed to it
(`wallet_finance_leads`, open and still an approver). A person with no
membership reads "Member".

**Cleaning.** The name and the title are each cleaned on their own as plain
words, and only then put in the shape "Name (Title)", so a hostile name or title
cannot add a bracket, a comma, a link or a second person.

- Brackets (every kind) and commas (every keyboard) inside one field are
  **turned into a space**: the name "Aisha (CFO)" is "Aisha CFO", "Tan, Aisha" and
  "Tan,Aisha" are "Tan Aisha", so two words are never fused into a made-up one. The
  earlier rule that turned "Aisha (CFO)" into "Aisha" and "Tan,
  Aisha" into "an owner" is replaced.
- A field stops at its first word that is not a plain word (a link, markup, a
  number, a symbol, an emoji), and is at most 30 characters, cut once at a word
  with the one ellipsis character. Control, hidden and direction characters are
  removed and spaces are collapsed.
- A name that is empty after cleaning is said by the title alone ("Finance
  lead"); a title that is empty is left out. A person with neither is "an owner"
  in the signing panel, which names everyone ("Declined by Aisha (Owner) and an
  owner"), and one of the "N more" in History, which names two; when nobody is
  named the sentence is "Declined by an owner".
- The same cleaning runs where the snapshot is written, where it is read and
  where it is said (the page cleans it again), and a second pass changes nothing.

**The snapshot.** Migration 0081 adds `declined_name` and `declined_title` to
`wallet_signing_signers`, and `decided_name` and `decided_title` to
`wallet_approval_asks` (the staff member's ask an owner declines). Only the name
and the title, both already plain words; nothing else about the person (no
email, no id beyond the row's own). Empty text means a snapshot was taken and
nothing usable was left; null means the decline predates 0081.

- **Old declines** (null) read the person's live name and title while they are
  still a member of that business; if they are not, they are "an owner" in the panel and counted in History.
  Nothing is rewritten.
- **The account itself.** `wallet_signing_signers.user_id` used to delete the
  signer row with the account, which would have removed the decline and its
  snapshot. 0081 drops that one foreign key (by name, `IF EXISTS`), as the
  approval asks (0037) and the audit trail already outlive their people. Nothing
  else is dropped.
- **Who sees it.** Every read takes the business id from the session (WS2) and
  goes through that business's own signers, so another business's request, or its
  people, read as absent: by the request's id the answer is 404, in the inbox it
  is empty, from the store it has no entry. The panel is reached only by that
  request's signers and the person who asked.
- **Repeat.** A second decline by the same person writes nothing, snapshot
  included.

**Not changed.** No Move code. Adding a title field to a member (and a place in
Settings > Team to set it) is a product decision for Sky; nothing here needs it.
