# For Sebastian — what changed, and what needs your confirmation

Branch: `feat/phase5-passkey-authority`, off `main`.
Written 2026-09-05. Companion to `docs/PHASE-STATUS.md` (phase-by-phase) and
`STATUS.md` (mainnet cutover).

Protocol reminder, unchanged: **Move changes are confirmed by you. No
self-approval.** Nothing in this branch touches Move. Phase 6 does, and it has
not started — that is the point of this note.

---

## The one-paragraph version

Phases 0 through 5 are done and pushed: reproducible environment, corrected
claims, exact money arithmetic, real user accounts that fail closed, zkLogin
sign-in, and passkey approval authority. Since the last note, the staff console
gained the screen that grants memberships — Phase 3 removed every implicit
grant, which was right, and left no way to give a real account access short of
a SQL client. Sui 1.77.2 is now installed, all 52 Move tests are green (14 + 22 + 16), and
the lockfiles are regenerated against that toolchain and committed. **Phase 6
(Move authority) is blocked on you alone.**

---

## New since the last handover: the membership admin screen

`/admin/memberships`, in the staff console.

Why it exists: Phase 3 split `users` (identity) from `memberships`
(authority), removed the default role from the schema, and made
`resolveAuthorityForSession` throw rather than provision. The intended outcome
is that signing up grants nothing. The unintended outcome was that
`grantMembership()` had no caller, so the first real operator would have needed
`psql`. A control nobody can operate gets worked around, and the workaround
would have been worse than the control.

What it does, and the decisions inside it worth arguing with:

- **It calls the same `grantMembership()` the fail-closed tests assert
  against.** There is still exactly one function in the codebase that can
  create a membership. A test asserts `lib/server/memberships.ts` contains no
  `.insert(` of its own, so a second grant path fails the build.
- **It cannot create an account.** Granting to an address with no account is
  refused with "They must sign up before they can be granted access." An
  operator typing an email into a grant form and having a user materialise is
  how a typo becomes a real account with real authority.
- **The role select has no default and no preselection.** A grant form that
  opens on a value is a grant waiting to be made by someone who did not read
  the list. The API schema likewise has no `.default()`, so a request that
  omits the role is a 400.
- **It states what the role permits before the button is pressed.** `checker`
  is the most dangerous option in the enum and the least alarming word in it —
  it maps to `APPROVER`, which is in `APPROVAL_ROLES`, which releases money.
  The screen says "This role can move money" in an amber panel when `checker`
  or `admin` is selected.
- **It lists accounts with no membership first and separately.** A left join,
  not an inner one — the accounts an operator is here to act on are exactly the
  ones an inner join would hide.
- **Revoking is a hard delete**, unlike the passkey tombstone. A membership is
  current authority, not evidence: an approval that already happened is
  anchored with the approver's address and does not depend on this row. A
  tombstone here would leave a revoked member in the org's member list.
- **Every grant records who made it** (`grantedBy`, from the staff session).
  An authority change with no author is not auditable.
- Staff-only, not customer-facing. A customer promoting their own colleague
  needs an invitation flow and an audit trail the customer can read; neither
  exists, and inventing one here would be scope creep.

Files: `lib/membership-roles.ts` (pure, client-safe), `lib/server/memberships.ts`,
`app/api/admin/memberships/route.ts`, `components/admin/AdminMemberships.tsx`,
`app/admin/(console)/memberships/page.tsx`, `tests/membership-admin.test.mjs`
(15 tests), plus `scripts/dev-db.mjs`.

Verified end to end against a real Postgres wire connection, not just unit
tests: granted a `checker`, saw the approver count go 2 → 3 and the awaiting
list 2 → 1; revoked it and saw both move back. A duplicate grant returns 409, a
grant with no role returns 400, and GET/POST/DELETE all return 401 without a
staff session.

---

## `sui move build` and `sui move test` — run on 1.77.2

Sui 1.77.2 (`51d177ad7d65`, the `testnet-v1.77.2` Windows build) is now
installed at `%LOCALAPPDATA%\bin\sui.exe`. The 1.75.1 binary that was there is
kept at `D:\sui-install\sui-1.75.1-backup.exe`.

All three suites are green, and they match STATUS.md's gate exactly:

| Package | `build` | `test` |
|---|---|---|
| `splash_core` | clean | **14 / 14** |
| `splash_meter` | clean | **22 / 22** |
| `splash_custody` | clean | **16 / 16** |

52 tests, no failures. The gate is reproducible again.

Worth recording what the failure was, because it is a trap that will recur.
On 1.75.1 the same `splash_custody` suite failed **0/16**, every test
identically and before any assertion:

```
VMError { major_status: MISSING_DEPENDENCY,
          location: Module(0x2::object), indices: [(FunctionHandle, 2)] }
```

That is the test VM's framework failing to link a function the compiled
bytecode expects — whole-package, which is why it was 0/16 and not "some
pass". `splash_custody` is the only package with git dependencies (DeepBook
`daa5a951`, OpenZeppelin math); `splash_core` and `splash_meter` have none and
were green on both CLIs. So a CLI downgrade takes out only the package whose
dependencies were pinned against a newer toolchain, and it does so with an
error that looks like a code fault. It is not one.

With the build output now present, `npm run check:core` also cross-checks the
no-`Balance<T>` invariant against **compiled bytecode**, not just source — 6
modules, holds. Previously it printed "no build output to cross-check".

### The lockfiles are regenerated on 1.77.2 and committed

They were stale: the committed lock had been written by compiler **1.59.1** and
pinned Sui framework `494fa6ed`, so the pin on record was not the framework
anything has been tested against for a long time. All three are now regenerated
on 1.77.2 — lock format 4, Sui `06734f6f`, DeepBook `daa5a951`, OpenZeppelin
math `a9703fe8` — and the 52 tests were re-run from exactly the files that are
committed: 14 + 22 + 16, no failures.

Two things worth your eye.

**DeepBook's `token` package is now pinned** at `c43c84a4`. It is a transitive
dependency `Move.toml` never named, so nothing had it on record before. It is
on record now, which is strictly better, but it is a pin nobody chose — worth
a look before publish.

**The separators are forward slashes, deliberately, and Windows will fight you
over it.** The generator writes the *platform* separator, so on Windows it
emits `subdir = 'crates\sui-framework\packages\move-stdlib'` and
`local = '..\splash_core'`. Those do not resolve on Linux, so committing the
raw Windows output would have shipped a lock that breaks any Linux build or CI
runner. I converted every separator to forward slashes and verified the result
both builds and passes all 52 tests on Windows, so the portable form is correct
on both platforms.

The cost: on Windows, every `sui move build` and `sui move test` rewrites them
back and leaves the three files dirty. `git checkout -- move/*/Move.lock`
after a local Move build. A Linux build leaves them alone. If that churn
annoys you more than the portability is worth, the alternative is to regenerate
on WSL and commit that — same content, no local churn.

---

## Phase 6 is built. It needs your review, not your permission to have started.

Phase 6 is Move, and the protocol is that Move changes are confirmed by you.
That is a review gate on merging and publishing, so the code is written, tested
and pushed on this branch — and **not merged, not published**. Nothing has been
self-approved. If you want any of it differently, it is four commits and they
are separable.

`3940b7a` **Authority the chain enforces.** `BusinessAccount` is now a SHARED
object holding `owners`, `approvers`, two independent freeze flags, a
`recovery_party` and an `authority_epoch`. Four eyes is asserted on chain — an
approver cannot release a payment they initiated. Revocation kills work in
flight, including the revoke-then-regrant case a "is this address currently an
approver?" check gets wrong. An account-bound intent has no unapproved
settlement path: `confirm_payment_intent` aborts on one, which is what makes
the rest a control rather than advice. `mint_attestation_cap` is deleted;
`AnchorCap` is minted at publish and rotated one-in-one-out, so the cold key can
MOVE anchor authority and can never manufacture a second holder. Each account
gets a 24h ceiling, default USD 1,000 in six-decimal minor units, as 24 hourly
buckets so the tumbling-window double-spend does not work.

`93d339a` **A bug in `spend_meter::remaining_at`**, found by checking my new
window's arithmetic against the existing one rather than copying it. The
virtual roll counted buckets forwards from the head, which wraps onto the ones
the roll is about to zero and skips the same number of live ones. A view, not
the enforcing path — `charge` always summed all 24 — so the ceiling itself
always held and the harm was the batcher over-estimating free capacity. Fixed
with a regression test that fails against the old code.

`702919f` **`AdminCap` governs, `TreasuryCap` spends.** One capability used to
gate KYB, the compliance config, guardian minting, every pause, every limit,
every allowlist AND every withdrawal, so "who can move money?" had thirty-odd
answers. Five functions now take `TreasuryCap`; nothing else can take value out
of a custodial object. `scripts/check-treasury-cap.mjs` fails the build if an
`AdminCap` function learns to split a balance, and I verified it fails rather
than assuming it would. **This changes the key ceremony** —
`docs/KEY-CEREMONY-RUNBOOK.md` §0 is rewritten: the cold 2-of-3 holds
`TreasuryCap`, not `AdminCap`.

`adaa92a` **`ComplianceCap` is subtractive by type.** It could previously set
five risk parameters freely, resume as easily as halt, and add a DeepBook venue
— which is S-12's exact attack. It now only tightens, only pauses, and only
removes venues; every loosening is `AdminCap`.
`scripts/check-compliance-subtractive.mjs` enforces it on the SIGNATURE, and I
checked it fails on all three shapes it is meant to catch.

`1b5d67b` **The adversarial pass**, which found three things. The largest: an
approver was signing an intent id and an amount supplied BESIDE it, because
`business_account` cannot import `payment_intent`. The entry point moved to
`payment_intent::approve_payout`, which sees both objects, so the amount and
the maker are derived from the intent and the mismatch is unrepresentable
rather than merely checked.

**Two limitations are written into the code rather than left to be found.**
Four eyes is a check on addresses — one person with two approver keys satisfies
it and no on-chain rule can see that. And the 24h ceiling bounds what can be
RELEASED under a tenant's approval; since `splash_core` holds no `Balance<T>` by
design, it cannot bound what a private key sends from its own address.

**What I would most like you to push back on**, in order:

1. **The velocity cap's unit.** `DEFAULT_DAILY_CAP_MINOR = 1_000_000_000` reads
   as USD 1,000 only if the settled coin has six decimals. On a 9-decimal SUI
   pool it is USD 1. The brief said "USD 1,000" and I made it a scaled integer
   with the assumption stated at the constant, but the right answer may be to
   denominate the cap per settlement asset. This is the same class as A-14.
2. **`AnchorCap` recovery.** Removing arbitrary minting was right and it
   created a permanent brick if the cap is lost. Phase 7's job — and until it
   lands, `splash_core` must not publish immutable.
3. **The 72-hour recovery notice and `MAX_MEMBERS = 16`.** Both are numbers I
   chose. An account with 16 owners cannot be recovered at all, which is stated
   but may still be wrong.
4. **Whether an approver should be allowed to open an intent.** Today owners
   and approvers can both be makers, and four eyes is preserved because the
   approval must come from a different address. A stricter reading would say
   makers and approvers are disjoint sets.

Phase 7 is not started.

---

## Phase 7 is built too, and it closes the hole Phase 6 opened

`99dac52`. When Phase 6 deleted `mint_attestation_cap` I flagged the cost in
this note: a LOST `AnchorCap` bricked anchoring permanently, and `splash_core`
must not publish immutable until break-glass landed. It has landed.

Every revocable capability now carries a GENERATION, and a shared
`CapRegistry` holds the live one. A capability whose generation is not the
registry's is dead — the object stays intact, well-formed and worthless.
`AdminCap` can bump a generation, which mints one replacement and kills every
outstanding cap of that kind in the same transaction. So it does not restore
arbitrary minting: the bump that creates the new cap is the bump that kills the
old, and there is never a second live one.

It answers both holes with one lever, and the second one matters more than the
first. Phase 6's containment for a STOLEN anchor cap was, in its own words,
"off-chain rejection of anchors bearing the retired cap id" — a hope about what
every future consumer would remember to check. Now the thief's cap simply stops
working, without their cooperation, consent or knowledge. That is the test I
would read first: `a_stolen_cap_is_dead_without_its_holders_cooperation`.

**There is no timelock, and that is the decision I most want you to check.**
Every other emergency lever here is delayed — 48h for a meter relaxation, 72h
for an account recovery. I argue a third delay would be theatre: a delay
protects against the lever's holder abusing it, and `AdminCap` gains nothing by
rotating these two (an `AnchorCap` moves no value, and `AdminCap` already holds
strictly larger versions of everything `ComplianceCap` does). Meanwhile the
delay would cost the thing the module exists for, because a thief given a
cancellation window would use it. The property that actually needs protecting —
no duplicate live capability — is enforced by the generation, not by waiting.
If you disagree, the change is small and localised to `cap_registry`.

`AdminCap` and `TreasuryCap` deliberately have no generation. They are `store`
capabilities on multisig addresses rather than servers, and `AdminCap` is the
key that arms every break-glass here, so it cannot be the subject of one
without something above it holding the lever. Their recovery stays a human
procedure in the key-ceremony runbook.

`scripts/check-cap-generations.mjs` fails the build if any function takes
`&AnchorCap` or `&ComplianceCap` without also taking `&CapRegistry` and calling
the matching assert. One forgetful consumer is a hole a stolen cap keeps
signing through, and it is the kind found by an incident rather than a review —
the function works perfectly until the day somebody revokes something. I
verified it fails when the assert is removed from `anchor_audit_hash`.

**One new deployment requirement**: `SPLASH_CAP_REGISTRY_ID`. Every call that
uses a revocable capability passes it, so the peg refresh, anchor writes,
receipt minting and every compliance operation refuse to build without it. That
refusal is deliberate — an "optional registry" would mean a code path where a
revoked capability still works, and it would be the path running in production
the day you need the revocation.

── State of the tree ──

Phases 0 through 7 are complete. 107 Move tests (68 / 23 / 16), 304 Node tests
across eleven suites, five Move-invariant CI guards, `tsc` clean, production build clean, and
`npm run lint` now prints nothing but its guards passing — the three warnings
that were carried as "pre-existing, left alone deliberately" are gone, because
a clean-except-three build is one people stop reading.

Still not merged. Still not published.

---

## What I need from you, in order

1. **Sanity-check the regenerated lock**, in particular DeepBook's `token` at
   `c43c84a4` — a transitive pin that was previously unrecorded and that
   nobody has chosen. Everything else in it is a rev already named in
   `Move.toml`.

2. **Confirm the Phase 6 scope.** Unchanged from the build list:
   - delete `mint_attestation_cap` (`business_account.move:149`) — it lets
     Splash mint a capability to an arbitrary address, which is the inverse of
     canon;
   - add `owners` / `approvers` / `frozen` / `recovery_party`;
   - revocation that kills in-flight approvals, including revoke-then-regrant;
   - the 24h / USD 1,000 velocity cap;
   - `ComplianceCap` subtractive **by type**, with a CI check greping every
     `&ComplianceCap` signature;
   - the `TreasuryCap` / `AnchorCap` / `ComplianceCap` / `AdminCap` split;
   - then the adversarial pass in §7 of the build list.

3. **Decide on `move/splash_core/Move.toml`'s empty `[dependencies]`.** No
   pinned Sui framework means whichever CLI is installed silently defines the
   toolchain — which is precisely how today's 1.75.1/1.77.2 divergence went
   unnoticed until something ran. Worth pinning explicitly whether or not Phase
   6 proceeds. The comment block above it explains the deliberate *absence of
   third-party* dependencies; that reasoning is sound and is not what I am
   questioning.

4. **Review WS5, event privacy, before the immutable publish** (branch
   `ws5/event-privacy`, Master Prompt v3). Event structs freeze at publish.
   Every payment lifecycle event now carries `intent_id`, a 32-byte
   commitment, `status` and `timestamp_ms` instead of the sender, recipient,
   amount, currency, rate and beneficiary reference; the approval and receipt
   events carry the commitment where the amount was; three admin events drop
   a registration number, a KYB pointer, a risk score and a ceiling. The
   commitment is `blake2b256(tag || bcs(payload) || salt)`, computed off-chain,
   with the salt only in the Seal bundle (`docs/commitments.md`). Three things
   are yours to decide, listed in SECURITY.md under WS5: whether the objects
   should stop holding the same cleartext (same deadline), whether you want a
   per-event tag derived on chain rather than one commitment per payment, and
   whether to add the coarse `amount_band: u8` the prompt allows only with
   your approval. Every file under `move/` in that branch is yours to
   approve; nothing is published.

Phase 7 (break-glass) depends on Phase 6 and is untouched.

---

## Three things that will cause an outage if deployed singly

Not Phase 6 blockers — they bite the first time this branch is deployed. Full
detail in `docs/PHASE-STATUS.md`.

1. **Seal config file and env var must land in the same deploy.** Production
   refuses to boot without `config/seal.production.json` *and* refuses if any
   of the seven moved keys is still set on the host.
2. **Remove `CUSTOMER_EMAIL` and `CUSTOMER_PASSWORD` from the host.** Phase 3
   deleted that login path; both keys are declared must-be-unset, so a leftover
   value fails boot by name. Deliberate — a password in a file that governs
   nothing still reads as a control.
3. **Migrations `0004` and `0005` have never run against real Postgres**, only
   PGlite. `0004` is hand-written and *moves data* (existing users' org and
   role into `memberships`) before dropping those columns. Run it against a
   restored copy first.

And `PASSKEY_RP_ID` becomes unfixable the moment anyone enrols on production —
a WebAuthn credential is scoped to its rpId, so changing it later orphans every
credential with no migration path. If one passkey should work across
`splashz.xyz` and `v1.splashz.xyz`, the rpId must be the parent domain, decided
before the first enrolment.

---

## Current state

- 304 tests across eleven Node suites, plus 36 Move tests that run on this
  toolchain (14 core + 22 meter).
- `npx tsc --noEmit` clean. `npm run lint` clean — 3 warnings, all pre-existing.
- `npm run build` clean; `/admin/memberships` and `/api/admin/memberships` both
  in the route manifest.
- `.env.local` does not exist on the deployment hosts. Secrets belong there and
  must never be pasted into a chat or committed.
