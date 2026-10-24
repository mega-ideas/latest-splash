# Key ceremony & fresh-publish runbook — operator key split (spec §5)

**Status:** Move code is written, builds clean, and is committed. `splash_core` has a
testnet publish recorded in `move/splash_core/Published.toml`. **Nothing is on
mainnet.** This runbook is what Sebastian runs on the deploy server to land it.

**Why this exists:** today ONE key signs settlement, wields `AdminCap`, and pays gas.
That is the Step Finance failure mode — one compromised credential is theft *and* audit
forgery in a single transaction. After this ceremony, stealing the hot server key buys an
attacker the ability to write attestations, not to move funds.

---

## 0 · What changed in the code (already committed)

**Phase 6 changed this ceremony.** There are now FOUR capabilities, not two,
and the cold key is no longer `AdminCap`. Read this section before following
any step below.

| Cap | Holds what authority | Where it lives |
|---|---|---|
| `TreasuryCap` | The ONLY capability through which value leaves a custodial object — five functions, enforced by `scripts/check-treasury-cap.mjs` | Cold 2-of-3. Never online. |
| `AdminCap` | Governance: KYB verify/revoke, compliance-side account freeze, per-account 24h ceilings, limit and allowlist changes, guardian minting, anchor-cap rotation, `compliance_config::create` and every relaxation | Governance multisig. Moves no value. |
| `AnchorCap` | Non-financial attestations: peg pushes, audit anchors, receipts | Hot operator server. |
| `ComplianceCap` | Tighten, pause, remove a venue. Subtractive by type — enforced by `scripts/check-compliance-subtractive.mjs` | Compliance custodian. |

All three of `AdminCap`, `TreasuryCap` and `AnchorCap` are minted by
`business_account::init` at publish, to the publisher. The ceremony is about
moving them apart, not about creating them.

**Phase 7 added break-glass.** `AnchorCap` and `ComplianceCap` carry a
generation checked against the shared `CapRegistry` on every use, so a
capability can be revoked:

| Situation | Command | Effect |
|---|---|---|
| Routine handover, old cap in hand | `business_account::rotate_anchor_cap` | Custody moves. Generation carried, nothing revoked. |
| Cap LOST | `business_account::arm_break_glass_anchor_cap`, then `business_account::execute_break_glass_anchor_cap` within 90 seconds | Generation bumps, one replacement minted to the holder named when arming. No old cap needed. |
| Cap STOLEN | same | The thief's object stops working. They are not consulted. |
| Armed by mistake | `business_account::cancel_break_glass` | Clears the arming. Nothing is revoked. |
| Compliance cap compromised | `compliance_config::arm_break_glass_compliance_cap`, then `compliance_config::execute_break_glass_compliance_cap` within 90 seconds | Same, for `ComplianceCap`. |

Break-glass is two `AdminCap` transactions with a 90-second commit window
(`ARM_WINDOW_MS` in `cap_registry`). Arming names the new holder and revokes
nothing. Executing inside the window bumps the generation and mints the
replacement to the armed holder; the execute call cannot change the holder.
If the window lapses, arm again. Only one arming can be live at a time. The
window is not a notice period. The reasoning is in `cap_registry`'s module
comment: the generation already makes a duplicate capability impossible, so a
long delay would protect nothing and would hand a thief a cancellation window.
The 90 seconds only stops a misclick or a stale script from killing a live
capability in one step.

**Operational cost, and it is real**: the moment a break-glass lands, the
operator server's cap is dead and anchoring fails until the new object id is
deployed. Have `SPLASH_ANCHOR_CAP_ID` ready to update before you sign. Alert on
`CapabilityRevoked` — it is the loudest event this package emits, and it means
an operational capability was killed.

`AdminCap` and `TreasuryCap` have NO generation and no break-glass. They are
`store` capabilities held by multisig addresses, and `AdminCap` is the key that
arms every break-glass above, so it cannot be the subject of one. Losing a
quorum of those is what the ceremony below exists to make very unlikely.

`AnchorCap` gates:

| Function | Before | After |
|---|---|---|
| `peg_monitor::update_peg` | `&AdminCap` | **`&AnchorCap`** |
| `audit_anchor::anchor_audit_hash` | `&AdminCap` | **`&AnchorCap`** |
| `receipt_v2::create_receipt` | `&AdminCap` | **`&AnchorCap`** |
| `smart_treasury::emit_rebalance` (`splash_custody`, not published in Phase 0) | `&AdminCap` | **`&AnchorCap`** |

Everything through which value LEAVES a custodial object is `TreasuryCap`, and
there are exactly five, all in `splash_custody`, which does not publish in
Phase 0: `settlement::refund`, `settlement::withdraw_fees`,
`smart_treasury::withdraw`, `dual_treasury::settle_usdt` and
`dual_treasury::emergency_sweep`. Deposits stay on `AdminCap` — putting money in
is not the risk. Everything else (pool and treasury creation, allowlists,
floors, limit changes, pauses, guardian minting, `compliance_config::create`,
`peg_monitor::init_peg_state`) is governance and stays on `AdminCap`, which can
no longer split a balance at all.

`AnchorCap` is deliberately **`key` only, no `store`** — it cannot be
`public_transfer`red out of the module, so every custody change goes through
`rotate_anchor_cap` / `destroy_anchor_cap` and emits an event. `AdminCap` keeps
`store` precisely so it *can* be moved to a multisig address.

**The runtime fallback is gone (A-12).** `anchorCapObjectId()` in
`lib/server/sui-settlement.ts` throws when `SPLASH_ANCHOR_CAP_ID` is unset, and
`capRegistryObjectId()` throws when `SPLASH_CAP_REGISTRY_ID` is unset, so every
call the app builds with the `AnchorCap` fails rather than quietly borrowing the
money key. The scheduled peg refresh (`/api/cron/update-peg`, which calls
`refreshPegOnSui`) fails the same way. The warn-and-skip `updatePegOnSui` in
the same file is unused.
The deployed immutable package predates all of this and cannot be migrated —
Phase 6 is a breaking ABI change (`submit_application` takes a `&Clock`,
`BusinessAccount` is shared, `mint_attestation_cap` is gone), so it needs a
fresh publish and fresh object ids for everything below.

---

## 1 · ⚠️ The one decision this runbook cannot make for you

**Testnet only.** Batch settlement lives in `splash_custody`, which v2 retires
from the mainnet path for good (D11): app-bound allowances and address
balances replace pooled settlement and the delegated batch. On mainnet every
custody path refuses in every settlement mode, and production refuses to boot
with `SPLASH_CUSTODY_PACKAGE_ID` set. On testnet, without
`SPLASH_CUSTODY_PACKAGE_ID`, the app refuses batches
(`custodyPackageIdOrThrow` in `lib/server/sui-settlement.ts`). This section
is kept for testnet and for the record. The
custody source has also moved on since this section was written: batches now
settle through `settlement::settle_sui_batch_delegated` against a
`PayoutDelegation` (`move/splash_custody/sources/settlement.move`), which takes
no `AdminCap`. Re-read this section against that source before the custody
publish.

**After `AdminCap` moves to a cold 2-of-3 multisig, the hot server can no longer run batch
payouts.**

`settlement::settle_sui_batch` pays recipients out of the shared `SettlementPool` and is
therefore `AdminCap`-gated (correctly — otherwise any hot key could drain the pool). But
the batch PTB *also* pushes a peg reading, which is now `AnchorCap`-gated. So that
one transaction needs **both** caps, and one of them is deliberately offline.

Single transfers are unaffected: `settle_payment` takes no capability, so that path stays
fully hot.

Pick one before the ceremony:

| Option | Consequence |
|---|---|
| **A. Accept it** — batch becomes a deliberate, multisig-signed operation | Safest. Batch payouts stop being push-button and need a signing session. |
| **B. Add a bounded `SettlementCap`** — hot, but limited (per-batch cap, allowlisted pool, expiry) | Keeps batch automated; needs new Move code + its own review. **Not written yet.** |
| **C. Delay** — keep `AdminCap` hot for now, split only the attestation surface | Gets most of the benefit immediately; money authority still on one hot key. |

The code as committed supports A and C unchanged. B is a follow-up.

---

## 2 · Prerequisites

- A Sui CLI that can reach a **gRPC-capable** fullnode on the network you publish to.
  The public JSON-RPC is retired (v1.76.0 line). The testnet publish in
  `move/splash_core/Published.toml` was built with toolchain 1.77.2; use that CLI,
  or publish from the deploy server.
- The three signer addresses for the 2-of-3 multisig (spec §10.1). **Open decision:**
  the third signer is not chosen. You + Sebastian + who? Each signer generates their own key on their own
  machine. Nobody types anybody else's seed.
- A funded gas key, separate from everything else.

---

## 3 · Ceremony

### 3.1 Create the cold multisig (before publishing)
Each of the three signers, independently:
```bash
sui keytool generate ed25519
```
Collect the three **public keys** (never the private keys), then:
```bash
sui keytool multi-sig-address --pks <pk1> <pk2> <pk3> --weights 1 1 1 --threshold 2
```
Record the multisig address. Verify each signer can independently reproduce it from the
same public keys — if the address differs, stop.

### 3.2 Publish the package(s)

⚠️ **v2 (24 Oct 2026) changes this step.** Mainnet publishes three packages, in
order: `splash_core`, then `splash_spend` and `splash_upgrade_delay`, each of
the last two made immutable **in its own publish transaction**: one PTB with
`Publish`, then `0x2::package::make_immutable` on the `UpgradeCap` it
returned. Making it immutable in a later transaction leaves a window in which
one key can upgrade the package, and the verify step (§3.8, through
`scripts/v2-end-state.mjs`) fails such a publish. Core's `UpgradeCap` is
not burned; it goes into the `splash_upgrade_delay` wrapper, which allows only
additive upgrades after 24 hours' public notice. The order and every step are
in `docs/MAINNET-CHECKLIST.md` ("v2 mainnet steps") and `docs/UPGRADE-POLICY.md`.
What follows is the v1 procedure; where they disagree, those two files win.

⚠️ **`move/` is now TWO packages** (2026-08-17). There is no `move/Move.toml` any more.

**Phase 0 — publish `splash_core` ONLY.**
```bash
cd move/splash_core
sui move build && sui move test        # every test must pass
sui client publish --gas-budget 500000000
```

**Do NOT publish `splash_custody`.** It holds every `Balance<T>` in the system, and the
Splash holds no licence permitting it to hold client funds. Leaving it unpublished is the
control: there is no flag to flip, because the bytecode does not exist on chain. v2
retires it from the mainnet path for good (D11); it runs on testnet only — see
`STATUS.md`.

The current combined package is **immutable**, so this mints a NEW package id and every
shared object from the old package is unusable by the new one.

Record from the publish output: the new **package id**; the **AdminCap**,
**TreasuryCap** and **AnchorCap** object ids (all three minted to the publisher by
`business_account::init`); the shared **CapRegistry** id (shared by
`cap_registry::init` in the same transaction); and the **UpgradeCap**. v2
(Amendment A1) adds four more from the same publish: the shared **FeeConfig**
(`fee_config::init`, the launch schedule and no fee recipient, so Splash's
fees are off), the shared address **Registry** (`address_registry::init`),
and the **FeeAdminCap** and **OpsCap**, both minted to the publisher.

> **Superseded in v2 (D11).** Core upgrades additive-only through
> `splash_upgrade_delay`; see the note at the top of this step. The v1 decision
> is kept below for the record.
>
> **Decision made (STATUS.md): `splash_core` publishes IMMUTABLE — burn the `UpgradeCap`.**
> A settlement contract whose logic cannot change is a stronger regulatory position than
> one under multisig, where "who holds the keys" becomes a custody procedure an auditor
> takes on trust. The package split is what makes this affordable: core is eight modules
> with no third-party dependencies.
>
> The cost is real — a post-publish bug needs a fresh publish and a full re-bootstrap.
> That is why the independent review gate in `STATUS.md` is not optional.
>
> If you overrule this and keep the `UpgradeCap`, it MUST go into the same cold multisig.
> An unrestricted `UpgradeCap` on a hot key makes the whole cap split meaningless, because
> the package can simply be rewritten.

Then set both package ids in the environment:
```
SPLASH_CORE_PACKAGE_ID=<new core package id>
SPLASH_CUSTODY_PACKAGE_ID=                  # EMPTY: retired in v2; production on mainnet refuses to boot with it
```

### 3.3 Re-bootstrap every shared object
Nothing carries over. `CapRegistry` already exists from the publish. Re-create
and record ids for:
`compliance_config::create<SettlementAsset>` → shared `ComplianceConfig` + a
  `ComplianceCap` sent to the caller. In v2 the type argument is the first
  accepted asset (native USDC on mainnet) and the call consumes the
  `ConfigTicket` the publish minted, so only one config can ever exist.
  ⚠️ Its arguments, in order: `ConfigTicket`, `AdminCap`, `CapRegistry`,
  `max_deviation_ppm`, `max_staleness_ms`, `max_slippage_bps`,
  `min_depth_base_units`, `min_settlement_amount`, `allowed_deepbook_pools`.
  The last two need care:
  **`min_settlement_amount`** — the v2 bank-payout floor, in the settled
  coin's MINOR UNITS: `payment_intent` holds every bank payout (kind 4 since
  Amendment A1; kind 1 before) to the
  larger of this and 99 USDC, at creation and at settlement (abort 434).
  100_000_000 makes the v2 bank-payout floor 100 USDC. Wallet,
  Splash-business and cross-chain payments have no floor. Zero is rejected,
  so the floor cannot be disabled by accident;
  **`allowed_deepbook_pools: vector<ID>`** — the venue whitelist (audit
  S-12). Must be non-empty: pass the DeepBook pool id you intend to run against,
  i.e. exactly what `DEEPBOOK_POOL_ID` will hold. An empty vector aborts (355)
  rather than defaulting to "any pool", because "any pool" is the vulnerability.
  Duplicates abort. Manage it afterwards with
  `scripts/set-compliance-config.mjs --allow-pool <id>` / `--disallow-pool <id>`;
  the last remaining venue cannot be removed — halt with the pause switch instead;
`peg_monitor::init_peg_state` (`AdminCap`, clock `0x6`) → `PegState`. It fails
  `assert_pegged` until the first real `update_peg`;
`business_account::submit_application` (`ssm_number`, `kyb_cid`, clock `0x6`)
  → shared `BusinessAccount`, then `verify_business` (`AdminCap`, the account,
  the address `Registry`, `risk_score`). The `Registry` comes after the
  account: verification enters a registered business wallet in it, so a
  payment to that wallet from another business is a free Splash-business
  payment.

**Testnet only.** These live in `splash_custody`, which v2 retires from the
mainnet path for good (D11). Skip them on mainnet:
`settlement` pool → `SettlementPool<SUI>`;
`smart_treasury::init_treasury` → `SmartTreasury<SUI>`;
`dual_treasury` buffer if USDT is in use.

**Drain the old pools first.** Any SUI left in the previous `SettlementPool` /
`SmartTreasury` is only reachable with the OLD `AdminCap` against the OLD package —
withdraw it *before* you retire that key.

### 3.4 Move the AnchorCap to the hot server
```bash
sui client call --package <CORE_PACKAGE_ID> --module business_account \
  --function rotate_anchor_cap --args <ADMIN_CAP_ID> <CURRENT_ANCHOR_CAP_ID> <OPERATOR_SERVER_ADDRESS> --gas-budget 20000000
```
Record the `AnchorCapRotated` event's `new_cap_id`. The old id is deleted.

### 3.5 Move the ComplianceCap to its custodian
`compliance_config::create` sent the `ComplianceCap` to you, the caller. It is
`key` only, with no `store`, so `sui client transfer` cannot move it. Its holder
moves it with `transfer_cap`:
```bash
sui client call --package <CORE_PACKAGE_ID> --module compliance_config \
  --function transfer_cap --args <COMPLIANCE_CAP_ID> <COMPLIANCE_CUSTODIAN_ADDRESS> --gas-budget 20000000
```
The object id does not change. Choose the custodian with care. The app's
compliance controls (`updateComplianceControls` in `lib/server/sui-settlement.ts`)
and `scripts/set-compliance-config.mjs` both sign with `OPERATOR_SUI_PRIVATE_KEY`,
so they only work while the custodian is the operator address. With a separate
custodian, tightening and pausing are signed from that custodian's own key.

### 3.6 Move AdminCap and TreasuryCap to the cold multisig — LAST
Do this only after 3.3 to 3.5 succeed, because every bootstrap step above needs
`AdminCap` and you will not have convenient access to it afterwards.
```bash
sui client transfer --to <MULTISIG_ADDRESS> --object-id <ADMIN_CAP_ID> --gas-budget 20000000
sui client transfer --to <MULTISIG_ADDRESS> --object-id <TREASURY_CAP_ID> --gas-budget 20000000
```
After this, the admin console's KYB approval can no longer sign
`verify_business`: `verifyBusinessOnSui` (`lib/server/sui-settlement.ts`) passes
`AdminCap` from the operator key. Run `verify_business` from the multisig
instead, or keep business verification off-chain until that is wired.

Both caps have `key, store`, so a plain transfer works. No function in
`splash_core` takes `TreasuryCap`; only `splash_custody` does. Move it now so the
publisher key holds no money authority when custody publishes. §0 puts
`AdminCap` on a governance multisig and `TreasuryCap` on the cold 2-of-3. This
runbook creates one multisig in 3.1; if governance gets its own, send `AdminCap`
there instead.

**v2: FeeAdminCap, OpsCap and the fee recipient.** Move `FeeAdminCap` and
`OpsCap` (both `key, store`) the same way, to the governance multisig; `OpsCap`
may go to a separate Splash ops multisig instead. Never leave either with the
publisher or the operator. Then, from the governance multisig,
`fee_config::propose_fee_recipient` with the finance multisig's member keys,
weights and threshold, and `apply_fee_recipient` after 24 hours and within
seven days; and, from the `OpsCap` holder, `address_registry::add_partner_address`
for each signed partner's deposit address. The order and the checks are
`docs/MAINNET-CHECKLIST.md` steps 6a to 6d.

Then **prove you can use it**: execute one trivial `AdminCap`-gated call signed 2-of-3
(e.g. a no-op `verify_business` on a throwaway account) *before* you rely on this in
production. An unrehearsed multisig is an untested backup.

### 3.7 Update the environment (the Droplet's `.env.local`)
On the Droplet the app reads `.env.local` in its live checkout. Find it with
`sudo -u splash pm2 describe splash | grep 'exec cwd'` (`/opt/splash` or
`/opt/splash-next`, per `docs/DEPLOY-DIGITALOCEAN.md` step 9). Update your local `.env.local` too if you run
the scripts below from it. A value in `data/contract-config.json` overrides the
environment for every field `lib/server/contract-config.ts` reads, so update or
remove that file too if it exists.
```
SPLASH_CORE_PACKAGE_ID=<new core package id>
SPLASH_PACKAGE_ID=<same core package id>    # legacy alias: production refuses to boot without it; the health check and the scripts read it
SPLASH_CUSTODY_PACKAGE_ID=                  # EMPTY: retired in v2 (D11); production on mainnet refuses to boot with it
SPLASH_ADMIN_CAP_ID=<from 3.2>              # now owned by the multisig
SPLASH_TREASURY_CAP_ID=<from 3.2>           # cold multisig; recorded, not read by the app
SPLASH_ANCHOR_CAP_ID=<new_cap_id from 3.4>  # hot server
SPLASH_CAP_REGISTRY_ID=<from 3.2>
SPLASH_PEG_STATE_ID=<new>
SPLASH_COMPLIANCE_CONFIG_ID=<new>
SPLASH_COMPLIANCE_CAP_ID=<new>              # unchanged by transfer_cap in 3.5
SPLASH_BUSINESS_ACCOUNT_ID=<new>
DEEPBOOK_POOL_ID=<the pool passed to compliance_config::create>
SPLASH_FEE_CONFIG_ID=<from 3.2>             # A1: the quote API reads the fee schedule and recipient here
SPLASH_ADDRESS_REGISTRY_ID=<from 3.2>       # A1: verify_business and the operator-outflow monitor
SPLASH_SPEND_PACKAGE_ID=<splash_spend>      # the operator-outflow monitor's approved path, and the verify step
SPLASH_FEE_ADMIN_CAP_ID=<from 3.2>          # verify step only: must be held by the governance multisig
SPLASH_OPS_CAP_ID=<from 3.2>                # verify step only: must be held by SPLASH_OPS_ADDRESS
SPLASH_OPS_ADDRESS=<ops multisig, or blank> # verify step only: blank means the governance multisig
SPLASH_FINANCE_ADDRESS=<finance multisig>   # verify step only: the only fee recipient FeeConfig may have
```
Testnet custody only, blank on mainnet (v2 retires `splash_custody` from the
mainnet path, D11): `SPLASH_TREASURY_ID` (`SettlementPool<SUI>`),
`SPLASH_SMART_TREASURY_SUI_ID`, `SPLASH_PAYOUT_DELEGATION_ID`. Production on
mainnet refuses to boot with `SPLASH_PAYOUT_DELEGATION_ID` set.

Rules the app enforces:
- `SPLASH_ANCHOR_CAP_ID` and `SPLASH_CAP_REGISTRY_ID` are required. Every call the
  app builds with the `AnchorCap` throws without them (`anchorCapObjectId`,
  `capRegistryObjectId` in `lib/server/sui-settlement.ts`).
- `SPLASH_ATTESTATION_CAP_ID` must be unset. `lib/env.ts` rejects any value; it
  was renamed to `SPLASH_ANCHOR_CAP_ID`.
- `SPLASH_TEST_RECIPIENT_ADDRESS` must be unset on mainnet. With
  `SUI_NETWORK=mainnet`, settlement throws while it is set, because it redirects
  every payout to one address.

Then run `NODE_ENV=production npm run doctor` and restart the app
(`pm2 restart splash` in `docs/DEPLOY-DIGITALOCEAN.md`; the recorded v1 host runs
`splash-v4.service`, see `docs/v1-cutover.md`).

Also commit the regenerated `move/splash_core/Published.toml`.

### 3.8 Verify
```bash
node --use-system-ca --experimental-strip-types --env-file=.env.local scripts/e2e-testnet.mjs
```
It takes the network and node from `lib/sui.ts`, as the app does, and
SIMULATES every transaction: the node runs it as the named sender would and
reports the result. Nothing is signed or sent and no gas is spent, so run it
on mainnet too. The script holds no key and cannot sign; it takes no
arguments. It reads the same ids as the app (`SPLASH_CORE_PACKAGE_ID`,
falling back to `SPLASH_PACKAGE_ID`; `SPLASH_ANCHOR_CAP_ID`;
`SPLASH_CAP_REGISTRY_ID`; `SPLASH_PEG_STATE_ID`; `SPLASH_COMPLIANCE_CONFIG_ID`;
`SPLASH_BUSINESS_ACCOUNT_ID`; `SPLASH_ADMIN_CAP_ID` when set; `USDC_TYPE`, or
Circle's USDC on the network when it is unset), plus
`SPLASH_VERIFY_BUSINESS_ACCOUNT_ID` for the payment check and the end-state
ids below, and checks:
- the package id matches `move/splash_core/Published.toml` for the chain (a
  failure if it names another package, a warning if the file has no record
  for this chain);
- every id exists and belongs to that package;
- the operator holds the `AnchorCap`, and holds none of the package's
  `AdminCap`, `TreasuryCap` or `UpgradeCap` (read from what the operator owns,
  so the ids need not be set; a failure on mainnet, a warning on testnet). The
  first two go to the cold multisig in §3.6; in v2 the `UpgradeCap` goes into
  the `splash_upgrade_delay` wrapper (`docs/UPGRADE-POLICY.md`);
- every function it calls takes the parameters the current source declares. A
  failure here means the package was published from different source: publish
  the current `splash_core` (§3.2). The checks that call a mismatched function
  report that instead of running;
- D11's end state, through `scripts/v2-end-state.mjs`: `splash_spend`
  (`SPLASH_SPEND_PACKAGE_ID`) and `splash_upgrade_delay`
  (`SPLASH_UPGRADE_DELAY_PACKAGE_ID`) are version 1 with no later version,
  and each publish transaction was exactly `Publish` then
  `0x2::package::make_immutable`, so no `UpgradeCap` for them outlived it;
  core's `UpgradeCap` is in `SPLASH_UPGRADE_WRAPPER_ID`, additive (128), held
  by `SPLASH_GOVERNANCE_ADDRESS`. An unset id is reported skipped, never
  passed. It does not read the `ComplianceConfig` registries; check those by
  hand (`docs/MAINNET-CHECKLIST.md`);
- Amendment A1's end state, through the same script: `SPLASH_FEE_CONFIG_ID`
  is splash_core's shared `FeeConfig`, and so is `SPLASH_ADDRESS_REGISTRY_ID`
  its `Registry`; `FeeAdminCap` (`SPLASH_FEE_ADMIN_CAP_ID`) is held by
  `SPLASH_GOVERNANCE_ADDRESS`, and `OpsCap` (`SPLASH_OPS_CAP_ID`) by
  `SPLASH_OPS_ADDRESS`, or by the governance multisig when that is blank; the
  operator holds neither; and `FeeConfig` pays no one until the finance
  multisig (`SPLASH_FINANCE_ADDRESS`) is applied, and then only it. A pending
  recipient change to any other address fails the check, which names
  `cancel_fee_recipient_proposal`. An unset id is reported skipped. It does
  not read the schedule; check that by hand (checklist step 6b);
- `peg_monitor::update_peg` on the AnchorCap and CapRegistry emits `PegUpdated`;
- `audit_anchor::anchor_audit_hash` on its own emits `AuditAnchored`;
- the v2 wallet path, in one transaction sent as the registered wallet of
  `SPLASH_VERIFY_BUSINESS_ACCOUNT_ID` with the operator paying gas: the
  wallet's USDC address balance redeemed, `payment_intent::create_for_wallet<USDC>`,
  `confirm_from_business_wallet_balance<USDC>`, `audit_anchor::anchor` on its
  receipt and `delete_finalized` emit `IntentCreated`, `IntentConfirmed` and
  `SettlementAnchored`, and no `TreasuryDeposited`. The confirm passes
  `FeeConfig` and the `Registry` with a `max_fee` of 1% of the payment, and
  the payment goes back to the wallet itself unless
  `SPLASH_TEST_RECIPIENT_ADDRESS` names another address. The wallet must hold
  at least 0.0101 USDC in its address balance (0.01 and that `max_fee`). A
  simulation checks no signatures, so no wallet signer is needed;
- the same `create_for_wallet` sent as the operator aborts with
  `business_account::E_NOT_THE_WALLET` (50): the operator key cannot open, or
  pay, a business's intent.

It exits 1 on any failure. If the peg or anchor calls abort with 210, the
AnchorCap was revoked: a break-glass execute moved its generation on, and the
cap to use is the one `execute_break_glass_anchor_cap` minted. A cap or registry
from another publish fails the id checks instead, as the wrong type. `splash_custody`
and `splash_meter` are not on the mainnet path and are not checked.

Without `SPLASH_VERIFY_BUSINESS_ACCOUNT_ID` the last two checks are reported as
skipped, not passed. Name a business account whose wallet is registered and
funded, for example one opened for the ceremony. The executed v2 payments on
testnet are proved by `experiments/v2-phase1/testnet-e2e.mjs`, which signs with
its own test keys. This script has no `--execute`: in v2 the operator cannot
pay on a business's behalf, which is what the old option did.

---

## 4 · Residual risks (state them honestly)

- **A stolen `AnchorCap` can forge attestations** until it is revoked: audit anchors,
  receipts, peg readings. It cannot move a coin. Since Phase 7 containment is on
  chain: arm and execute the anchor break-glass (§0), and every consumer rejects the
  stolen cap's generation (`assert_anchor_cap`). `destroy_anchor_cap` lets the
  *holder* burn a cap it no longer needs.
- **Peg forgery is the sharpest edge of that.** `update_peg` feeds `assert_pegged`, so a
  hot-key attacker can assert a healthy peg. They still cannot move funds, but they can
  remove one safety check on transactions someone else authorises. Consider whether the
  peg belongs behind its own oracle attestation rather than a plain hot cap.
- **Gas key** holds only SUI. The **fee recipient** is no longer a plain fee wallet:
  in v2 it is `FeeConfig`'s, the Splash finance multisig, which the chain proves no
  single member can sign for, changed only after 24 hours' notice. That notice
  alerts no owner yet (Phase 2).
- **Phase-0 honesty:** the operator key carries no customer funds today (settlement is
  demo-denominated). This is key *hygiene* now — but the object model you publish decides
  whether the Phase-1 custody posture is a config change or a rewrite.

---

## 5 · Batch payouts — why they cannot settle until this publish (S-11)

Batch settlement was investigated end-to-end on testnet. Four preconditions must
hold simultaneously; three now do, one is blocked on the contract:

| Precondition | Status |
|---|---|
| `BusinessAccount.is_verified` | ✅ true on `0x23fbe1…` |
| Fresh peg (bundled `update_peg`) | ✅ passes |
| **SettlementPool funded** | ✅ fixed — was **0**; `scripts/fund-settlement-pool.mjs` added, pool now holds 2.1 SUI |
| **DeepBook liquidity guard** | ❌ **unsatisfiable on the deployed contract** |

**Configuration discovered and applied** (`.env.local`):
`DEEPBOOK_POOL_ID=0x1c19362c…` (SUI/DBUSDC), `DEEPBOOK_QUOTE_TYPE=0xf7152c05…::DBUSDC::DBUSDC`.
Verified the pool's on-chain type is exactly the `0xfb28c4cb…::pool::Pool<SUI, DBUSDC>`
the contract expects.

**The blocker is a contract bug, now fixed in source (S-11):**

1. The guard required `remaining_base == 0` — a *perfect* fill. DeepBook books are
   lot-quantized (SUI/DBUSDC lot = 0.1) and the input-fee quote path deducts the
   taker fee from the input, so a sub-lot remainder is ALWAYS returned. Measured
   across 1.1 → 5.0 SUI, the remainder never fell below ~0.093. The assert
   therefore rejected **100% of batches at any size**.
2. Slippage was priced against the *requested* quantity instead of the *filled*
   quantity, charging the unfilled dust as if it executed at zero. On a healthy
   book this reported **809 bps** where the true cost was **56 bps**.

Both are fixed in `move/splash_custody/sources/liquidity_guard.move` (the guard
moved there from `peg_monitor.move`) and guarded by
`tests/deepbook-liquidity-guard.test.mjs`. `sui move test` could not run at the
time because the pinned DeepBook dependency's own test files failed to compile;
`STATUS.md` now records the pin moved to `daa5a951` and `splash_custody` tests
green.

**Also note:** the batch total must exceed the pool's `minSize` (1 SUI on
SUI/DBUSDC). Below it DeepBook fills nothing and returns a zero quote, which the
guard correctly rejects. The e2e batch was 0.009 SUI — 100× too small — and
became 1.3 SUI.

**Testnet risk parameters were widened deliberately.** `max_slippage_bps` was
raised 30 → 150 via `scripts/set-compliance-config.mjs`, because the testnet
book's spread is ~43 bps and a mainnet-grade 30 bps band captures zero bids.
**Mainnet must keep the tight value** — the script hard-refuses >50 bps on
mainnet.

**After this publish**, prove a batch settles for real. That needs
`splash_custody`, which v2 retires from the mainnet path for good (D11), so
this is a testnet proof only, and
`scripts/e2e-testnet.mjs` no longer runs a batch: since 2026-09-26 it checks the
core package only (§3.8). Its last batch flow (`testBatch` in
`git show 248137e:scripts/e2e-testnet.mjs`) is stale too: its `update_peg`
passes no `CapRegistry`, it calls `settlement` on the core package id, and it
calls `settle_sui_batch` with the `AdminCap`. Build the proof from the app's
batch path instead, `recordBatchSettlementOnSui` in
`lib/server/sui-settlement.ts`, which calls
`splash_custody::settlement::settle_sui_batch_delegated`. If a batch still
aborts 304, re-measure the book — testnet depth moves.

---

## 6 · Minimum settlement size ($100)

Enforced at four layers so no single bypass opens a sub-minimum payout:

| Layer | Where |
|---|---|
| UI | transfer step + batch authorization summary (blocks before a TOTP is spent) |
| API | `transfers/authorize`, `batches/authorize` → 400 `below_minimum` |
| Policy engine | `evaluatePolicy` → `BLOCK` — the choke point in-chat approval, the queue and submit-time re-evaluation all share |
| Contract | v2: `payment_intent::create_for_wallet` / `create_for_app` and every settle path → abort 434 `E_BELOW_SETTLEMENT_FLOOR` for a bank payout below max(99 USDC, `min_settlement_amount`). Per payout, not per batch total. The retired `splash_custody` path (`settlement::settle_payment`, `settle_batch`) aborts 107 `E_BELOW_MINIMUM` |

The floor applies to a single transfer and to a batch **TOTAL** (not per row — a
payroll run legitimately contains small rows). Internal transfers and treasury
moves are exempt: the floor exists because of corridor settlement fixed costs,
which internal movements do not incur.

Server default is `$100`, overridable with `MIN_SETTLEMENT_USD`. A malformed or
non-positive override falls back to $100 rather than disabling the rule.
On-chain it is `min_settlement_amount` in **minor units**, set at
`compliance_config::create` and changeable with
`scripts/set-compliance-config.mjs --min-settlement <minor units>` (that script
auto-detects whether the deployed contract has the field yet). On v2 it binds
bank payouts only. `ComplianceCap` can only raise it (`tighten`); lowering it
is `AdminCap` (`admin_set_parameters`). An intent opened before a raise no
longer settles if it is below the new floor.
