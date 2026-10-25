# Splash — mainnet program checklist (post-demo)

Status snapshot 2026-07-18, the day before demo day. Source of truth for
"what's left": the mainnet-readiness prompt (W1–W8) + the W9/W10 addendum.
Order of work: W1 → W2 → (W3 ∥ W4) → W5 → W6 → W7 → W8; W10 alongside.

## v2 mainnet steps — human only (brief §9, 24 Oct 2026)

Claude Code writes these steps and does not perform them. Nothing here is
done by a script that holds a mainnet key. The design is in
[`docs/v2/phase1-move-design.md`](v2/phase1-move-design.md) and the
procedure in [`docs/UPGRADE-POLICY.md`](UPGRADE-POLICY.md).

**Before any publish**

- [ ] Sui CLI `mainnet-v1.82.3`. Every package passes `sui move build &&
      sui move test`, and `npm run lint` passes, including `check:core`,
      `check:spend` and `check:fees` (the generated fee-vector test is up to
      date, the 100 bps ceiling is the same in `splash_core`, `splash_spend`
      and `lib/fees/schedule.ts`, no literal fee rate in customer copy, and
      no immediate fee setter but `set_discount`).
- [ ] The independent Move review (OtterSec, or Zellic as backup) has signed
      off on this exact source commit. Record the commit.
- [ ] **The governance multisig exists**: Sky, Sebastian and the cold backup,
      2-of-3, with no single member able to sign alone. Record its address and
      the three public keys. It never signs `0x2::address_alias`.
- [ ] **The Splash finance multisig exists**, the fee recipient: no single
      member able to sign alone, and no member key the KMS operator's. Record
      its address and its members' keys (`flag || public key`), weights and
      threshold: the fee recipient proposal names exactly these. If Splash
      ops gets its own multisig for `OpsCap`, record it too
      (`SPLASH_OPS_ADDRESS`).
- [ ] The previously exposed operator and API keys are rotated, and the
      operator signs only through AWS KMS (`OPERATOR_KMS_KEY_ID`; production
      refuses a raw key at boot).

**Publish order (fresh packages; v2 core is not an upgrade of anything)**

1. [ ] Publish `splash_core`. Record the package ID, `AdminCap`,
       `TreasuryCap`, `AnchorCap`, `CapRegistry`, the `ConfigTicket` and
       the `UpgradeCap`, and from Amendment A1 the shared `FeeConfig` and
       address `Registry` and the `FeeAdminCap` and `OpsCap` (both minted to
       the publisher). `FeeConfig` starts with the launch schedule and **no
       fee recipient**, so Splash's fees are off and nothing is ever paid to
       the publisher.
2. [ ] `compliance_config::create<USDC>`, consuming the `ConfigTicket`, with
       native mainnet USDC
       (`0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`).
       Exactly one config can ever exist. Record its ID. Every
       `spend_policy::create_policy` must pass this config, and each policy
       records its ID: `splash_spend` then opens and pays only against it.
3. [ ] Publish `splash_spend` and make it immutable **in the same
       transaction**: one PTB with `Publish`, then
       `0x2::package::make_immutable` on the `UpgradeCap` the publish
       returned, and nothing else. A separate transaction leaves a window in
       which one key holds the `UpgradeCap`, and the verify step fails such a
       publish. Record the digest.
4. [ ] Publish `splash_upgrade_delay` the same way: `Publish` and
       `make_immutable` in one transaction. Record the digest.
       `scripts/e2e-testnet.mjs` (through `scripts/v2-end-state.mjs`) checks
       both publishes: each must be exactly those two commands, leave no
       `UpgradeCap` behind, and be version 1 with no later versions.
5. [ ] Transfer core's `UpgradeCap` to the governance multisig. The multisig
       calls `upgrade_delay::wrap(cap, keys, weights, threshold)` itself,
       which makes the policy additive. Record the `DelayedUpgradeCap` ID.
       Confirm on chain that the policy is 128 (additive) and the owner is the
       multisig.
6. [ ] Transfer `AdminCap` to the governance multisig. Transfer the
       `ComplianceCap` to a third address (2-of-3), never the operator's.
6a. [ ] **The fee ceremony.** Transfer `FeeAdminCap` and `OpsCap` to the
       governance multisig (`OpsCap` may go to a separate Splash ops multisig
       instead), never the operator's. Both have `store`, so a plain transfer
       works. With `FeeAdminCap` one key could set any discount at once and
       propose any schedule or recipient alone.
6b. [ ] Read `FeeConfig`'s schedules and check each kind against A1 §2.2
       (`docs/v2/fees.md`): Splash business free; wallet 2 bps, minimum
       250,000 and maximum 5,000,000 minor units; exchange 15/12/10/7/5 bps
       and cross-chain and bank payout 30/20/12/7/5 bps, on upper bounds of
       1,000, 10,000, 50,000 and 100,000 USDC and `u64::MAX`, minimum 0,
       maximum `u64::MAX`. The verify step does not read the schedule, so
       this is a manual read; record the output.
6c. [ ] The governance multisig calls `fee_config::propose_fee_recipient`
       with the finance multisig's member keys, weights and threshold. The
       chain derives the address and refuses a multisig one member can sign
       for (1304). Check that the `FeeRecipientProposed` event names the
       finance multisig's recorded address. Wait 24 hours. Then call
       `apply_fee_recipient`, no later than seven days after the notice ran
       out (1306 after that: propose again). Splash's fees are on from then.
       Until then every fee is 0, which is a valid state to onboard in; do
       not leave a proposal for any other address pending (withdraw it with
       `cancel_fee_recipient_proposal`).
6d. [ ] Splash ops (the `OpsCap` holder) registers each signed payout
       partner's deposit addresses with `address_registry::add_partner_address`,
       and checks each `PartnerAddressAdded` event. A payment to a
       registered address is charged and settled only as a bank payout.
       Business wallets need no step: verification enters them.
7. [ ] The governance multisig calls
       `compliance_config::propose_addition<splash_spend::splash_spend::SettleWitness>`
       for the settlement-app registry (2). Wait 24 hours. Then call
       `activate_addition`, no later than 7 days after the notice ran out.
       Spending rules work from then on.
8. [ ] Do not register any bridge adapter until the CCTP V2 adapter has been
       reviewed and published **immutable**.
8a. [ ] **Before the first business onboards, read the config's registries
       and check them exactly.** `settlement_apps` is exactly
       `[<published splash_spend>::splash_spend::SettleWitness]`,
       `bridge_adapters` is `[]`, `accepted_assets` is exactly native mainnet
       USDC, and `pending_additions` is `[]`. Read `FeeConfig` too: no
       schedule proposal is pending for any kind, and either no fee recipient
       is set and none but the finance multisig is pending, or the finance
       multisig is the recipient. On-chain governance checks prove
       only that the sender holds `AdminCap` and is a multisig no single
       member can sign for, not that it is the governance multisig, and a
       proposal made before the alert cron runs reaches no owner.
       `scripts/v2-end-state.mjs` does not read the registries, so this is a
       manual read; record the output.
8b. [ ] **Before any asset addition:** confirm the asset has 6 decimals
       (`coin_registry::decimals` on its `Currency`). Tier ceilings, the
       bank-payout floor and the 10,000 USDC second-approval threshold are
       6-decimal minor units, and `activate_addition` does not check
       decimals.
9. [ ] ~~Decision for Sky: when the legacy approver path closes.~~ **Gone:
       there is no legacy path to close.** This step used to ask when to
       switch off `legacy_enabled` (`admin_disable_legacy` or
       `disable_legacy`). Sky decided (decision 3, 24 Oct 2026) not to
       publish the legacy approval path at all, because a public function,
       however firmly closed, can never be removed once published. So v2 core
       has no `legacy_enabled`, no approver set and no
       `confirm_with_approval`, and none of those functions exists to call.
       The check is now only that `tests/legacy-path-removed.test.mjs` passes
       on the audited commit.

**Environment (mainnet)**

- [ ] `SPLASH_CORE_PACKAGE_ID`, `SPLASH_PACKAGE_ID`,
      `SPLASH_COMPLIANCE_CONFIG_ID`, `SPLASH_CAP_REGISTRY_ID` and
      `SPLASH_ANCHOR_CAP_ID` are set to the new IDs, as are the governance
      alert IDs `SPLASH_UPGRADE_DELAY_PACKAGE_ID` and
      `SPLASH_UPGRADE_WRAPPER_ID`.
- [ ] `SPLASH_FEE_CONFIG_ID` and `SPLASH_ADDRESS_REGISTRY_ID` are set (the
      quote API reads the fee from `FeeConfig`, and on mainnet without it no
      fee is quoted and no payment is built; `verify_business` and the
      operator-outflow monitor need the `Registry`), and so is
      `SPLASH_SPEND_PACKAGE_ID` (the operator-outflow monitor's approved
      path), with `SPLASH_SPEND_POLICY_REGISTRY_ID`, the `PolicyRegistry`
      splash_spend shares at publish (spending rules, §4.2: without both no
      rule is built or read). For the verify step, also `SPLASH_FEE_ADMIN_CAP_ID`,
      `SPLASH_OPS_CAP_ID`, `SPLASH_OPS_ADDRESS` (blank: the governance
      multisig) and `SPLASH_FINANCE_ADDRESS`; unset, those checks are
      reported skipped, never passed.
- [ ] The near-threshold alert cron (`/api/cron/spend-rule-alerts`) is
      scheduled hourly with `CRON_SECRET`, and answers 200 (a 502 lists the
      businesses whose spending rules could not be read).
- [ ] The governance alert cron reads `FeeConfig` too: with
      `SPLASH_FEE_CONFIG_ID` unset it answers 502, and a 502 naming it means
      the id is not the canonical `FeeConfig` of core's original package. A
      test fee proposal on testnet (a schedule and a recipient) reached every
      test owner.
- [ ] `SPLASH_CUSTODY_PACKAGE_ID` and `SPLASH_PAYOUT_DELEGATION_ID` are
      **unset**. Production on mainnet refuses to boot with either, because
      custody and the meter are retired in v2. On mainnet the
      `splash_custody` settlement paths (single transfer, delegated batch,
      Smart Treasury allocation) refuse in every `SUI_SETTLEMENT_MODE`, so
      `SUI_SETTLEMENT_MODE=simulate` or `SUI_BATCH_SETTLEMENT_MODE=simulate`
      cannot mark a batch SETTLED.
- [ ] `FUNDING_DEPOSIT_DERIVATION_SECRET` and
      `FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON` are **unset**. Production on
      mainnet refuses to boot with either: on mainnet funding sessions give
      out no deposit address (D1, D3), and a stablecoin funding session is
      refused with `no_deposit_address_on_mainnet`.
- [ ] The governance alert cron (`/api/cron/governance-alerts`) is scheduled,
      and a test proposal on testnet reached every test owner. Against the
      mainnet ids it answers 200. A 502 naming `SPLASH_UPGRADE_WRAPPER_ID` or
      `SPLASH_COMPLIANCE_CONFIG_ID` means that id is not the canonical object.
- [ ] **The hardware 2-of-3 passkey check has passed on testnet** (owed from
      Phase 0): run on testnet by one approver (Sky, decided 25 Oct) with
      three of his own authenticators on three kinds of device, as three
      owner logins of one testnet business; the runbook in
      `docs/v2/phase2-business-wallet.md`, `scripts/wallet-hardware-check.mjs`
      output and the executed registration digest recorded under a
      `wallet-2-of-3` heading in `docs/mainnet-checks-2026-10.md`. No business
      wallet is created on mainnet before it: the code refuses every wallet
      request on mainnet until `WALLET_MAINNET_ENABLED=true` and
      `WALLET_HARDWARE_CHECK_REF=docs/mainnet-checks-2026-10.md#wallet-2-of-3`
      are both set, and production will not boot with only the first.
- [ ] A testnet dry run shows a transaction sponsored from the operator's SUI
      **address balance** (no gas coin) is accepted, before
      `WALLET_GAS_SPONSOR=operator` is set. The operator's SUI address balance
      is funded, within `OPERATOR_HOT_BALANCE_CEILING_MICRO`'s intent.
- [ ] The wallet signature sweep (`/api/cron/wallet-signing`) is scheduled
      every five minutes and answers 200 (it also reconciles submissions whose
      outcome is unknown, and answers 502 while any is stuck).

**Partners and legal**

- [ ] Sumsub, Elliptic and every payout partner contract is signed before its
      flag is switched on.
- [ ] Compliance (v2 §4.6, `docs/v2/phase2-compliance.md`): Sumsub's webhook
      is set to `HMAC_SHA256_HEX` and `SUMSUB_WEBHOOK_SECRET` is set
      (`SUMSUB_WEBHOOK_ALLOW_SHA1` stays off, or is turned off once the switch
      is made); compliance confirms `KYT_SCREENING_MAX_AGE_HOURS` (default
      24); one
      KYB applicant and one Travel Rule transfer are run in Sumsub's sandbox
      against this code before `SUMSUB_TRAVEL_RULE_ENABLED=true`; Elliptic's
      wallet-exposure call is checked against the contracted account's
      sandbox, and compliance sets `ELLIPTIC_REVIEW_SCORE` and
      `ELLIPTIC_BLOCK_SCORE`; counsel confirms whose Travel Rule obligation
      a payment from the business's own self-hosted wallet to an exchange is,
      and the sender-declaration wording.
- [ ] `SIGNED_PARTNERS` lists exactly the partners whose agreements are
      signed. It is empty by default, and nobody is named until then.
- [ ] The SSM registration number is entered in `BRAND.legalEntity`
      (`content/brand.ts`). The footer carries no entity until it is.
- [ ] Legal sign-off on Treasury, including the Halogen referral wording,
      before Treasury is enabled.
- [ ] Each partner confirms its deposit-address model (Phase 0 check 6). Is
      the address fixed per business, or issued per payout? **Decided by Sky
      (decision 2, 24 Oct 2026):** fixed per business per partner, verified
      once by a test deposit and bound to its beneficiaries by the business
      wallet. Each partner still confirms it can work that way, and on which
      networks it deposits.
- [ ] Withdrawals (v2 §4.4, `docs/v2/phase2-withdrawals.md`): set
      `WITHDRAWAL_ACCOUNT_KEY` (random, at least 32 characters, kept like any
      other secret; to rotate, move the old value to
      `WITHDRAWAL_ACCOUNT_KEY_PREVIOUS`; losing every key makes the stored bank
      accounts unusable), and `SPLASH_CORE_ORIGINAL_PACKAGE_ID` (required in
      production: withdrawals refuse without it). Schedule
      `/api/cron/withdrawals` every five minutes, and `/api/cron/cross-chain`
      every ten (it needs `CCTP_IRIS_API_URL`). Before relying on the
      derived intent id, dry-run one kind 4 withdrawal on testnet and compare
      the created intent with `withdrawals.intent_id`.
      The Hata and Fiuu credentials (`HATA_API_KEY`, `HATA_WEBHOOK_SECRET`,
      `FIUU_MERCHANT_ID`, `FIUU_VERIFY_KEY`) are set only once both contracts
      are signed and the adapter is wired. Each partner's deposit address is
      added to the on-chain partner registry (`OpsCap`), or a kind 4 payout
      to it aborts. `PAYOUT_SANDBOX_WEBHOOKS_ENABLED` stays off in
      production.

## Shipped (in review)
- [x] W9.0 type & color discipline · W9.1 quote comparison card ·
      W9.2 receipt + proof layer + share link · W9.4 money-path panel
      (collapsed) · W9.5 delivery timeline — **PR #3**
- [x] W1 PR-A: Drizzle schema (16 tables), DO Postgres client,
      double-entry ledger + CI invariant, checked-in migration — **PR #4**

## Decisions locked (2026-07-18)
- Postgres host: **DigitalOcean Managed PostgreSQL**
- W4 KYT: **stub + provider interface** until the Elliptic contract signs
- Audit: **OtterSec first** inquiry (Zellic backup) — 0xSky books
- PR #2 (IA restructure): **closed**, branch kept for post-launch

## W1 — persistence (remaining)
- [ ] PR-B: migrate stores off fs/in-memory (customer profiles, operating
      settings, seal policies, proposals/approvals, operations) onto the
      schema; delete `writeFileSync` stores; **cold-start test: pending
      approval survives a restart**
- [ ] Provision DO cluster; `DATABASE_URL` in env (0xSky)
- [ ] Restore drill executed once with evidence (docs/W1-BACKUPS.md)

## W2 — money correctness
- [ ] Sweep ~10 parseFloat/toFixed money paths to bigint minor units (lib/money/)
- [ ] Lint rule banning float math on amounts in lib/server, lib/fx
- [ ] Idempotency end-to-end (client key on every money POST, response replay,
      PTB dedupe by intent→digest)
- [ ] FX quote lifecycle: persisted quotes, hard expiry, settlement rejects expired
- [ ] Partial-failure sagas: convert-ok/payout-fail → retry → OPS_HOLD;
      payout-ok/webhook-missing → recon resolves; settle-ok/offramp-reject →
      quarantine account. Admin surface per terminal state
- [ ] Property test: same-key replay = identical result, single ledger effect

## W3 — partner rails
- [ ] Stripe `stripe-signature` + Airwallex HMAC verification; webhook_events
      inbox with unique constraint; async processing
- [ ] FX venue error taxonomy + tier routing tests (SC spot / Labuan / OTC)
- [ ] Second PH payout adapter to PDAX parity; corridor failover router; status polling
- [ ] Credential separation: sandbox vs prod namespaces; mixed-mode boot refusal
- [ ] K3 load test: 50-payout batch vs a payout-partner sandbox (needs API access)

## W4 — compliance rails (largest gap)
- [ ] KYT pipeline behind provider interface + stub: screen at beneficiary
      create, pre-settlement, inbound funding; screening_results persisted;
      risk ≥ threshold → COMPLIANCE_HOLD lane; fail closed
- [ ] KYB tier → server-enforced limits in lib/policy/evaluate.ts; middleware
      assertion on every money route
- [ ] Sanctions name screening + travel-rule data package (per payout-partner format)
- [ ] Append-only compliance artifacts, Walrus-anchored
- [ ] Swap Elliptic into the interface when contract signs (0xSky procurement)

## W5 — keys & chain
- [ ] lib/chain/signer.ts isolation; env-key impl (testnet) + KMS stub (mainnet);
      zero key reads outside the module (grep-proof)
- [ ] Key rotation runbook + one testnet rotation drill
- [ ] Mainnet config profile (network, package, native USDC via CCTP, Pyth,
      Walrus/Seal) — refuse boot on partial profile
- [ ] PTB gas headroom, typed retries, digest-before-state-advance recon
- [ ] AdminCap 2-of-3 transfer drill on testnet; upgrade policy recorded
- [ ] OtterSec audit booked (0xSky) → engagement → fixes (HARD mainnet blocker)
- [ ] Audit package prep: module inventory, specs, threat model, coverage

## W6 — controls hardening
- [ ] Maker-checker in the approval API: approver ≠ maker, distinct dual
      approvers, threshold from settings — server-asserted with tests
- [ ] Role middleware on every money + admin route (evidence table)
- [ ] Circuit breaker: trip conditions, corridor auto-pause, dual-admin re-arm,
      chaos-tested
- [ ] Velocity limits per org and corridor

## W7 — observability & reconciliation
- [ ] Correlation id = intent id through every log line; structured JSON
- [ ] Alert rules: settlement failure, webhook lag, peg deviation, partner
      error rate, cron missed, COMPLIANCE_HOLD aging
- [ ] Daily recon job: ledger ↔ chain ↔ partner statements → exceptions report
- [ ] Runbooks (stuck payment, partner outage, key compromise, peg break,
      webhook flood, DB restore) — each drilled once

## W8 — QA & launch gates
- [ ] Invariant suite in CI (money conservation, idempotency, policy bounds,
      screening-blocks-settlement)
- [ ] E2E lifecycle test on testnet: fund → convert → settle → payout → recon
- [ ] Dress rehearsal: full lifecycle through the mainnet profile mechanism
- [ ] Go/no-go: audit ✓ · AdminCap 2-of-3 ✓ · KMS ✓ · KYT fail-closed ✓ ·
      partner prod credentials ✓ · Labuan/K1 ✓ · recon zero-exception ≥5d ✓ ·
      runbooks drilled ✓ · K2/K3/K4 evidence ✓ · 0xWal evals zero banned
      assertions ✓ · injection fixtures ✓

## W9 — remaining surface
- [ ] W9.3 supplier relationship page at /dashboard/recipients (after W1 PR-B
      lands real aggregates; isOnSplash() helper — recommendation: claimed
      account)

## W10 — 0xWal intelligence
- [ ] 10.1 knowledge corpus + retrieval + claims guard on output
- [ ] 10.2 org-scoped read tools + draft-only write tools
- [ ] 10.3 persona/system prompt versioned in repo
- [ ] 10.4 MemWal allowlisted memory, visible + deletable
- [ ] 10.5 daily operating scan (cron), digest → queue drafts only
- [ ] 10.6 injection defense for extract-invoice + adversarial fixtures
- [ ] 10.7 eval harness in CI (golden/adversarial/task sets; banned-assertion
      and unauthorized-action rates must be 0)

## Standing items for 0xSky
- [ ] Send OtterSec inquiry (calendar is the August risk)
- [ ] Provision DO Postgres + DATABASE_URL
- [ ] Elliptic contract status
- [ ] Second PH payout partner: agreement signed, then sandbox access
- [ ] Review/merge PR #3 (W9) and PR #4 (W1 PR-A)
