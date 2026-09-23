# Handover — v2 deployment, 5 September 2026

Supersedes `HANDOVERSEBASTIAN.md`, which is stale in four measurable ways
recorded below. Written after deploying `v2.splashz.xyz` for the MUBA Hack
demo.

Protocol unchanged: **Move changes are confirmed by the CTO. No
self-approval.** No Move source was changed in this work — `splash_core` was
published as-is.

---

## The one-paragraph version

`v2.splashz.xyz` is live on Node 24, Postgres 14 on-box, Sui 1.77.2, with
`splash_core` published to testnet and `splash_custody` deliberately absent.
zkLogin is on. Every decision the previous handover asked for is now answered
except one, and every outage risk it named is closed. 304 Node tests and 107
Move tests are green. Two real bugs were found and fixed that would each have
broken the demo. **One thing is blocked and needs you: the git remote
`sky9484/splashAN` now returns 404, so six commits cannot be pushed.**

---

## Status of everything the previous handover asked for

Each row was verified by running or reading it on the box, not by trusting
either document.

| # | It asked for | Status | Evidence |
|---|---|---|---|
| D1 | Decide about the lockfiles | **Resolved** | `Move.lock` is already `version = 4` pinned to `06734f6f` — the 1.77.2 framework. The publish changed only quote style (`'` → `"`), same rev, same digests. The handover's claim that it pins 1.59.1/`494fa6ed` is out of date. |
| D2 | Confirm Phase 6 scope | **Already built** | All seven sub-items are in the source; see the audit below. |
| D3 | Decide the empty `[dependencies]` | **STILL OPEN** | Still empty, deliberately. See "What still needs you". |
| R1 | Seal config file + env must land together | **Closed** | `config/seal.production.json` committed; none of the seven moved keys is set on the host. |
| R2 | Remove `CUSTOMER_EMAIL` / `CUSTOMER_PASSWORD` | **Closed** | Neither is present in `.env.local`. Boot is clean. |
| R3 | Migrations `0004`/`0005` never run on real Postgres | **Closed** | Both applied against real Postgres 14.24. 22 tables. `0004` had no data to move on a fresh database, so its risky path was never exercised — see gaps. |
| — | `PASSKEY_RP_ID` before first enrolment | **Decided** | Set to `v2.splashz.xyz` on the CTO's explicit instruction, with 0 credentials enrolled at the time. |

### Phase 6 audit — all seven items are present

The previous handover says "Phase 6 is blocked on you alone" and "it has not
started". Both are wrong. Verified in `move/splash_core/sources/`:

- `mint_attestation_cap` — **deleted.** It survives only in comments that
  explain the deletion (`cap_registry.move:5`, `business_account.move:336,833`).
- `owners` / `approvers` / `frozen` / `recovery_party` — all present in
  `business_account.move`.
- Revocation that kills in-flight approvals — implemented as cap
  **generations**; a cap from a superseded generation is dead on chain
  (`business_account.move:183-191`). Enforced by `npm run check:generations`.
- 24h velocity cap — `daily_limit.move`, `WINDOW_MS = 86_400_000`.
- `ComplianceCap` subtractive by type — enforced in CI by
  `scripts/check-compliance-subtractive.mjs`.
- The `TreasuryCap` / `AnchorCap` / `ComplianceCap` / `AdminCap` split —
  four separate structs, and the publish created three of them as distinct
  on-chain objects.

**Phase 7 is also in.** Cap generations are described in the source as a
Phase 7 addition, and `break_glass_tests` run green.

### The other three stale claims

| Handover says | Actual |
|---|---|
| 52 Move tests (14 + 22 + 16) | **107** (68 core + 23 meter + 16 custody) |
| 304 tests across eleven Node suites | 304 confirmed — this one is right |
| Committed lock records `compiler-version = "1.59.1"` | Lock is v4 on `06734f6f` |
| `sui move build` on any CLI silently repins the lock | Not observed on 1.77.2. A full `sui move test` across all three packages left the working tree clean. |

---

## What is deployed

| | |
|---|---|
| URL | https://v2.splashz.xyz (TLS to 2026-12-04, its own cert — v1's was never reissued) |
| Host | droplet address in the team password manager; service `splash-an`, port 3005 |
| Node | 24.11.1 at `/opt/node24` (v1 stays on `/usr/bin/node` 22 — deliberately isolated) |
| Database | PostgreSQL 14.24 on-box, role/db `splashan`, 22 tables |
| Sui CLI | 1.77.2 (`51d177ad7d65`); 1.75.1 kept at `/usr/local/bin/sui-1.75.1-backup` |
| `splash_core` | `0xae1fb78a654fde843bcf88836a43aae4d76b6758bd44acb8ee12cc69d60067b7` |
| `splash_custody` | **not published** — regulatory posture, not a gap |
| `splash_meter` | not published — it is a library only custody links against |
| Posture | `NODE_ENV=production` with `USE_MOCK_APIS=true` and `NEXT_PUBLIC_DEMO_MODE=true` |
| zkLogin | **on**, Google client `233426498982-…`, project `splashz` |
| v1 | untouched throughout, still `active`, still 200 |

On-chain objects from the publish:

```
AdminCap     0x4449b9c44867a44b4f6ccc76e10e6e2bc315aaeaea34356a9c738a238ae349ce
AnchorCap    0x86f996f6b87483ee826f900a3cd0b0bbc01b60c70edfe19b6a4e1f28cb353d0c
TreasuryCap  0xfac57086421e40e6721494dc52a7827404cf82b3aae6a0797f759f5b11efe591
CapRegistry  0x9593c85669eb24ee2cc2bafea768f95c1d71a26f93e029e513057b2f1a2ec4d2  (shared)
UpgradeCap   0x7c95896b5b8e9f31b46bc5b2d516f5d667d53b89453644d18b2fb41f0b2c729f
```

`Published.toml` records the same, and is committed.

### Why both `SPLASH_PACKAGE_ID` and `SPLASH_CORE_PACKAGE_ID` are set

They hold the same value, and that is deliberate. `SPLASH_PACKAGE_ID` is
required unconditionally in production. But `custodyPackageIdOrThrow()` falls
back to the legacy id **only when `SPLASH_CORE_PACKAGE_ID` is unset** — so
setting core is what *disables* the fallback and makes batch settlement throw
the licence-named error instead of silently targeting a `settlement` module
that does not exist in `splash_core`.

That error is the demo's best beat: non-custody is enforced by absent
bytecode, not by a flag anyone could flip.

---

## Two bugs found, both would have broken the demo

**1. Seal blocked every payment.** `canUseDemoCrypto()` tested `NODE_ENV`
alone, so a deployment with the demo flags set still demanded a live Seal
committee and refused every payment with *"Seal is read-only: No Seal key
servers configured"* — the same failure v1 hit. `lib/env.ts` already makes the
vendor keys optional under those same flags and calls that "a posture decision
recorded by those flags"; Seal now reads the same signal.

There was a test deliberately pinning the old behaviour. It was **not**
deleted — it was re-pinned behaviourally, which is stronger than the source-text
regex it replaced:

```
canUseDemoCrypto({ NODE_ENV: 'production' })                          === false
canUseDemoCrypto({ NODE_ENV: 'production', USE_MOCK_APIS: 'true' })   === true
```

A real deployment that declares no demo posture still gets real crypto and
still fails closed. **This is a security-posture change and wants your explicit
sign-off. It must be reverted before any real-money deployment.**

**2. zkLogin could never have worked.** `fetchEpochInfo()` looked for
`getLatestSuiSystemState` — the retired JSON-RPC name. `lib/sui.ts` builds a
`SuiGrpcClient`, which calls it `core.getCurrentSystemState` and returns a
different shape (fields under a `systemState` envelope, `epochDurationMs` moved
into `parameters`, every scalar a string). The lookup never found a function,
so every sign-in would have died with *"The Sui epoch could not be read"*
before the user reached Google. Found by dry-running the enable script with a
placeholder client id rather than trusting it.

Worth noting the code failed *correctly*: it returned null rather than
inventing an epoch, which is why the failure was a clean 503 and not a proof
the network would silently reject.

---

## The six commits (unpushed — see blocker)

```
032eb80 feat: add privacy policy and terms of service
afd7498 fix(zklogin): read the epoch from the gRPC client
d3f0ac0 chore(move): record the splash_core testnet publish
40f3fed config: add the production Seal config file
7bc784f fix(seal): let the demo flags govern demo crypto
bf4229d chore: drop the stray node dependency
```

`bf4229d` is worth reading: `package.json` declared `engines.node >=24.11 <25`
while `dependencies` pulled `node ^26.3.0`. npm installs that as
`node_modules/.bin/node` and prepends it to PATH, so every `npm run` executed on
Node 26 while `which node` reported 24. `doctor` was reporting a version nobody
could locate.

---

## End-to-end verification

A 41-check suite runs against the deployed site through nginx and TLS
(`e2e.sh` on the droplet). **41 pass, 0 fail.** What it covers beyond the
happy path:

- A malformed JWT and an **`alg=none` forged JWT** are both rejected (400).
- Wrong admin password rejected; `/api/admin/memberships`, `/api/transfers`
  and `/api/treasury` all 401 with no session.
- Self-signup refused in production (403) — `CUSTOMER_SELF_SIGNUP_ENABLED`
  is false, so workspaces are provisioned deliberately.
- The demo posture uses mock Seal, **and** a deployment with no demo flags
  still fails closed. Both directions, not just the convenient one.
- The licence-named custody refusal is present in the compiled server bundle.

**zkLogin is confirmed working with real data, not by assertion.** A sign-in
completed at 14:27 UTC on 5 September 2026: a `wallet_identities` row exists
with a derived Sui address, and its stored `aud` equals this deployment's
Google client id — which is the cross-app impersonation guard in
`lib/auth/zklogin.ts` doing its job.

### Two gaps this surfaced, both now fixed

**`ADMIN_EMAIL` was empty.** `validateAdminCredentials` refuses every login in
production unless `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET`
are all set. Nobody could have reached `/admin`. Set, and admin login is now
verified end to end including the console page.

**No membership existed.** Phase 3 means signing in grants nothing —
`resolveAuthorityForSession` throws rather than provisioning, which is correct
and was working as designed. The first membership was seeded through
`grantMembership`, the single function able to create one, with `grantedBy`
recorded.

Worth knowing for the demo: **self-approval is blocked on chain**, not in the
application. `business_account.move` asserts `maker != approver`
(`E_SELF_APPROVAL`, abort 29). No role, including `admin`, can bypass it — so
demonstrating a full maker → checker flow needs two distinct identities.

---

## What still needs you

**1. `splash_core/Move.toml` has an empty `[dependencies]` (D3, still open).**
The absence of *third-party* dependencies is deliberate and well argued in the
file — Cetus was drained through a third-party math library, and the defence is
not auditing the dependency but not having one. That reasoning is sound and is
not what is in question. The open point is that with `[dependencies]` empty,
the **Sui framework** itself is pinned only by `Move.lock`. Today that lock is
v4 on `06734f6f`, which matches the toolchain the 107 tests ran against, so the
risk is much smaller than when the handover was written. Pinning explicitly in
the manifest would close it entirely; leaving it means the lock stays the single
source of truth. Either is defensible.

**2. Sign off (or reject) the `canUseDemoCrypto` change** described above.

**3. Confirm the legal pages.** `/privacy-policy` and `/terms-of-service` exist
because the Google consent screen links to them. They are `noindex` until
`LEGAL_APPROVED=true`. They are drafts and have not been reviewed by counsel.
They assert: governing law Malaysia; liability capped at the greater of three
months of fees or USD 100; contacts `privacy@` / `legal@` / `security@`
`splashz.xyz` — **those mailboxes must actually receive mail.**

**4. Decide `USDC_TYPE`.** Left empty. Production rejects the `0x2::sui::SUI`
stand-in, and it is only *required* when settlement is live, which it is not
under the demo flags. Needs a real coin type before any live settlement.

---

## Known gaps — stated rather than buried

- **The OAuth consent screen is published ("In production", External).** While
  it was in Testing only the project owner could sign in — owners bypass the
  test-user list, which is why the first successful sign-in happened with an
  empty test-user list and would *not* have worked for anyone else. Scopes are
  `openid email`, both non-sensitive, so no Google verification is required and
  the 100-user cap does not apply.
- **Migration `0004` moved no data**, because the database was fresh. Its
  hand-written data-migration path is therefore still unexercised. It will
  matter the first time this runs against a database that already has users.
- **No real Seal committee.** `seal.production.json` is committed unconfigured
  (empty `servers[]`, which the loader reports as unconfigured rather than an
  error). Fine under demo posture; not fine for production.
- **`splash_meter` is unpublished.** Nothing references it at runtime, so this
  is not currently a gap — but batch settlement will need it alongside custody.
- **Vendor keys are all empty** (Enoki, Walrus, PDAX, Stripe, Airwallex).
  Intentional: `vendorsLive` is false under the demo flags.
- **`sudo` for the `splash` user** is limited to three
  `systemctl … splash-an` verbs via `/etc/sudoers.d/splash-an`.

---

## Operating it

This repository is public, so the droplet address is not written here. Set
`SPLASH_HOST` from the team password manager before pasting anything below.

```bash
# health
curl -s https://v2.splashz.xyz/api/auth/zklogin/params
ssh splash@$SPLASH_HOST 'sudo systemctl status splash-an'
ssh splash@$SPLASH_HOST 'journalctl -u splash-an -n 50 --no-pager'

# full gate (from /home/splash/splashAN, PATH=/opt/node24/bin:$PATH)
npm run doctor        # 0 failures expected
npm run lint          # chains the six check:* invariants
npm run build

# turn zkLogin off in ~10s
ssh splash@$SPLASH_HOST 'cd ~/splashAN && sed -i s/^FEATURE_ZKLOGIN=.*/FEATURE_ZKLOGIN=false/ .env.local && sudo systemctl restart splash-an'
# and on
ssh splash@$SPLASH_HOST './enable-zklogin.sh <GOOGLE_CLIENT_ID>'
```

Secrets live on the box, never in the repo and never in chat:

```
~/.secrets/database_url        ~/.secrets/v2_admin_password
~/.secrets/v2_zklogin_salt     ~/.secrets/env.local.bak.*
```

`ZKLOGIN_USER_SALT` feeds address derivation — **losing it changes every
derived address.** The Google client secret is at `~/.splash-secrets/` on the
CTO's Mac, moved out of the repo where it had been left untracked but
un-ignored; `client_secret_*.json` is now in `.gitignore`. The secret is not
needed by this flow (`response_type=id_token`), only the public client id.

---

## Test baseline

```
Node   304 / 304   (seal 10, env 12, health 7, auth 93, money 17,
                    db 14, funding 12, batch 4, explorer 6, oxwal 129)
Move   107 / 107   (core 68, meter 23, custody 16)
E2E     41 / 41    (./e2e.sh, against the deployed site over TLS)
doctor 0 failures  ·  lint clean  ·  tsc --noEmit clean
```

A full `sui move test` across all three packages leaves the working tree
clean — no lockfile repin on 1.77.2.
