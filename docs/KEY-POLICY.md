# Splash Key Policy

Status: v2 (decisions D1, D2, D11), 24 Oct 2026; Amendment A1 (Splash's fee),
25 Oct 2026. Design: `docs/v2/phase1-move-design.md`; the fee:
`docs/v2/fees.md`.

## Roles

| Role | Purpose | Target custody |
| --- | --- | --- |
| Governance multisig | Holds `AdminCap` and the `DelayedUpgradeCap` wrapping `splash_core`'s `UpgradeCap`; proposes and activates upgrades and registry additions. Also holds `FeeAdminCap`: proposes, applies and withdraws fee schedule and fee recipient changes (24 hours' notice, then a seven-day window) and sets per-business discounts (immediate, at most 100 bps) | Sui multisig, 2-of-3 (Sky, Sebastian, cold backup); proved on chain to be a quorum where a call checks it (registry additions, `upgrade_delay::wrap`, owner changes). The `fee_config` calls check only the `FeeAdminCap`, not the sender, so whoever holds the cap can make them; that is why it must sit with the multisig |
| `OpsCap` holder (Splash ops) | Adds and removes payout partners' deposit addresses in Splash's address `Registry`, at once and with an event. It only classifies addresses: it cannot redirect funds or raise a fee, only make payments to an address it changed abort | The governance multisig, or a separate Splash ops multisig (`SPLASH_OPS_ADDRESS`). Never the KMS operator |
| Splash finance multisig | Receives every Splash fee leg as `FeeConfig`'s fee recipient. Holds no capability | Sui multisig that no single member can sign for (the chain refuses one, 1304); its members are checked at the ceremony |
| `ComplianceCap` holder | Subtractive only: pause, tighten, remove a registry entry, cancel an addition. (The legacy path it could once switch off is not in v2 core) | Sui multisig, 2-of-3 minimum, at a third address |
| `AnchorCap` holder | Audit-anchor and peg attestations; moves no money | KMS-backed operator signer |
| KMS operator | An EXECUTOR on businesses' spending rules: runs scheduled payments and batches only with the owners' approval naming it (an owner's `approve_payout`, or the wallet's `delegate_execution` of an intent the wallet opened; each names `max_total`, the principal plus the Splash fee shown), under its own tightly capped allowance. Holds neither `FeeAdminCap` nor `OpsCap`, and is never the fee recipient | AWS KMS (WS4) |
| Business wallet | The business's own Sui multisig of its owners' passkeys (zkLogin as fallback). Pays, funds spending rules, changes its rules | The business. **Splash holds no key to it** (D1) |
| Development signer | Local and testnet smoke tests only | Raw key allowed only when `NODE_ENV !== 'production'` |

The governance signer set is Sky, Sebastian, and a cold-backup holder. The
cold-backup key must be hardware-backed, sealed, and tested quarterly with a
non-mutating multisig dry run.

## Production rules

1. No production service loads a raw operator key. The operator signs only
   through KMS (`lib/env.ts` refuses `OPERATOR_SUI_PRIVATE_KEY` at boot).
2. `AdminCap`, the `DelayedUpgradeCap`, `FeeAdminCap` and `OpsCap` are never
   held by the service that submits transactions. The verify step
   (`scripts/e2e-testnet.mjs`) checks who holds `FeeAdminCap` and `OpsCap`
   and whom `FeeConfig` pays.
3. Emergency pause authority stays available even if the operator service is
   down.
4. **No governance or business multisig signs `0x2::address_alias`.** An alias
   would let one key send as the multisig, and Move cannot detect it. The
   wallet transaction builder refuses alias commands, and a watcher alerts if
   an `AddressAliases` object appears for a business wallet, the governance
   multisig or the operator (design §1).
5. Any key rotation is recorded in a ceremony note: old holder, new holder,
   object IDs, transaction digests, and the rollback decision.
6. Changing a governance signer gives the multisig a new address, so the
   `DelayedUpgradeCap` moves to it with `propose_owner_change` and then
   `complete_owner_change`, after the same 24-hour notice. `AdminCap`,
   `FeeAdminCap` and, if governance holds it, `OpsCap` (all with `store`) are
   transferred to the new address in the same ceremony.
7. Changing a finance multisig signer gives it a new address too. Governance
   proposes the new one with `fee_config::propose_fee_recipient` (its keys,
   weights and threshold) and applies it after 24 hours and within seven
   days. Until then fees keep going to the old address, so its signers must
   stay able to sign.
8. The loss of one signer is tolerated by the 2-of-3. The loss of two signers
   triggers an emergency governance review before anything is moved.

## Business wallets

A business wallet changes signers by rotation:

1. `rotate_wallet`, signed by the current wallet.
2. `confirm_wallet_rotation`, signed by the new wallet. This proves the new
   members can sign before anything depends on them.

The founder nominates the first wallet. Every member must be an owner of the
account. A wallet in which one member can sign alone must say so at
registration.

After registration, owners are added and removed by the wallet, which also
names the recovery party. To replace a signer, even under an owner freeze, the
wallet adds the person as an owner and then rotates them in. Once the new
wallet confirms, it lifts the freeze and removes the old owner in one
transaction. Any one owner can still freeze; only the wallet lifts an owner
freeze, and only `AdminCap` lifts a compliance one.

What recovery cannot do. A recovery only adds an owner. If the founder loses
their key before `nominate_wallet`, no wallet can ever be registered for that
account, because nomination is founder-only and the founder anchor never
moves; the business applies again (`submit_application`, then KYB). If a
wallet's quorum is lost, nobody can rotate it, and an owner freeze it does not
lift stays; the business opens a new account. Its funds stay in its own
wallet.

After a rotation the business must also:

- move the balance from the old address;
- revoke the old wallet's allowances;
- re-create its spending rules from the new wallet.

The old rules stop paying as soon as the rotation is confirmed.

## Current gap log

- The governance multisig, `ComplianceCap` rotation, the finance multisig, the
  `FeeAdminCap` and `OpsCap` transfers and the KMS operator key are
  provisioned in the mainnet ceremony, which is a human step (brief §9).
  Until then, testnet uses development signers.
- No owner is alerted to a fee schedule or fee recipient proposal yet: the
  governance alert cron does not read `FeeConfig` (Phase 2).
