# Operator key — KMS setup and rotation runbook (WS4)

The operator is Splash's hot signer: it opens and confirms payment intents,
anchors audit hashes, pushes the peg, and records a business's verification.
Since WS4 it is an **AWS KMS key**. The private key is generated inside KMS
and never leaves it; the app holds a key id, reads the public key once, and
asks KMS for each signature (`lib/server/operator-signer.ts`, using
`@mysten/aws-kms-signer`).

This runbook covers three things: first-time setup (moving off the raw
`OPERATOR_SUI_PRIVATE_KEY`), routine rotation, and emergency rotation after a
suspected compromise.

> **Dependency on WS3.** The on-chain half of rotation —
> `settlement_policy::set_operator`, called from the cold multisig — arrives
> with WS3 (branch `ws3/service-orders`, Move module `settlement_policy`). It
> is **not on `main`** at the time this runbook is written. Until it lands,
> the operator address is not recorded in a settlement policy object, so
> section 3.3 is skipped and rotation is the off-chain steps plus the object
> hand-overs in section 3.4. Re-read this runbook when WS3 merges.

Canon D-0004 applies throughout: the operator key is never read into 0xWal's
process or any agent tool. Nothing in this runbook gives an agent a key, a
key id with sign permission, or AWS credentials.

---

## 1 · What the app enforces (already committed)

- `NODE_ENV=production` **refuses to boot** if `OPERATOR_SUI_PRIVATE_KEY` or
  `SUI_SPONSOR_PRIVATE_KEY` is set, whatever else is configured
  (`lib/env.ts`). The same refusal happens at runtime in
  `getOperatorSigner()`, and production never falls back to the Sui CLI
  keystore.
- Where settlement or verification signs, production requires
  `OPERATOR_KMS_KEY_ID`, `AWS_REGION`, `OPERATOR_SUI_ADDRESS` and
  `OPERATOR_HOT_BALANCE_CEILING_MICRO`.
- The KMS key's public key must derive `OPERATOR_SUI_ADDRESS`, or the signer
  is refused.
- Before every operator-funded payout, `assertOperatorCanPay`
  (`lib/server/operator-balance.ts`) reads the hot balance: below the payout it
  refuses with `operator_top_up_needed` and pays nothing; above the ceiling it
  alerts with the excess to sweep.
- `GET /api/cron/operator-outflows` (bearer `CRON_SECRET`) flags any outflow
  from the operator address that is not `payment_intent::confirm_with_approval`
  to an approved recipient.

## 2 · Prerequisites (people and hardware — not code)

| What | Who | Notes |
| --- | --- | --- |
| AWS account and a KMS key, spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY` | Sky | Secp256k1 is the Sui scheme KMS signs natively for this signer; `ECC_NIST_EDWARDS25519` also works with `@mysten/aws-kms-signer`. Key policy below. |
| An IAM role for the app host, or (Droplet) an IAM user | Sky | Role preferred. A Droplet cannot assume an EC2 role: use IAM Roles Anywhere, or `OPERATOR_KMS_CREDENTIALS=static` with a user scoped as below. |
| The cold 2-of-3 multisig | Sky, Sebastian, cold-backup holder | Holds `AdminCap` / `TreasuryCap` (`docs/KEY-CEREMONY-RUNBOOK.md` §3.1, §3.6), and with WS3 the settlement policy. |
| An alert receiver for `OPERATOR_ALERT_WEBHOOK_URL` | Ops | Ceiling, top-up and outflow alerts are POSTed here, and always logged. |
| A scheduler hitting `/api/cron/operator-outflows` every 15 minutes | Ops | The default look-back is two hours, so a missed run or two is still covered. |

**Key policy** — the app needs exactly two actions, on this one key:

```json
{
  "Sid": "SplashOperatorSignOnly",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<account>:role/<splash-app-role>" },
  "Action": ["kms:Sign", "kms:GetPublicKey"],
  "Resource": "*"
}
```

No `kms:Decrypt`, no `kms:ScheduleKeyDeletion`, no `kms:PutKeyPolicy` for the
app's principal. Administration (`kms:*` except `Sign`) belongs to a separate
admin principal that the app host cannot assume. Turn on CloudTrail for the
key: every signature is then an audit record independent of Splash's own logs.

## 3 · First-time setup, and routine rotation

The two are the same procedure; first-time setup's "old key" is the raw
`OPERATOR_SUI_PRIVATE_KEY`.

### 3.1 Create the new key and read its address
Create the key in the console or CLI (`aws kms create-key --key-spec
ECC_SECG_P256K1 --key-usage SIGN_VERIFY`), attach the policy above, and derive
its Sui address **on an operator's workstation, not the app host**:

```bash
# from a checkout with node_modules installed; credentials for an admin principal, not the app's
node --input-type=module -e "
  const { AwsKmsSigner } = await import('@mysten/aws-kms-signer');
  const s = await AwsKmsSigner.fromKeyId(process.env.KEY_ID, { region: process.env.AWS_REGION, accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN });
  console.log(s.toSuiAddress());"
```

This prints an address, not a secret. Record it in the ceremony note
(`docs/KEY-POLICY.md` rule 4: old holder, new holder, object ids, digests,
rollback decision).

### 3.2 Fund the new address — to the ceiling, not beyond
Send from the cold multisig only what the next settlement window needs, and
at most `OPERATOR_HOT_BALANCE_CEILING_MICRO` of USDC plus SUI for gas. The
hot wallet is exposure; the ceiling is the number the team agreed it is
willing to lose to a compromise.

### 3.3 Point the settlement policy at the new operator — **arrives with WS3**
From the cold multisig, call `settlement_policy::set_operator` on the policy
object named by `SPLASH_SETTLEMENT_POLICY_ID`, with the new address. Build the
transaction unsigned, have two of three signers sign it, and execute:

```bash
sui client call --package <core package> --module settlement_policy \
  --function set_operator --args <SPLASH_SETTLEMENT_POLICY_ID> <policy admin cap> <new operator address> \
  --serialize-unsigned-transaction
# then `sui keytool multi-sig-combine-partial-sig` with two signatures, and `sui client execute-signed-tx`
```

The argument list above is a placeholder until WS3's signature is final —
read `move/splash_core/sources/settlement_policy.move` on the merged tree
before running it. Record the digest.

**Update every `SPLASH_SETTLEMENT_POLICY_ID` consumer.** The policy object id
itself does not change on `set_operator`; what changes is who it trusts. Check
each consumer still names the same object and that nothing caches the old
operator: `git grep -n SPLASH_SETTLEMENT_POLICY_ID` on the merged tree (WS3's
`confirmServiceOrderOnSui`, `lib/env.ts`, `.env.example`, the Droplet's
`.env.local`, `data/contract-config.json` if present, and this runbook). If the
policy was re-created rather than updated, every one of them changes.

### 3.4 Hand over the operator-owned objects
The operator owns the `AnchorCap` (`docs/KEY-CEREMONY-RUNBOOK.md` §3.4) and, in
the custody phase, the payout delegation. Transfer each from the old operator
to the new address. For an `AnchorCap` you suspect is compromised, do **not**
transfer it: bump its generation through the `CapRegistry` from the cold
multisig, which kills the old cap and mints its replacement to the new
address in one transaction (Phase 7 break-glass).

With a raw old key, the transfer is signed on a workstation with the old key,
once, and the old key is then destroyed — never on the app host.

### 3.5 Switch the app
On the host (the Droplet's `.env.local`, see the key-ceremony runbook §3.7):

```
OPERATOR_KMS_KEY_ID=<key id or ARN>
AWS_REGION=<region>
OPERATOR_KMS_CREDENTIALS=role          # or static on a Droplet, with the scoped key pair
OPERATOR_SUI_ADDRESS=<new address from 3.1>
OPERATOR_HOT_BALANCE_CEILING_MICRO=<agreed ceiling, micro-USDC>
OPERATOR_ALERT_WEBHOOK_URL=<receiver>
OPERATOR_SUI_PRIVATE_KEY=              # DELETE the line, do not leave it blank-but-present in a backup
SUI_SPONSOR_PRIVATE_KEY=               # likewise
```

Update `operatorAddress` in `data/contract-config.json` if that file exists
(it overrides the environment). Then `NODE_ENV=production npm run doctor`:
it must pass, and it fails by name if a raw key is still present.

### 3.6 Verify with a dry run before the first real payout
1. Restart the app. The first settlement resolves the signer; a wrong key id,
   region, credential or address fails there with the reason.
2. Dry-run a settlement-shaped transaction against the new signer, without
   executing it. `suiClient.core.simulateTransaction` (or
   `sui client call … --dry-run` from a workstation with the KMS signer)
   should succeed and show the new address as sender. On the merged WS3 tree,
   dry-run a `confirm_with_approval` against the updated policy: it must pass
   for the new operator and abort for the old one.
3. Call `/api/cron/operator-outflows` once by hand. It should answer
   `success: true` with the new address as `operator`; the hand-over
   transfers from 3.4 were sent by the old address and do not appear.
4. Watch the first real settlement's alert stream: no `operator_top_up_needed`
   (funded in 3.2) and no `operator_above_ceiling`.

### 3.7 Retire the old key
- Raw key: delete it from every host, backup and password manager it was ever
  in. It is still a valid Sui key; anything left on the old address is
  swept to cold first (3.4).
- KMS key: disable it, then schedule deletion with the maximum waiting
  period (30 days). Disabling first means a mistake is reversible.

## 4 · Emergency rotation (suspected compromise)

An `operator_unapproved_outflow` alert, a CloudTrail `Sign` call nobody can
account for, or a host compromise.

1. **Stop signing now.** Disable the KMS key (`aws kms disable-key`). Every
   settlement fails closed from that moment; nothing partial is paid. This is
   the step a raw key never allowed — revoking it was impossible.
2. Sweep what is left on the operator address to cold. With the key disabled
   this needs it re-enabled for one transaction from a clean workstation, or
   is skipped if the balance is below the ceiling and the loss is accepted.
3. Kill the operator's capabilities on chain: generation bump through the
   `CapRegistry` from the cold multisig (`AnchorCap`, Phase 7), and with WS3,
   `settlement_policy::set_operator` to the replacement.
4. Then sections 3.1 – 3.6 with a fresh key and a fresh host.
5. Record the incident in the ceremony log: what fired, when the key was
   disabled, every digest from the window.

## 5 · What this does not cover

- The cold multisig itself — `docs/KEY-CEREMONY-RUNBOOK.md`.
- The CLI scripts under `scripts/` (`bootstrap-testnet.ts`, `e2e-testnet.mjs`,
  `fund-settlement-pool.mjs`, `set-compliance-config.mjs`) still read a raw
  `OPERATOR_SUI_PRIVATE_KEY`. They are testnet and workstation tools, never
  run on the production host, and production refuses to boot with that key.
