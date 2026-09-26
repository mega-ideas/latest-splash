# Build phases — what is done, and what is not

Tracks `SPLASH-BUILD-LIST.md` / `SPLASH-CLAUDE-CODE-PROMPT.md`.
Companion to `STATUS.md`, which covers the mainnet cutover specifically.

**Branch:** `feat/phase5-passkey-authority` — contains Phases 0–5 in order, 14
commits off `main`. Each phase is one or more commits with its reasoning in the
message; nothing is squashed.

---

## Done

| Phase | What landed |
|---|---|
| **0 · Reproducibility** | `lib/env.ts` (147-key zod contract, validated at boot), `scripts/check-env-reads.mjs` in lint, Seal config → `config/seal.<env>.json`, `npm run doctor`, `GET /api/health`, Node 24 + npm 11 pinned with `engine-strict`, `setup-sui-pilot` ported to Node, `xlsx` (vendor CDN) → `read-excel-file` |
| **1 · Claims defects** | `PARTNER_ROWS` deleted — `/trust` states roles, not unsigned counterparties; the 2-of-3 claim corrected; `labuanApplication` now `not-licensed` and falsifiable; every MFCA "licence held" claim removed, including the README and the invariant checker's own error text |
| **2 · Money arithmetic** | `lib/money.ts` — bigint minor units, scaled-integer rates, explicit rounding. All 17 `W2` float-math sites migrated; the rule is a **hard build failure** now |
| **3 · Real users** | `users` split from `memberships` (no default role), scrypt password hashing, `createSignupSession` deleted, `resolveAuthorityForSession` fails closed, login rate limiting in Postgres, env credential pair removed |
| **4 · zkLogin UI** | "Continue with Google", `max_epoch` +1/+2 rule computed server-side, 15-minute idle timeout independent of `max_epoch`, callback keeps the token out of URL and history |
| **5 · Passkey authority** | SIP-9 enrolment at `/settings/security`, public key captured at creation and persisted, signature/sender/canon-hash verification, one active credential per origin |
| **6 · Move authority** | `BusinessAccount` is shared and holds `owners` / `approvers` / two freeze flags / `recovery_party` / `authority_epoch`; four eyes and revoke-then-regrant enforced on chain; `mint_attestation_cap` deleted; 24h per-account ceiling (`daily_limit`); `ComplianceCap` subtractive by type; `TreasuryCap` split out of `AdminCap`; two CI guards; adversarial pass |
| **7 · Break-glass** | `CapRegistry` + per-capability generations: a lost or stolen `AnchorCap` / `ComplianceCap` is killed on chain by a generation bump that mints its replacement in the same transaction. No timelock, and the module argues why. `check-cap-generations.mjs` fails the build if any consumer forgets the check |
| **Membership admin** (not a numbered phase) | `/admin/memberships` — the operator surface for the grant Phase 3 removed. One grant path, no default role, no account creation from the form, and the two money-moving roles say so at the point of granting. `scripts/dev-db.mjs` runs it locally without a cluster |
| **WS1 · Account verification** (Master Prompt v3, X5) | The pre-hijack closed as one unit: delivered single-use tokens (`email_verification_tokens`, migration `0006`), `EMAIL_TRANSPORT` that production cannot leave on `console`, the mailbox owner *sets* the password when the link is opened, `users.credential_version` in the session cookie ends every earlier session, both grant paths refuse an unverified address, zkLogin honours only a boolean `email_verified`, generic Postgres rate limits (`lib/server/rate-limit.ts`), and a real password reset. New pages `/verify-email` and `/reset-password`; `tests/account-verification.test.mjs` (16). Found on the way and fixed: the Phase 4 idle timeout had never fired (`lastSeenAt` was dropped on read); it now expires abandoned browsers, and only the route-handler entry re-stamps it |

| **WS5 · Event privacy** (Master Prompt v3, branch only, pending Sebastian) | Every payment lifecycle event in `splash_core` carries `intent_id`, a 32-byte `commitment`, `status` and `timestamp_ms` and nothing else; `SettlementAnchored` adds the two evidence pointers; the approval and receipt events carry the commitment where the amount was; `ApplicationReceived`, `BusinessVerified` and `DailyCapChanged` drop the registration number, KYB pointer, risk score and ceiling. The commitment is `blake2b256(tag ‖ bcs(payload) ‖ salt)` from `lib/evidence/commitment.ts`, with the salt and payload only in the v2 Seal bundle; Move asserts the length (`E_BAD_COMMITMENT` 420 / 804). `scripts/verify-commitment.mjs` checks a settlement against its events; `docs/commitments.md` carries the spec and vectors. `tests/event-privacy.test.mjs` (8), `event_privacy_tests.move` (7) |

| **WS6 · Phase-0 custody gates** (Master Prompt v3) | `lib/server/custody-phase.ts`: the custody package being configured is the Phase-2 switch. Until then a `STORED_BALANCE` or `SWEEP_ACCOUNT` delivery, a recipient set up for one, `/api/treasury`, and both treasury crons answer a plain, licence-named 403 (`custody_not_licensed`); the treasury page and the overview card say "Treasury arrives with our licence" and show no balance; the seeded demo transactions and balances are deleted; the copilot no longer reads the demo ledger or quotes a rate in Phase 0. `tests/phase0-custody-gate.test.mjs` (7) |

| **WS7 · Rate limits and security headers** (Master Prompt v3) | `lib/security/csp.ts` + `proxy.ts`: a per-request nonce, `strict-dynamic`, no `unsafe-inline` scripts, `frame-ancestors 'none'`; every page renders per request so the nonce is real. `lib/security/headers.ts` via `next.config.ts`: HSTS, nosniff, referrer policy, `X-Frame-Options`, `Permissions-Policy` on every response. `enforceRateLimit` in front of the pay link, all four copilot routes, Seal access, invoice and recipient creation; the login limiter rides the same module. `tests/rate-limits-and-headers.test.mjs` (10) |

| **WS9 · Landing, calculator, numbers, copy** (Master Prompt v3) | One landing, `components/landing/Landing.tsx`: eight sections in order (hero, record, calculator, how it works, numbers, pricing, FAQ, footer), no protocol names, and no comparison with a leg Splash does not price. `lib/fx/calculator.ts` prices USD to PHP in bigint minor units and shows no peso figure without a dated rate; `lib/fx/comparison-baselines.ts` names the World Bank Remittance Prices Worldwide dataset it quotes. `content/sea-numbers.ts` gives every published number a source, URL and date, and `scripts/check-numbers.mjs` (in lint) refuses an unsourced one in production. `content/brand.ts` is the only place the name, domain and support address live, and no legal entity is named on any surface. `scripts/copy-rules.mjs` gives every copy rule a reason, and the lint tells marketing routes (claims and jargon) from the signed-in product (claims only); the locked sentence in `content/money-path.ts` is the one file allowed to say "in process". The Sui-blue landing, the mobile landing and the settlement cinematic are deleted. `tests/landing-and-numbers.test.mjs` (9) |

**573 tests across 66 suites**, all passing, on the merged tree. The Move
packages declare **133 tests** (94 `splash_core` + 23 `splash_meter` +
16 `splash_custody`); that is a count of `#[test]` functions, **not** a run —
no Sui CLI is installed on the machine this merge was integrated on, so
`sui move build` and `sui move test` are still owed before any publish.
Eleven CI guards in `npm run lint`, all green: five Move-invariant
(`check:core`, `check:compliance`, `check:treasury`, `check:generations`,
`check:aborts`) plus `check:copy`, `check:numbers`, `check:migrations`,
`check:stores`, `check:binary` and `check:env`. Lint and `tsc --noEmit` are
clean.

---

## Not done

### Nothing.

Phases 0 through 7 are complete. What remains is not a phase — it is the
deployment and the review, both listed below.

---

## Deploy consequences of Phases 6 and 7 — read before publishing

Together they are a **breaking ABI change**. There is no migration from the
deployed package; it needs a fresh publish and fresh object ids for everything.

1. `submit_application` takes a `&Clock` (the account carries a 24h window
   whose first bucket is stamped at creation).
2. `BusinessAccount` is a SHARED object. Anything holding one as an owned
   object breaks; `take_from_sender` becomes `take_shared`.
3. `mint_attestation_cap` is gone. `AnchorCap` is minted at publish and moved
   with `rotate_anchor_cap` (one in, one out).
4. `SPLASH_CAP_REGISTRY_ID` is new and REQUIRED. Every call that uses an
   `AnchorCap` or a `ComplianceCap` passes the shared registry, so the peg
   refresh, anchor writes, receipt minting and every compliance operation
   fail to build without it. That is deliberate: a code path that skipped
   the registry would be a path where a revoked capability still works.
5. `AttestationCap` is `AnchorCap`. `SPLASH_ATTESTATION_CAP_ID` is declared
   must-be-unset and boot fails by name if it is still set on the host — set
   `SPLASH_ANCHOR_CAP_ID` instead.
6. `SPLASH_TREASURY_CAP_ID` is new and required for every withdrawal path.
7. `compliance_config::update` is `tighten` (and refuses a loosening),
   `set_paused` is `pause` (halt only), `allow_pool` is `admin_allow_pool`
   (`&AdminCap`). The server and `scripts/set-compliance-config.mjs` refuse a
   loosening locally and print the `admin_set_parameters` command instead.
8. An account-bound intent can ONLY settle through `confirm_with_approval`.
   Existing off-chain flows that call `confirm_payment_intent` keep working for
   unbound intents and will abort (415) on a bound one.

---

## Configuration still outstanding

On the founder's machine the file is `D:/phase1-main/.env.local`; this table
does not record what is set in it. Secrets belong in that file and must never
be pasted into a chat or committed.

| Key | Who | Note |
|---|---|---|
| `DATABASE_URL` | you, in `.env.local` | Phases 3–5 need it; auth and passkeys are Postgres-backed |
| `ENOKI_API_KEY` | optional | Not needed: USDC transfers carry no gas on Sui (2026-09-26). Only the health probe reads it |
| `SPLASH_PACKAGE_ID` | public — can be committed | `npm run doctor` fails on this today |
| `SUI_NETWORK` | public | `testnet` until a mainnet package exists. The USDC stablecoin lane is mainnet-only and does not read it; it uses `SUI_MAINNET_RPC_URL` |
| Seal committee | public — goes in `config/seal.production.json` | Object ids, aggregator URLs, weights, threshold, package + policy ids |
| `ZKLOGIN_GOOGLE_CLIENT_ID` | public | **Part of zkLogin address derivation.** One per environment, never rotated after users exist |
| `PASSKEY_RP_ID` | public | **See the warning below** |

### `PASSKEY_RP_ID` is the one that becomes unfixable

Unset, it falls back to `NEXT_PUBLIC_APP_URL`'s hostname. The moment anyone
enrols a passkey on production, that value is frozen: a WebAuthn credential is
scoped to its rpId and the browser will not offer it on any other host, so
changing it orphans every existing credential with no migration path.

If one passkey should work across `splashz.xyz` **and** `v1.splashz.xyz`, the
rpId must be the parent domain — and that cannot be decided retroactively.

---

## Deploy order — three things that will cause an outage if done singly

These are not Phase 6 blockers. They bite the first time this branch is
deployed.

1. **Seal: the file and the env var must land in the same deploy.**
   Production refuses to boot without `config/seal.production.json`, *and*
   refuses if `SEAL_KEY_SERVER_ENDPOINTS` (or any of the six other moved keys)
   is still set on the host. Both, together, or neither.

2. **Remove `CUSTOMER_EMAIL` and `CUSTOMER_PASSWORD` from the host.**
   Phase 3 deleted that login path and both keys are declared must-be-unset, so
   a leftover value fails boot by name. Deliberate: a password in a file that
   governs nothing still reads as a control.

3. **Migrations `0004` and `0005` have never run against real Postgres** —
   only PGlite, in tests. `0004` is the risky one: hand-written, because
   drizzle-kit needed a TTY to resolve whether `org_id` was renamed or dropped,
   and it **moves data** (existing users' org and role into `memberships`)
   before dropping those columns. Run it against a restored copy first.

### And nobody can log in until a membership is granted

Existing `users` rows have no `password_hash`, so no previous credential works.
The first real account is created through `/api/auth/signup` — which grants
nothing by design — and then needs a membership.

**The screen for that now exists**: `/admin/memberships` in the staff console.
It calls the same `grantMembership()` and nothing else can create a membership
(a test asserts `lib/server/memberships.ts` contains no `.insert(` of its own).
It refuses to grant to an address with no account, has no default role, and
names in plain words which roles release money. Revoking is a hard delete —
a membership is current authority, not evidence.

So the first-operator sequence is: sign up → a staff member grants the
membership → the account can act. Nothing about it is implicit.

---

## Known gaps that are nobody's phase

- **`npm run test:seal:integration` has never been run here.** It needs
  `.env.local` credentials and live network access.
- **Two pre-existing eslint warnings** — `SPLASH_BUSINESS_ACCOUNT_ID` and
  `getTreasuryRate`, both unused. Predate this work; left alone deliberately.
- **`docs/` and `experiments/` are published in the public `SplashAN` repo.**
  Every unsigned counterparty was de-named, so nothing false or attributable is
  public, but the mainnet checklist, the key-ceremony runbook and the deployment
  topology are readable by anyone.
- **`SplashAN` has no LICENSE file.** Public with no licence means all rights
  reserved by default — possibly what you want, but currently a default rather
  than a decision.
- **`SplashAN` is one squashed commit** and does not carry Phases 2–5. It is a
  showcase, not a mirror.
