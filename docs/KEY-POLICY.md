# Splash Key Policy

Status: policy baseline for Phase A. Implementation is pending until the
multisig and KMS migration PR lands.

## Roles

| Role | Purpose | Target custody |
| --- | --- | --- |
| AdminCap / UpgradeCap owner | Governance, package upgrades, emergency configuration | Sui multisig, 2-of-3 minimum |
| ComplianceCap owner | Pause/unpause and compliance bounds | Sui multisig, 2-of-3 minimum |
| TreasuryOperatorCap owner | Day-to-day treasury movement within configured bounds | KMS-backed operator signer |
| AnchorCap owner | Audit-anchor creation for evidence batches | KMS-backed operator signer |
| Development signer | Local/testnet smoke tests only | Raw key allowed only when `NODE_ENV !== 'production'` |

The governance signer set is Sky, Sebastian, and a cold-backup holder. The
cold-backup key must be hardware-backed, sealed, and tested quarterly with a
non-mutating multisig dry run.

## Production Rules

1. No production service may load `OPERATOR_SUI_PRIVATE_KEY` directly once the
   KMS signer adapter is live.
2. AdminCap and UpgradeCap must not be held by the same hot service account that
   submits settlement transactions.
3. Emergency pause authority must remain available even if the operator service
   is down.
4. Any key rotation requires a recorded ceremony note with old holder, new
   holder, object IDs, transaction digests, and rollback decision.
5. Loss of one signer is tolerated by the 2-of-3 multisig. Loss of two signers
   triggers emergency governance review before any replacement cap is minted or
   transferred.

## Current Gap Log

- AdminCap is still modeled as a single capability in the current Move package.
- Operator settlement can still use a raw env key in development/testnet flows.
  Production refuses it at boot and at runtime since WS4 (rule 1 above is
  enforced by `lib/env.ts` and `lib/server/operator-signer.ts`); the KMS key
  and its IAM role are not yet provisioned. Setup and rotation:
  `docs/OPERATOR-KEY-ROTATION.md`.
- TreasuryOperatorCap and AnchorCap are not yet split from AdminCap on-chain.

These gaps block mainnet readiness and are tracked by the SPLASH v3 Phase A
milestones.
