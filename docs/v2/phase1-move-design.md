# v2 Phase 1: Move contract design

Spec: `SPLASH_SUI_V2_PROMPT.md` §3 and decisions D1–D16. Gate:
`docs/mainnet-checks-2026-10.md` (passed 24 Oct 2026). Toolchain: Sui CLI
`mainnet-v1.82.3`, framework rev `719fb2960ccfbf9f4d33041f8ea5146d30671696`,
pinned in every `Move.lock` with forward-slash paths.

This records the choices the brief leaves open, and why. Where the brief is
explicit, this follows it. Revision 2, 24 Oct 2026: four independent
reviewers (security, Sui platform, spec compliance, payment flows) attacked
revision 1. Every change they forced is marked **(R2)**.

Revision 3, the same day: seven test suites were written from this document
by authors who had not written the code (753 Move tests across the five
packages). They found two bugs:

- the upgrade events named the latest package, not the original;
- the legacy create ignored the pause.

They also found three gaps where the spec was silent. Each of those
changes is marked **(R3)**.

**v2 core is a fresh publish**, on testnet and on mainnet. It is not an
upgrade of testnet package `0xae1fb78a…`: the struct and event layouts change,
and no upgrade policy allows that. Every package ID and shared-object ID
changes, so the environment must be bootstrapped again. Every field core will
ever need must be in this publish; later additions can only be dynamic fields.

## The money paths

After Phase 1, exactly three paths move a business's funds to a third party
(review item A1).

| Path | Functions | Who authorises |
|---|---|---|
| The owners' multisig | `payment_intent::confirm_from_business_wallet`, `_balance`, `confirm_cross_chain_from_business_wallet` | the protocol: the business multisig signed the transaction |
| Spending rules | `splash_spend::pay_intent`, `pay_intent_cross_chain` | an app-bound allowance from the business wallet, plus `SpendPolicy` |
| Legacy approvals (deprecated) | `payment_intent::confirm_with_approval` | an approver in the account's legacy approver set |

**(R2) The unbound path is removed.** `create_payment_intent`, `create` and
`confirm_payment_intent` let any signer pay a recipient from their own coin. On
the current testnet flow that signer is Splash's operator, paying out of its
own address, which D3 rules out. An additive policy could never remove these
functions after publish, so they stay out of v2 core. The current app keeps
working against the package already on testnet until Phase 2 moves it to the
paths above.

**(R2) The legacy path can be closed.** `confirm_with_approval` now:
- takes `&ComplianceConfig`, so it honours the pause and the asset registry;
- refuses any account that has registered a business wallet, so migrating an
  account closes the path for it;
- refuses cross-chain intents;
- stops for good when the config's one-way `legacy_enabled` switch is turned
  off. `ComplianceCap` or `AdminCap` can turn it off, and nothing turns it back
  on.

Every account-bound settlement also checks that `ComplianceConfig` is not
paused, that the asset is accepted, and the account's KYB, freeze flags and
tier ceilings. The 99 USDC floor applies to bank payouts only (R2): the product
minimum for wallet transfers is 1 USDC (`docs/STABLECOIN-LANE.md`). A freeze
stops every Splash path, including staff allowances. It does not freeze the
business's own wallet, which only the business controls (D1). Copy and evidence
must never say otherwise.

## 1. Multisig derivation (`splash_core::multisig`)

- Input: `keys: vector<vector<u8>>`, each `flag || public key`, as
  `publicKey.toSuiBytes()` returns it; `weights: vector<u8>`; `threshold: u16`.
- Address: `blake2b256(0x03 || threshold u16 LE || for each member: key ||
  weight)`, which is `MultiSigPublicKey.toSuiAddress()`. Five SDK vectors are
  pinned in `tests/multisig_tests.move` and cross-checked by
  `tests/multisig-vectors.test.mjs`. They cover the Phase 0 passkey 2-of-3,
  mixed passkey + zkLogin + Ed25519, a 1-of-1, disguised single-signer weights
  `[2,1,1]`, and all five schemes.
- Validation is Sui's own: 1–10 members; as many weights as keys; no zero
  weight; threshold of at least 1 and no more than the sum of the weights; no
  duplicate key. The flag must be known and the length right for it: Ed25519
  33 bytes, Secp256k1, Secp256r1 and passkey 34. **zkLogin must be the padded
  form only:** `2 + iss_len + 32`. That is what the SDK puts in a multisig and
  what `lib/auth/zklogin.ts` derives (`legacyAddress: false`). A legacy,
  unpadded identifier would derive a different address.
- A member's own address is `blake2b256(key)`.
- **Single-signer means any one member's weight reaches the threshold.**
  Stricter than `threshold < 2`.
- **(R2) `assert_quorum_sender(keys, weights, threshold, ctx)`**: the sender is
  this multisig and it is not single-signer. Governance calls use it, so "never
  by a single key" is checked on chain rather than trusted to key custody.

**The address-alias caveat (Phase 0 finding 6).** `address_aliases` is on
mainnet. If a multisig's quorum signs `0x2::address_alias::enable` and `add`,
the aliased key can send as the multisig alone. Move cannot detect this,
because the alias state is private. So "sender == derived address" proves a
quorum only for a multisig that never aliased itself. Off chain (Phase 2): the
wallet PTB builder refuses every `0x2::address_alias` command, signer devices
show every command, and a watcher alerts if an `AddressAliases` object appears
for a business wallet, the governance multisig or the KMS operator. Staff
spenders are not policed on chain: an alias moves only what that spender's
allowance and the policy already allow.

## 2. The business wallet (`splash_core::business_account`)

Fields: `wallet`, `wallet_threshold`, `wallet_signers` (each member's own
address), `single_signer`, **`wallet_epoch` (R2)**, `nominated_wallet`
**`{ wallet, single_signer }` (R2)**, `pending_wallet`.

- **(R2) Only the founder nominates.** `nominate_wallet(account, wallet,
  single_signer, ctx)` is signed by `account.owner`, the founder. The founder
  is already the account's anchor: the only owner other owners cannot remove.
  The nomination fixes the address and whether the wallet is single-signer.
  This closes the attack in which one co-owner registers a 1-of-1 of their own
  first.
- `register_wallet(account, keys, weights, threshold, single_signer_ack, ctx)`
  has the brief's signature, plus these checks:
  - the sender equals the derived address and the nomination;
  - **(R2) every member's own address is in `account.owners`**, so the
    signers are the business's people (D1) and no Splash key can be slipped in;
  - the single-signer status matches the nomination, and a single-signer
    wallet passes `single_signer_ack = true` itself.

  The founder chose it, and the wallet acknowledged it.
- Rotation takes two steps. `rotate_wallet` is signed by the current wallet,
  with the same member rule (every new member is an owner).
  `confirm_wallet_rotation` is signed by the new wallet, which proves it can
  sign before anything depends on it. `cancel_wallet_rotation` is signed by the
  current wallet.
- **(R2) `wallet_epoch`** goes up on every registration and every confirmed
  rotation. Spending rules copy it and stop when it changes. A rotation from A
  to B and back to A gives the old address back, but not the old rules.
- **(R2) Once a wallet is registered, lifting an owner freeze needs the
  wallet.** Any single owner can still freeze, as the emergency brake. Only the
  quorum can release it.
- **(R3) Every wallet member stays an owner.** An owner who is a member of the
  wallet, or of a pending rotation, cannot be removed: rotate them out first.
  `confirm_wallet_rotation` checks the rule again. A founder who has left the
  owners can no longer nominate.
- No path lets the operator, `AdminCap` or an approver register or rotate a
  wallet.

## 3. Payment intents (`splash_core::payment_intent`)

- **Lifetime:** `now < expires_at <= now + 30 days`. Expired means
  `now >= expires_at`.
- **New fields:**
  - `kind`: 1 bank payout, 2 Splash business, 3 wallet, 4 cross-chain wallet.
  - `destination_domain`: 8 for Sui, any other value for kind 4.
  - `rail_commitment`: 32 bytes, tag `splash:rail:v1`.
  - **(R2) `payment_ref`.**
  - **(R2) `bridge_max_fee` and `bridge_min_finality`**, both zero unless
    kind 4.
- **(R2) Idempotency.** Every v2 create takes a 32-byte `payment_ref`, a
  commitment over the business's invoice or payment id. The intent's UID is
  `derived_object::claim(account UID, payment_ref)`. A second create with the
  same reference aborts, and so does any create after the first intent is
  deleted, because a claimed key stays claimed.
- **Create paths (R2: they return the intent by value).** One transaction can
  then create, settle, anchor and `share_intent` or `delete_finalized`, so the
  owners sign once per batch.
  - `create_for_wallet<T>` and `create_cross_chain_for_wallet<T>`: the sender
    is the account's wallet.
  - `create_for_app<T, W>` and `create_cross_chain_for_app<T, W>`: `W` is a
    registered settlement app, which vouches for `maker`.
  - `create_payment_intent_for_account<T>`: the legacy path, with the same
    closing rules as `confirm_with_approval`.
- **A bank payout carries `beneficiary_ref`:** a 32-byte stable beneficiary
  commitment, tag `splash:beneficiary:v1` (docs/commitments.md). On other
  kinds it is empty.
- **Settle paths (R2: every one takes `settle_by_ms` and asserts
  `now < settle_by_ms`).** The PTB builder sets it to the quote's expiry. A
  multisig transaction signed against a quote cannot then be submitted after
  the quote has lapsed (review items A8 and B5).
  - `confirm_from_business_wallet<T>(intent, account, config, Coin<T>, …)`:
    the sender is the account's wallet, whoever opened the intent.
  - `confirm_from_business_wallet_balance<T>(…, Balance<T>, …)`: takes the
    output of a funds-withdrawal input.
  - `settle_from_app<T, W>(…, Balance<T>, …)`: exact amount only.
  - Cross-chain variants of the wallet and app paths: see below.
- **Delivery (R2).** Kind 2 (another Splash business) is credited to the
  recipient's address balance with `send_funds`, because its own spending
  rules draw from there. Kinds 1 and 3 receive a `Coin` object, which every
  exchange and partner deposit system recognises. An overpayment refund goes to
  the wallet's address balance.
- **Cross-chain (kind 4).** The settle path returns `(SettleReceipt, Coin<T>,
  BridgeObligation)`. **(R2)** The obligation records the coin's ID, and
  `discharge_bridge_obligation<W, T>(witness, config, obligation, coin:
  &Coin<T>)` asserts that ID, the type and the value. A PTB can no longer keep
  the business's coin and burn another one. The obligation also carries
  `max_fee` and `min_finality_threshold` from the intent. `destination_caller`
  is always zero, so any relayer can complete the mint. The adapter must take
  all of these from the obligation.

  `mint_recipient` encoding: an EVM address is left-padded to 32 bytes; on
  Solana it is the USDC token account (ATA), never the wallet key. Phase 2
  validates this before it creates a kind-4 intent. `CONFIRMED` on a kind-4
  intent means "burned for CCTP". The mint completes off Sui, and Phase 2
  records it. No bridge adapter is registered in Phase 1, so kind 4 cannot
  settle yet.

  **Adapter rule:** a registered bridge adapter must be immutable. A new
  version from Circle means a new adapter type, added through the 24-hour path,
  and the old one removed. A witness type keeps its id across upgrades, so an
  upgradeable adapter could change behaviour with no notice. The governance
  checklist and the backend's pre-activation check enforce this. Move cannot.
- **Events (frozen at publish).**
  - `IntentCreated`, `IntentConfirmed` and `IntentCanceled` carry `intent_id`,
    `commitment`, `rail_commitment`, `settlement_asset`, `kind` and `status`.
  - `IntentCreated` adds `expires_at_ms`; `IntentConfirmed` adds `path`
    (1 wallet, 2 app, 3 legacy).
  - None carries an amount, an address or the account.
  - `settlement_asset` is a type name the brief requires. It is a deliberate
    exception to the WS5 "no currency" rule, made in its own commit to the
    privacy test.
- `cancel_by_wallet`: the wallet cancels any pending intent of its account.

## 4. Registries (`splash_core::compliance_config`)

- **(R2) Exactly one config.** `init` mints a `ConfigTicket` to the publisher.
  `create<T>` consumes it, so a second config can never exist. A PTB cannot
  pick a config that is unpaused or more lenient. `create<T>` seeds
  `accepted_assets` with `T` (native USDC). This happens once, at bootstrap.
- Three sets: `accepted_assets`, `settlement_apps` and `bridge_adapters`.
  Entries are `type_name::with_defining_ids` strings.
- **Additions:**
  - `propose_addition<X>` needs `&AdminCap` and **(R2)
    `assert_quorum_sender`**, a non-single-signer multisig sender.
  - The addition becomes eligible 24 hours after `eta`, and **(R2) lapses 7
    days after `eta`**. A stale proposal cannot be used after owners have
    stopped watching.
  - `activate_addition<X>` has the same two requirements and must fall inside
    that window.
  - Every step emits an event. The backend alerts every owner on
    `RegistryAdditionProposed` and `RegistryAdditionActivated`, filtered to the
    one canonical config.
- **Removals are immediate,** under either `&ComplianceCap` (subtractive) or
  `&AdminCap`. So is cancelling a pending addition. **(R2)** The last accepted
  asset cannot be removed; `pause` is the halt. Removing an app or an adapter
  stops only the staff or cross-chain path, while the owners' path keeps
  working. Re-adding one takes the full 24 hours.
- **(R2) `legacy_enabled`:** a one-way switch. Turning it off is subtractive.
- Assets are assumed to have 6 decimals: spending-rule limits and tier
  ceilings are minor units of USDC. D6 makes USDC the only payment asset, and
  the governance checklist refuses to add an asset with other decimals.

## 5. `splash_spend` (published immutable)

Modules: `splash_spend` (app type, permits, intents, approvals, paying) and
`spend_policy`.

- The app type `SPLASH_SPEND` is never packed.
  `internal::permit<SPLASH_SPEND>()` appears exactly twice: inside `accept`,
  passed straight through `settings_permit` to `issue`, and inside the private
  `draw`, passed through `spend_permit` to `app_balance_spend`. There is no
  `rotate_spender`. **(R2)** `scripts/check-spend-permits.mjs` also checks
  these rules:
  - the function that calls `app_balance_spend` is private;
  - no public function returns a `Balance` or a permit;
  - `Coin` is returned only alongside `BridgeObligation`;
  - `SettleWitness {}` appears only as a direct argument to core;
  - `SettleWitness` has exactly `drop`.
- **(R2) One policy per account and wallet epoch.** `init` shares a
  `PolicyRegistry`. Each policy's UID is
  `derived_object::claim(registry, (account_id, wallet_epoch))`, so a second
  policy for the same wallet generation is impossible. A spender cannot pick a
  looser policy, and rotating the wallet needs a new policy.
- **`SpendPolicy` (shared; every mutation asserts `sender == policy.wallet`)**
  holds the following, all copied in at creation or set by the wallet. None of
  it is read back from core's mutable state.
  - `account`, `wallet`, `wallet_epoch`, and **(R2) `asset`** (USDC; payments
    in any other type abort).
  - `owners`: the members' own addresses, derived at creation from keys that
    must derive the wallet.
  - **(R2) `spenders: Table<address, Spender { role, per_payment_max }>`**.
    The role is STAFF (creates and pays) or EXECUTOR (the KMS operator, which
    may only pay, and only with an approval naming it).
  - `recipients: Table<Destination, bool>`, where a destination is `{ domain,
    addr }`. This covers kinds 2–4.
  - **(R2) `beneficiaries: Table<commitment, Destination>`**. Each bank
    beneficiary is bound to the one partner deposit address allowed to receive
    payouts for it, so a verified beneficiary cannot be paired with any other
    verified address.
  - `per_payment_max` and `second_approval_threshold` (default 10,000 USDC).
- `accept<T>(proposal, policy, ctx)`: the funder is the wallet, the spender is
  on the policy, and `T` is the policy's asset.
  - **(R3)** The allowance's name must be the policy's `allowance_name`
    (`splash-policy:` plus the policy's id), and `pay_intent` checks it on
    every spend. `allowance::issue` returns nothing, so the name is how an
    allowance stays bound to the one policy that accepted it.
  - An allowance from an earlier wallet generation therefore never pays under a
    later policy, even after a rotation from A to B and back to A, and even
    when the later policy lists the same spender.
- **Creating intents.** `create_intent<T>` and `create_cross_chain_intent<T>`
  are for STAFF only. The destination, and the beneficiary binding for bank
  payouts, must be verified. The amount must be within both limits. **(R2)**
  The intent is returned by value, so the same transaction can pay it.
- **Approvals (R2).**
  - `approve_payout(policy, account, intent, payer, …)`: an owner who is
    neither the maker nor the payer approves; the payer is a spender. This is
    the second approval.
  - `delegate_execution(policy, account, intent, executor, …)`: the intent's
    maker (STAFF, or the wallet) lets an EXECUTOR run their own payment later.
    A delegation from the wallet counts as an owner approval.
  - Both mint a key-only `PayoutApproval` to the payer. It carries the
    account's `authority_epoch` and the intent's expiry, and dies if either
    moves.
- **`pay_intent<C>(allowance, withdrawal, intent, account, policy, config,
  approval: Option<PayoutApproval>, settle_by_ms, clock, ctx)`** checks, in
  order:
  1. The allowance's funder is `policy.wallet`. The policy is current: same
     account, same wallet, same `wallet_epoch`. `C` is the policy's asset.
  2. The intent is bound to the policy's account.
  3. The payer is a spender. **(R2) The maker is the wallet or a current
     STAFF spender**, so removing a staff member kills their open intents.
  4. The destination is verified:
     - kinds 2–3: `Destination { 8, recipient }` is in `recipients`. The key
       is built with 8 rather than read from the intent;
     - kind 1: `beneficiaries[beneficiary_ref] == Destination { 8, recipient }`;
     - kind 4: `Destination { domain, recipient }` with `domain != 8`.
  5. The amount is within the policy's maximum and the payer's.
  6. Approvals:
     - above `second_approval_threshold`, an owner approval is required;
     - **(R2) an EXECUTOR always needs an approval** (an owner approval, or the
       maker's delegation when the amount is not above the threshold);
     - any approval passed must match this policy, intent, amount, payer and
       `authority_epoch`, and be unexpired. It is consumed.
  7. `app_balance_spend`, then core's `settle_from_app`.
- **What a core upgrade can still do (R2, stated plainly).** Additive policy
  forbids changing existing functions. But an added core function could write
  an intent's private fields, for example its status or its recipient among
  addresses the policy allows. So a malicious core upgrade could make a spender
  pay a verified recipient twice, within caps. It cannot add a recipient,
  raise a limit, or create an allowance. That is why every proposed core
  upgrade alerts every owner 24 hours ahead, and the alert says so.

## 6. `splash_upgrade_delay` (published immutable; depends on `splash_core`)

- **(R2) `wrap(cap, keys, weights, threshold, ctx)`** is signed by the
  governance multisig itself, after the publisher transfers it the
  `UpgradeCap`. `assert_quorum_sender` proves the owner is a real multisig.
  `wrap` makes the policy additive if it is looser, and keeps the wrapper at the
  sender. **(R2)** It also requires that the cap's package is still at
  version 1, so it cannot take over a cap already used.
- `propose(digest)`, then `authorize_upgrade(digest)` once 24 hours have run
  and **(R2) before 7 days**. Then `commit_upgrade`.
- **(R2) Governance can rotate:** `propose_owner_change(new_owner keys,
  weights, threshold)`, a quorum multisig that is not single-signer, then
  `complete_owner_change` after the same notice and window. Both emit events.
- `only_dep_upgrades` and `make_immutable` can run at any time, because they
  only remove power. There is no unwrap.

## 7. Backend alert (3.5)

The backend watches these events:

| Event | Filtered to |
|---|---|
| `UpgradeProposed`, `UpgradeAuthorized`, `OwnerChangeProposed` | the canonical wrapper ID and core's original package ID |
| `RegistryAdditionProposed`, `RegistryAdditionActivated` | the canonical config ID |

Each one alerts every business owner: in-app, by email, and by WhatsApp where
configured. The alert links to their spending rules and allowances. Unfiltered
events would let anyone send owners a fake alert. For each proposal the
backend publishes the source commit and rebuilds it to match the digest.

## 8. Retiring custody and meter from the mainnet path

`splash_custody` and `splash_meter` keep their code and tests. Neither ever
published to mainnet: both were gated on an e-money licence. In v2 they are
retired from the mainnet path permanently. A production environment on
mainnet refuses to boot with `SPLASH_CUSTODY_PACKAGE_ID` or
`SPLASH_PAYOUT_DELEGATION_ID` set (`lib/env.ts`). Testnet keeps them.

**A decision for Sky, not taken here.** The stablecoin lane's audit-anchor fee
sends a fee to `SPLASH_FEE_ADDRESS_MAINNET` in the same transaction as a
payment. It is off by default, so today nothing is charged. Review item B1
rates any Splash-owned receiving address in a payout transaction as Critical.
The recommendation is to keep it off and invoice the SaaS fee off chain, with
partner fees inside the partner's quote. That is a revenue decision, so it
stays open and is listed in the PR.

## 9. Re-publishing `splash_spend` (Phase 0 finding 7)

A fix means a new package, and with it new `SPLASH_SPEND` and `SettleWitness`
types:

1. Register the new witness through the 24-hour path.
2. Each business revokes its old allowances and proposes new ones under the new
   app. The dashboard runs this.
3. Remove the old witness.

Core's app-facing functions can never change, so they are kept small and
heavily tested now.

## Abort code blocks

| Block | Module |
|---|---|
| 45–69 | `business_account` (wallet) |
| 357–379 | `compliance_config` (registries) |
| 421–449 | `payment_intent` (v2) |
| 1000–1049 | `splash_spend::splash_spend` |
| 1050–1099 | `splash_spend::spend_policy` |
| 1100–1149 | `splash_upgrade_delay::upgrade_delay` |
| 1200–1249 | `splash_core::multisig` |

## Known limits, accepted

- **Fixed windows.** Allowance rate limits are fixed windows, so a daily limit
  `X` can move `2X` across a window boundary. Keep staff allowances short and
  lifetime-capped.
- **Split payments.** The second-approval threshold is per payment, so the
  backend flags payments to the same beneficiary that together exceed it within
  24 hours.
- **Batches are atomic.** A batch PTB is all-or-nothing against the shared
  tier windows. Phase 2 sizes chunks and dry-runs a 50-row batch on testnet to
  check the protocol's per-transaction input limits.
- **Bank payouts.** On-chain checks prove that the USDC reached the
  beneficiary's bound partner address. The partner pays the bank account in
  the payout instruction, and Phase 2 recomputes the beneficiary commitment
  from that instruction and refuses to send it if they differ.
- **Partner deposit model.** Phase 0 check 6 is still open: whether a partner
  uses a fixed deposit address per business must be confirmed before mainnet.
  Per-payout addresses would need the wallet to verify each one.
