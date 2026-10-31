# v2 Phase 3 §4.2: the spending-rules screens

Spec: `SPLASH_SUI_V2_PROMPT.md` §4.2 and decision D2, and §5.9 (Settings).
This is the front end of the §4.2 backend (`docs/v2/phase2-spending-rules.md`)
on top of the Phase 1 Move API (`docs/v2/phase1-move-design.md` §5) and the
§4.1 signing flow (`docs/v2/phase2-business-wallet.md`). Nothing under `move/`
changed. The routes are the ones that already existed; no route was added.

## Who can do what

| | Owner | Finance lead | Approver, staff, viewer |
|---|---|---|---|
| Read the rules | every rule | every rule if they are an approver, else only their own | their own rule only |
| Give, change or take back a rule | yes | **no** | no |
| Change the spending policy (per-payment maximum, second-approval threshold, running-total window) | yes | no | no |
| Verify or stop allowing a recipient | yes | no | no |

The Finance lead (`docs/v2/phase3-team-roles.md`) is an approver with an
appointment, not a role, so it fails every owner check. The team table there
lists "spending rules" among what stays with owners, and every rule route
(`POST /api/wallet/spending-rules`, `PUT` and `DELETE` on
`/:staffUserId`, `policy`, `recipients`, `reissue`, `orphaned`) is
`requireOwner`. The screens do not offer the buttons to anyone else; the
server would refuse them anyway.

Sky's decisions apply as written. An owner's own change takes effect when the
owners' quorum has signed it: **no waiting period and no cooldown**. Splash's
own changes keep their 24-hour notice (Settings > Upgrade alerts), and those
are not rule changes.

## The screens

All of it is in Settings > Team & rules (`#rules`), on the page that already
holds Team, the spending policy, signers, funding sources and approvals.

**List.** One card per person with a rule: their name and a status pill
(Active, Used up, Starts later, Expired, Taken back, Belongs to a viewer,
Belongs to someone who left); the most one payment may be; the window that is
current now (what was spent, what is left, **when it renews, both as time left
and as the UTC instant**, with a thin bar that has no track behind it); when
the rule ends (as time left too); the lifetime total and what is left of it
(only when the owner set one); what has been paid under the rule's allowances
since it was given or last changed (`current_spend`, summed); and then, in plain words, **what they can pay alone** and
**what needs the owners** (below). Owners get Change and Take back. A staff
member or approver who is not an owner sees only their own rule.

**Give a rule** and **Change** are one sheet that asks one question per step.
On a phone the sheet is the whole screen, so it is one question per screen; on
a desktop it is a side sheet with the same steps. Each step is checked when
Next is pressed, in that step only, so nobody is walked through the rest to a
refusal. The last step reads the rule back in plain words before the owners
are asked to sign.

| Step | Question | Notes |
|---|---|---|
| 1 | Who is this rule for? | New rules only. Staff and approvers who have no rule. |
| 2 | What is the most one payment may be? | Cannot exceed the business's own limit; the screen says what that is. |
| 3 | How much can they pay in a day or a month? | Day or month, and an amount. The cap counts each payment plus the most its fee could be. |
| 4 | Do you want a total limit for the whole rule? | Optional lifetime cap. |
| 5 | Which recipients can they pay alone? | New rules only. Shows the business's verified list and offers saved recipients that the payment gate would pay, to verify in the same request. |
| 6 | When does the rule end? | The close of that day (UTC), within a year. |
| 7 | Check the rule | Plain-words summary, then **Ask the owners to sign**. |

A change skips steps 1 and 5 (it is for one person already, and recipients
belong to the business). It keeps what was spent: the review says so.

**Take back.** A sheet that says **what stops** (they can no longer pay alone;
their allowance is revoked and they leave the policy; their open payments stop
at once), **what stays** (payments already made stay on the record; later
payments go to the owners, and they can still ask the owners to pay for them,
because the chain pays only a spender: `create_intent` and `pay_intent` assert
`is_spender`, so a person taken back cannot pay or be the payer of an approved
payment; a new rule can be given later) and that the change
needs no waiting period. Its button says **Ask the owners to sign**, because
that is what it does.

**States**, always exactly one (`lib/team-rules/states.ts`, `rulesState`):

| State | What is shown |
|---|---|
| loading | "Reading the rules from the chain…", or "Reading your team…" for an owner while the people they can give a rule to are being read. Never an empty list. |
| error | The reason in a customer's words and **Try again**. A 503 (splash_spend not configured) says rules are not open for the business yet and never the environment variable it names; a 502 says the chain could not be reached; offline says so. |
| no policy | Owners: set the spending policy first (the card above). Others: staff payments go to the owners. |
| team could not be read | An owner whose team read failed: the reason and **Try again**. Never "No staff yet". With rules already listed, the same note sits above them. |
| no staff yet | An owner with nobody to give a rule to, **after a successful read** that found no staff or approver: "No staff yet", and an **Add a person** link to Team. |
| no rules | Owners: no one has a rule yet. Others: "You have no spending rule, so each payment you make goes to the owners." |
| list | The cards. Rules whose holders have left stay listed so they can be taken back. |

## A rule is read as a whole

`lib/team-rules/terms.ts`. On the chain a rule is one or more allowances.
After a change made while the person has already paid today, `carriedIssue`
(`lib/server/spend-rules.ts`) leaves two: a short **bridge** (cap and lifetime
cap are what is honestly left today, it ends when the window renews) and the
rule itself, which starts at that renewal. Reading the bridge as the rule says
the wrong cap, a lifetime total nobody set and an end date that is today (the
independent review reproduced exactly that). So every screen reads the
allowances together:

- A bridge is told by its shape: an allowance that is active now and ends
  exactly when a not-yet-started allowance of the same rule begins. Nothing is
  guessed from amounts.
- The cap, the period and the end date are the rule's own (its longest-running
  piece; the end date is the latest end). Today's room is the bridge's, said as
  "X USDC left today" with "The full cap applies again in ... (date UTC)"; no
  "used" figure is shown for a bridged window, because what was spent before
  the change is not on the new allowance.
- A lifetime total appears only when the owner set one (the continuation has a
  lifetime cap), as the sum over the pieces, and what is left is the sum of
  what is left. The Change sheet opens with the cap, that total and the real
  end date, so a second change does not sign a rule that ends today.
- "Paid under the rule" is the sum of `current_spend` over its allowances and
  is labelled "since the rule was given or last changed", because a new
  allowance starts at zero (item 3 below).
- A rule whose lifetime total is all spent is **Used up**, not Active, and
  says every payment goes to the owners until the rule is changed.
- The Wallet page's rules card (`lib/wallet-page/rules.ts`) uses the same
  reading.

Not told apart: a bridge with no later allowance (the rule ends inside the
window) looks like a rule with a lifetime total equal to its cap. It is shown
as such, which is true of the chain (that is all the person can pay), and a
change then asks for that total again.

## Whose words

The summary is read for a viewer. An owner is told "recipients you have
verified" and "Your own changes take effect at once". A staff member or
approver reading their own rule is told "the N verified recipients" and what
their own rule lets them do, with nothing about verifying or changing it
(`ruleSummary(..., { owner })`, `rulesIntro`).

## The plain-words summary

`lib/team-rules/summary.ts`. It words what the chain does and invents nothing:

- **Alone:** up to the smaller of the rule's and the business's per-payment
  maximum in one payment; up to the cap a day or a month **counting the most
  each payment's fee could be**; the N verified recipients (wallets, exchange
  accounts and bank accounts bound to a partner deposit address); the lifetime
  cap and what is left; and the last day.
- **Needs the owners:** a payment over the per-payment maximum; one that would
  take them past the cap; one to anyone not on the verified list; and one that
  would take what they have paid one recipient, over the running-total window,
  **above** the second-approval threshold, which needs one owner's approval
  before it is paid. The threshold and the window are the policy's (default
  10,000 USDC and 24 hours; owners edit both in the spending policy card).
  Move compares `paid_so_far > threshold || amount > threshold - paid_so_far`,
  so the words say "above", not "or more"; the Settings card and the Wallet
  page's rules card both used to say "or more" and now say "above".
- A rule that cannot pay (expired, starts later, taken back) says why and that
  every payment goes to the owners. A rule held by someone who left, or by a
  viewer, says it **still works on the chain** until it is taken back, because
  `create_intent` and `pay_intent` are public.

## How a change is signed

Giving, changing and taking back a rule are multisig-signed actions through
the §4.1 signing flow, which is the approval-request channel
(`lib/server/approval-requests.ts` is the `walletSigningNotifier`): the server
builds the transaction, decodes and simulates it, opens a signing request for
the wallet's signers, and notifies each owner **in Splash and by their
approval channel** (the in-app inbox, and WhatsApp when it is on). Each owner
checks the decoded bytes on their own device and signs with their own passkey;
the server combines the signatures and submits at the threshold. **The server
never signs.** Nothing in `components/settings/` signs, names a business, a
wallet or an address. After the owners are asked, the screen shows the signing
panel (`SignFlow`), and the rules reload when the request has executed.

One request per person is open at a time (`dedupeKey spend:rule:<spender>`). A
second ask for the same person while one waits is refused with `request_open`;
the screen says a request is already waiting and where to find it (Needs your
signature, at the top of Settings), and nothing is duplicated. A rule asked for
after it was given is `rule_exists` ("change it instead"); a take-back with
nothing to take back is `no_rule`.

## How live spend is read

Allowances emit no events, so `GET /api/wallet/spending-rules` indexes from the
`AllowanceCap`s the business wallet owns, the shared `Allowance` each points to
(`current_spend`, window, `spent`, `anchor_ms`), the business's `SpendPolicy`
and `splash_spend::RuleSpend` events. The window shown is the one the next
charge will see: a window that has passed is rolled over, with its whole cap.
Details: `docs/v2/phase2-spending-rules.md`, "The index".

## What the chain does not do, and how the screens say so

These were not worked around. Each is listed for Sky and Sebastian.

1. **A daily and a monthly cap together.** An allowance carries one rate limit
   (`periodic_rate_limit` or `monthly_rate_limit`), and `pay_intent` takes one
   allowance. The form therefore asks for a day **or** a month, plus an
   optional lifetime cap. Two allowances would not add up to both limits: the
   payer would pick one.
2. **Recipients per person.** `SpendPolicy.recipients` is one list for the
   business. A rule cannot be narrowed to a subset per spender, so step 5
   shows the business's list and says it is the same for everyone with a rule.
3. **A rule's lifetime spend across a change.** A new allowance starts with
   `current_spend` at zero. The §4.2 backend carries what was spent into the
   new rule's lifetime cap and the bridge allowance, so the limits hold, but
   what is paid under the rule restarts at the change. The screens say
   "Paid since the rule was given or last changed" and do not claim more.
4. **The cap and the fee.** An allowance counts each payment plus the most its
   fee could be (the ceiling, `principalWithFeeCeiling` in `lib/fees/schedule.ts`).
   The form therefore refuses a cap, or a lifetime total, below the most one
   payment may be plus that fee: such a rule could never pay its stated maximum.
5. **A new rule can widen the business's list.** Ticking a saved recipient in
   step 5 verifies it for the whole business. The review names each one under
   "Added for everyone with a rule" before the owners are asked to sign.
6. **A person without a passkey** cannot be given a rule (the rule is for that
   passkey's address). The owner's team list (`GET /api/wallet/persons-in-charge`,
   owner only) carries `hasPasskey`, and step 1 marks those people and does not
   offer them.

## Tests

- `tests/spending-rules-screens.test.mjs`: the words (summary, time left,
  take-back), the steps and their per-step checks, the recipients that go with
  a new rule, the states, the failure texts, and the screen sources (the sheet,
  the states, no signing or business in the form, house copy rules).
- `tests/spending-rules-flow.test.mjs`: on the model chain and the real
  database, the replay and idempotency the screens rely on (a second identical
  ask is refused, a replayed signature moves nothing, a rule asked for twice is
  one rule, a second take-back finds nothing), cross-tenant (another business's
  person and a nobody get the same answer; a viewer cannot be given a rule) and
  fail-closed (without splash_spend's ids nothing is read or built).
- `tests/spending-rules-review.test.mjs`: the independent review's findings.
  It builds the chain's own bridge (give, spend, change, sign, read back) and
  checks the list, the summary, the Change sheet and the Wallet card read the
  whole rule; the team read's loading and error states; staff and owner
  wording; the take-back words; the cap-and-fee boundary; the recipients added
  for everyone; Used up; the passkey mark; the policy card's "above".
- `tests/spend-rules.test.mjs`, `tests/settings-team-rules.test.mjs` and
  `tests/wallet-page-rules.test.mjs`: the chain, the routes, the form request
  and the Settings page, as before.

Screenshots (1440×900 and 390×844) of every state were taken with
puppeteer-core against a dev server started in the worktree with no
`.env.local`, `USE_MOCK_APIS=true`, signed in with the repo's own seeded
`demo@acme.test`. The wallet and rules routes were answered in the browser with
fixtures, because there is no chain in that setup; nothing reached a network.
