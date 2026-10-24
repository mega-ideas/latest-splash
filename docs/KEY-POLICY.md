# Splash Key Policy

Status: v2 (decisions D1, D2, D11), 24 Oct 2026. Design:
`docs/v2/phase1-move-design.md`.

## Roles

| Role | Purpose | Target custody |
| --- | --- | --- |
| Governance multisig | Holds `AdminCap` and the `DelayedUpgradeCap` wrapping `splash_core`'s `UpgradeCap`; proposes and activates upgrades and registry additions | Sui multisig, 2-of-3 (Sky, Sebastian, cold backup); proved on chain to be a quorum at every governance call |
| `ComplianceCap` holder | Subtractive only: pause, tighten, remove a registry entry, cancel an addition, switch the legacy path off | Sui multisig, 2-of-3 minimum, at a third address |
| `AnchorCap` holder | Audit-anchor and peg attestations; moves no money | KMS-backed operator signer |
| KMS operator | An EXECUTOR on businesses' spending rules: runs scheduled payments and batches only with the owners' approval naming it (an owner's `approve_payout`, or the wallet's `delegate_execution` of an intent the wallet opened), under its own tightly capped allowance | AWS KMS (WS4) |
| Business wallet | The business's own Sui multisig of its owners' passkeys (zkLogin as fallback). Pays, funds spending rules, changes its rules | The business. **Splash holds no key to it** (D1) |
| Development signer | Local and testnet smoke tests only | Raw key allowed only when `NODE_ENV !== 'production'` |

The governance signer set is Sky, Sebastian, and a cold-backup holder. The
cold-backup key must be hardware-backed, sealed, and tested quarterly with a
non-mutating multisig dry run.

## Production rules

1. No production service loads a raw operator key. The operator signs only
   through KMS (`lib/env.ts` refuses `OPERATOR_SUI_PRIVATE_KEY` at boot).
2. `AdminCap` and the `DelayedUpgradeCap` are never held by the service that
   submits transactions.
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
   `complete_owner_change`, after the same 24-hour notice. `AdminCap` (which
   has `store`) is transferred to the new address in the same ceremony.
7. The loss of one signer is tolerated by the 2-of-3. The loss of two signers
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

- The governance multisig, `ComplianceCap` rotation and the KMS operator key
  are provisioned in the mainnet ceremony, which is a human step (brief §9).
  Until then, testnet uses development signers.
