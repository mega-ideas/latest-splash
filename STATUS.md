# Splash — mainnet cutover status

**Target:** Sui mainnet, week 2 September 2026
**Governing constraint:** Splash **cannot hold client funds** — self-imposed, enforced by the type system and by CI, and a precondition for operating before an e-money licence exists. No licence is held today.
E-money tier (RM 1.5M, Labuan money broking paras 6.1 + 6.2) is Phase 2, the name the code uses
(`PHASE_2_CUSTODY` in `lib/server/custody-phase.ts`). The build phases 0–7 below are a separate numbering.

**Build phases 0–7** (env contract, claims, money arithmetic, real users,
zkLogin, passkeys, Move authority, break-glass) are tracked separately in
[`docs/PHASE-STATUS.md`](docs/PHASE-STATUS.md) — including what is still
outstanding and the deploy-order items that will cause an outage if done
singly.

---

## The design thesis

Non-custody is not a runtime flag. It is a property of the type system.

`splash_core` — the package that publishes to mainnet — contains **no struct
that holds a `Balance<T>`**. Not gated; absent. Client value exists only as a
`Coin<T>` or `Balance<T>` parameter that enters and leaves a `payment_intent`
settle path inside a single PTB. In v2 it comes from the business's own wallet,
or under one of its spending rules. There is no object to accumulate into.

> *"How do I know Splash cannot hold my money?"*
>
> Runtime-gate answer: "There's a `LicenceState` object and every custodial
> function asserts against it — let me show you the call sites." Twelve minutes,
> trust required.
>
> Package-split answer: `npm run check:core`. Twelve seconds, no trust required.

`splash_custody` — every `Balance<T>` in the system — is **retired from the
mainnet path for good in v2 (D11)**: app-bound allowances and address balances
replace pooled settlement. It runs on testnet only. On mainnet the bytecode
does not exist on chain, so there is no flag to flip and no assert to forget.

---

## Package layout

```
move/
  splash_core/          ← mainnet. Upgradeable, ADDITIVE ONLY, behind the 24h delay (v2, D11).
    business_account.move  payment_intent.move  compliance_config.move
    multisig.move          audit_anchor.move    receipt_v2.move
    peg_monitor.move       cap_registry.move    spend_window.move

  splash_spend/         ← mainnet, IMMUTABLE. The only spender of app-bound allowances (D2).
    splash_spend.move      spend_policy.move

  splash_upgrade_delay/ ← mainnet, IMMUTABLE. Holds core's UpgradeCap behind a 24h public notice.
    upgrade_delay.move

  splash_meter/         ← retired from the mainnet path in v2 (code and tests kept).
  splash_custody/       ← retired from the mainnet path in v2 (code and tests kept).
```

Every package builds and tests with Sui CLI `mainnet-v1.82.3` (framework
`719fb296`); `sui::allowance` needs at least `v1.80.1`.

**Why `liquidity_guard` sits in custody.** It exists to protect *pooled* funds,
and pools only exist in custody. Keeping it in core also forced a DeepBook
dependency on the mainnet package — which mattered more than it looked: the
pinned DeepBook rev ships test files that fail to compile against this
toolchain, aborting the whole test build before our modules were reached. That
is why this repo had 93 lines of Move tests. Removing the dependency unblocked
the core suite, which now runs.

**Core has no third-party dependencies at all.** Cetus was drained through a bug
in a third-party math library ([BlockSec](https://blocksec.com/blog/cetus-incident-one-unchecked-shift-drains-223m-largest));
the strongest defence against that class is not auditing the dependency, it is
not having one.

---

## Mainnet gate

Do not publish `splash_core` until every line is checked.

- [x] `sui move build` clean for both packages
- [x] `sui move test` green for `splash_core` — **14 tests** (was 0 runnable)
- [x] `sui move test` green for `splash_custody` — **16 tests** (was blocked).
      DeepBook pin is `daa5a951`; see the CLI item below for how it got there.
- [x] **Sui CLI upgraded to 1.77.2 and the DeepBook pin moved forward** to
      `daa5a951` (2026-08-18). The toolchain floor was 1.61.1:
      `std::unit_test::destroy` arrived in sui `d95572e1c1` (#24078) and first
      shipped in `testnet-v1.61.1`, while DeepBook's tests began using it in
      `53d34351` — so on 1.59.1 the pin was too NEW, not too old. Suites were
      re-run on the new CLI BEFORE the pin moved (52/52, no change), then again
      after. Re-verified at the new rev rather than assumed: `FLOAT_SCALING ==
      1_000_000_000` matching `DEEPBOOK_PRICE_SCALING`, the three view
      signatures byte-identical, and no `published-at`.
      **Minimum CLI for this repo is now 1.61.1.**
      **2026-09-05: re-verified.** The dev machine had drifted to 1.75.1, on
      which `splash_custody` fails 0/16 with `MISSING_DEPENDENCY` in
      `0x2::object` — a whole-package linkage failure, not a code failure
      (`splash_core` and `splash_meter` have no dependencies and stayed
      green). 1.77.2 was reinstalled and all three suites re-run: **14 + 22 +
      16 = 52, no failures.** The checkboxes above hold, on 1.77.2 and not
      below it.
      Note the committed `Move.lock` still records `compiler-version =
      "1.59.1"` and pins framework `494fa6ed`. Any `sui move build` rewrites
      it to lock format 4 with that CLI's own framework rev (1.75.1 →
      `b9149cbf`, 1.77.2 → `06734f6f`); those rewrites have been reverted, so
      the pin on record is not the framework these tests ran against.
- [x] No value-bearing field in `splash_core` — `scripts/check-core-no-balance.mjs`,
      run by `.github/workflows/core-invariant.yml` on every push and PR, and by
      `npm run lint` locally. The checker parses struct BODIES out of
      comment-stripped source, so it catches nested containers
      (`Table<address, Balance<SUI>>`, `vector<Coin<SUI>>`, `Option<..>`),
      aliased imports (`Balance as Ledger`), multi-line fields, single-line
      structs and modules in subdirectories — every bypass an adversarial review
      found in the first version, each pinned in
      `tests/core-invariant-check.test.mjs` (12 tests). It also cross-checks the
      scanned module count against the compiler's bytecode output.
- [x] `npx tsc --noEmit` exits 0 · all TS suites green (165 tests)
- [x] M1 closed — `create` returns `PaymentIntent` only; no `SettleReceipt`
      without a consumed `Coin`; `AnchorWitness` enforces a single consumer
- [x] M-07 `revoke_verification` and M-08 `admin_set_paused` shipped — both are
      impossible to add after the UpgradeCap burns
- [x] M-09 `confirm_payment_intent` is generic over the coin, with the settlement
      asset bound at creation (abort 414)
- [x] **`settle_batch` replaced by `settle_batch_delegated`** — the old form
      needed owned objects from two different addresses and was unsignable by
      anyone. A tenant-granted `PayoutDelegation` carries the identity instead,
      so one signer suffices and attribution stays chain-enforced.
- [x] **A-11 built**: `move/splash_meter` (spend meters + guardian, **22 tests
      passing**), per-tenant credit segregation, tenant delegations with a
      30-day TTL, fixed fee recipient. Retired from the mainnet path with
      custody in v2 (D11); testnet only.
- [x] **Both treasuries metered.** `allocate` and `redeem` deleted; the
      operating floor, the withdrawal allowlist, the USDT sweep destination and
      the KYC threshold are all STORED rather than caller-supplied. Every value
      path charges a meter and can be paused by a guardian.
- [x] M3 closed in `splash_custody` — `deposit` is AdminCap-gated and emits
      `PoolFunded`; batch paths carry the owner binding
- [x] `'splash-my'` absent from settlement paths
- [x] `money-path.ts` free of Hata; `splashIsParty` on every step, asserted
- [x] The `AttestationCap` -> `AdminCap` fallback is DELETED (A-12). A missing
      `SPLASH_ATTESTATION_CAP_ID` now throws instead of silently re-arming the
      hot server with money authority.
- [ ] **`AdminCap` and `AttestationCap` at different addresses on chain** —
      cannot be verified from the repo. Run against the live wallet before
      publish; if they share an address this is **blocking**. The ruling is
      unambiguous: they may never share, because `update_peg` signs ~2,880 times
      a day from an internet-facing host.
- [ ] **Rotate `ComplianceCap` to a third address (C).**
      `compliance_config::create` transfers it to `ctx.sender()` — the multisig.
      `transfer_cap(cap, C)` is a required ceremony step missing from the runbook.
- [x] `UpgradeCap` decision made: **immutable core** (below)
- [ ] Independent Move review commissioned — deck slide 6 commits to this
- [ ] `splash_core` published; package ID + object IDs here and in `.env`
- [ ] One end-to-end mainnet settlement executed; digest recorded
- [x] `SECURITY.md` updated

---

## Upgrade policy — v2 (D11, 24 Oct 2026)

**Superseded:** until v2, `splash_core` was to publish immutable, with its
`UpgradeCap` burned. Decision D11 replaces that.
[`docs/UPGRADE-POLICY.md`](docs/UPGRADE-POLICY.md) has the procedure and
[`docs/v2/phase1-move-design.md`](docs/v2/phase1-move-design.md) the design.

- **`splash_core`: upgradeable, additive only.** The 2-of-3 governance
  multisig upgrades it through `splash_upgrade_delay`. Every proposal is
  announced 24 hours ahead, every business owner is alerted, and a proposal
  lapses 7 days after its notice runs out. No existing function can change.
- **`splash_upgrade_delay`: immutable.** It holds core's `UpgradeCap` for ever.
- **`splash_spend`: immutable.** It is the only code that spends under a
  business's app-bound allowances. Nothing in it can rotate a spender or let a
  permit out (`npm run check:spend`).
- **`splash_custody`, `splash_meter`: retired from the mainnet path.** The
  code and tests stay. Allowances and address balances replace pooling and the
  spend meter.

**Why the change.** An immutable core could never gain what v2 needs later:
a new asset, a new bridge adapter, a fix. Every fix would mean a fresh publish
and a re-bootstrap that orphans every business's spending rules. Additive-only
behind a public 24-hour delay keeps the property that matters: no existing
behaviour can change. Additions are announced to every owner before they
apply, and a business that disagrees can revoke its allowances first.

**v2 core is a fresh publish,** on testnet and on mainnet. Its struct and event
layouts differ from testnet package `0xae1fb78a…`, which no upgrade policy can
change, so every package and object ID is new.

---

## Phase 0 vs Phase 2 — what the server does

`SPLASH_CORE_PACKAGE_ID` names the core package and falls back to
`SPLASH_PACKAGE_ID`, which production requires at boot.

**On mainnet** every custody path (single transfer, delegated batch, Smart
Treasury allocation) refuses first, in every settlement mode, whatever is set,
with:

> `<path>` runs on splash_custody, which v2 retired from the mainnet path
> (D11): app-bound allowances and address balances replace pooled settlement
> and the delegated batch. Nothing was sent.

Production on mainnet also refuses to boot with `SPLASH_CUSTODY_PACKAGE_ID` or
`SPLASH_PAYOUT_DELEGATION_ID` set.

**On testnet**, set both package ids: with only `SPLASH_PACKAGE_ID`, the app
treats it as a pre-split package that also holds custody, and the refusal below
does not fire (`custodyPackageIdOrThrow` in `lib/server/sui-settlement.ts`).
With `SPLASH_CUSTODY_PACKAGE_ID` absent, any code path needing custody fails
with:

> Batch settlement requires the splash_custody package, which is not published
> here. v2 retired it from the mainnet path for good (D11); on testnet it needs
> SPLASH_CUSTODY_PACKAGE_ID. Phase 0 settles through payment_intent, which
> holds no balance. See STATUS.md.

The error names the retirement rather than only reporting a missing
environment variable, because "not configured" reads as a deployment mistake
when it is the design working.

---

## Out of scope for mainnet, scheduled immediately after

**Event privacy.** Every event publishes sender, recipient, amount, corridor and
fee in cleartext, and B2B counterparties use stable addresses. This does not
block mainnet. It **does** block the anchor buyer — no exporter puts their
supplier list on a public chain.

**Open items from the 2026-08-13 adversarial pass** (`SECURITY.md`, A-11..A-19)
— chiefly A-11 (no amount cap or velocity limit on any `AdminCap` function) and
A-12 (the S-10 cap split is written but not yet in effect at runtime). Both are
custody-side and land with the Phase 2 publish, but A-12 is an operational
change that should happen at the September ceremony regardless.
