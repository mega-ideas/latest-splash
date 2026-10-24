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

Revision 4, also 24 Oct 2026: an adversarial review of the code found
defects, and they are fixed on the branch. Every decision it changed is marked
**(R4, 24 Oct 2026 review)**, or **(R4)** for short. The earlier text is kept
where it records why a choice was first made, with the revision beside it.

Revision 5, 25 Oct 2026: **fees and Sky's 24 Oct decisions.** Amendment A1
(Sky, 24 Oct 2026) replaced every fee rule, and Sky's decisions of the same
day removed the legacy approval path, put a running total under the
second-approval threshold, fixed the partner deposit model, and turned
Splash's fees off until the first fee recipient is applied. Every decision
they changed is marked **(R5)**. The earlier text is kept where it records why
a choice was first made. The fee itself is specified in
[`docs/v2/fees.md`](fees.md); §4a below records the design choices.

**v2 core is a fresh publish**, on testnet and on mainnet. It is not an
upgrade of testnet package `0xae1fb78a…`: the struct and event layouts change,
and no upgrade policy allows that. Every package ID and shared-object ID
changes, so the environment must be bootstrapped again. Every field core will
ever need must be in this publish; later additions can only be dynamic fields.

## The money paths

After Phase 1, exactly three paths move a business's funds to a third party
(review item A1). **(R5)** Now exactly two. The third, legacy approvals
(`payment_intent::confirm_with_approval`, authorised by one approver in the
account's legacy approver set), is not in v2 core at all (decision 3, below).

| Path | Functions | Who authorises |
|---|---|---|
| The owners' multisig | `payment_intent::confirm_from_business_wallet`, `_balance`, `confirm_cross_chain_from_business_wallet` | the protocol: the business multisig signed the transaction |
| Spending rules | `splash_spend::pay_intent` (Sui kinds 1–3 only; **R4** removed `pay_intent_cross_chain`; **R5** wallet, exchange or bank-payout intents, and a Splash-business payment is derived, never declared) | an app-bound allowance from the business wallet, plus `SpendPolicy` |

**(R5)** Both paths charge Splash's fee as its own leg, computed on chain from
the derived kind and the principal and bounded by the payer's `max_fee`
(§4a). Every remainder goes to the business wallet, never to the sender.

**(R2) The unbound path is removed.** `create_payment_intent`, `create` and
`confirm_payment_intent` let any signer pay a recipient from their own coin. On
the current testnet flow that signer is Splash's operator, paying out of its
own address, which D3 rules out. An additive policy could never remove these
functions after publish, so they stay out of v2 core. The current app keeps
working against the package already on testnet until Phase 2 moves it to the
paths above.

**(R2) The legacy path can be closed.** **(R5) Superseded by decision 3: the
legacy path is not published to mainnet at all.** A public function, however
firmly closed, can never be removed once published, so
`create_payment_intent_for_account`, `approve_payout` and
`confirm_with_approval` are gone from `payment_intent`, together with the
approver set, `legacy_enabled`, `LegacyDisabled` and their abort codes
(`payment_intent` 418 and 431, `compliance_config` 369, `business_account`
21, 29–33, 41 and 60; retired, not reused). `tests/legacy-path-removed.test.mjs`
holds it. The R2 design, kept for the record: `confirm_with_approval`
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
minimum for wallet transfers is 1 USDC (`docs/STABLECOIN-LANE.md`).
**(R4)** A bank payout's floor is the larger of 99 USDC and
`ComplianceConfig.min_settlement_amount`. It is checked when the intent opens
and again when it settles (abort 434, `E_BELOW_SETTLEMENT_FLOOR`), so a floor
compliance raises in between stops an intent opened before the raise. A bank
payout above the tier's per-transfer ceiling is refused when it opens (42).
Wallet, Splash-business and cross-chain payments have no floor; the legacy
path keeps a fixed 99 USDC floor (**R5**: there is no legacy path). A freeze
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
  **(R4)** What the chain proves is narrower: the sender holds `AdminCap` and
  is a multisig that no single member's weight can sign for. It does not prove
  that the multisig is the recorded governance multisig. `AdminCap` has
  `store` and is minted to the publisher, a single key, which could move it to
  a 2-of-2 of two keys it holds; the chain cannot tell that from the 2-of-3.
  So "never by a single key" for the settlement witness means "by the
  `AdminCap` holder, behind a multisig that is not single-signer", plus the
  24-hour notice. The mainnet checklist therefore checks the registries before
  the first business onboards (`docs/MAINNET-CHECKLIST.md`).

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
  **(R4)** That holds until a wallet registers. Once it has, the wallet (the
  owners' quorum) adds and removes owners, the founder included once the
  founder is not a current or pending signer.
  The nomination fixes the address and whether the wallet is single-signer.
  This closes the attack in which one co-owner registers a 1-of-1 of their own
  first.
- **(R4) Losing the founder key before nomination.** Nomination is
  founder-only, and the founder anchor (`account.owner`) never moves. A
  recovery only adds an owner. So if the founder loses their key before
  `nominate_wallet`, no wallet can ever register for that account; the
  business applies again (`submit_application`, then KYB). If a wallet's
  quorum is lost, nobody can rotate it, and an owner freeze it does not lift
  stays; the business opens a new account. Its funds stay in its own wallet.
- `register_wallet(account, keys, weights, threshold, single_signer_ack, ctx)`
  has the brief's signature, plus these checks. **(R5)** It is now
  `register_wallet(account, registry, keys, weights, threshold,
  single_signer_ack, ctx)`; see the registry note below.
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
- **(R5) The business-wallet registry.** `address_registry::Registry` holds
  the wallet of every account inside the network: it has a wallet, is
  KYB-verified and is not compliance-frozen (an owner freeze does not remove
  it). A payment to one is a free Splash-business payment (§4a).
  `register_wallet` and `confirm_wallet_rotation` (which clears the old
  wallet) take `&mut Registry`, and so do `verify_business`,
  `revoke_verification`, `admin_freeze` and `admin_unfreeze`, which enter or
  clear an existing wallet. Registering before KYB enters nothing;
  `verify_business` enters the wallet then.
- **(R2) `wallet_epoch`** goes up on every registration and every confirmed
  rotation. Spending rules copy it and stop when it changes. A rotation from A
  to B and back to A gives the old address back, but not the old rules.
- **(R2) Once a wallet is registered, lifting an owner freeze needs the
  wallet.** Any single owner can still freeze, as the emergency brake. Only the
  quorum can release it.
- **(R4) The wallet also governs membership.** Once a wallet is registered,
  `add_owner`, `remove_owner` and `set_recovery_party` are wallet-only (50).
  The wallet may call them under an owner freeze and not under a compliance
  freeze (22). So one wallet transaction can lift a freeze and remove the
  owner who pulled it, or add a replacement owner to rotate in. `add_approver`
  and `remove_approver` abort 60 (`E_APPROVERS_CLOSED`) once a wallet exists,
  whoever sends (**R5**: both functions are gone with the approver set, and
  60 is retired). The only `authority_epoch` change one owner can make alone is
  `freeze_account`.
- **(R3) Every wallet member stays an owner.** An owner who is a member of the
  wallet, or of a pending rotation, cannot be removed: rotate them out first.
  `confirm_wallet_rotation` checks the rule again. A founder who has left the
  owners can no longer nominate. **(R4)** Once a signer has been rotated out,
  the wallet removes them as an owner, the founder included.
- No path lets the operator, `AdminCap` or an approver register or rotate a
  wallet. (**R5**: there are no approvers.)

## 3. Payment intents (`splash_core::payment_intent`)

- **Lifetime:** `now < expires_at <= now + 30 days`. Expired means
  `now >= expires_at`.
- **New fields:**
  - `kind`: 1 bank payout, 2 Splash business, 3 wallet, 4 cross-chain wallet.
    **(R5)** Renumbered by A1, with one kind added: 0 Splash business, 1
    wallet, 2 exchange, 3 cross-chain, 4 bank payout, defined once in
    `fee_config`, whose schedule is indexed by them. The intent's `kind` is
    what it declares; the kind it is charged and delivered as is derived at
    settlement (§4a). Below, kind numbers marked R5 are the new ones.
  - `destination_domain`: 8 for Sui, any other value for kind 4 (**R5**: kind
    3, cross-chain).
  - `rail_commitment`: 32 bytes, tag `splash:rail:v1`.
  - **(R2) `payment_ref`.**
  - **(R2) `bridge_max_fee` and `bridge_min_finality`**, both zero unless
    kind 4 (**R5**: kind 3).
  - **(R5)** No fee field. An intent carries no fee rate or fee amount, and no
    create takes one: the fee is computed at settlement.
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
  - `create_for_app<T, W>`: `W` is a registered settlement app, which vouches
    for `maker`. Sui kinds 1–3 only (**R5**: every kind but cross-chain, so
    0, 1, 2 and 4, as for `create_for_wallet`). **(R4)** `create_cross_chain_for_app` is
    removed: a cross-chain intent is opened by `create_cross_chain_for_wallet`
    alone.
  - **(R4)** On every v2 create, a bank payout (kind 1; **R5**: kind 4) must
    reach its floor (434) and fit the tier's per-transfer ceiling (42).
  - `create_payment_intent_for_account<T>`: the legacy path, with the same
    closing rules as `confirm_with_approval`. **(R5)** Removed (decision 3).
- **A bank payout carries `beneficiary_ref`:** a 32-byte stable beneficiary
  commitment, tag `splash:beneficiary:v1` (docs/commitments.md). On other
  kinds it is empty.
- **Settle paths (R2: every one takes `settle_by_ms` and asserts
  `now < settle_by_ms`).** The PTB builder sets it to the quote's expiry. A
  multisig transaction signed against a quote cannot then be submitted after
  the quote has lapsed (review items A8 and B5).
  - `confirm_from_business_wallet<T>(intent, account, config, Coin<T>, …)`:
    the sender is the account's wallet, whoever opened the intent. **(R5)**
    Now `confirm_from_business_wallet<T>(intent, account, config, fee_cfg,
    registry, payment: Coin<T>, max_fee, settle_by_ms, clock, ctx)`. The
    payment must cover the principal and the fee (402).
  - `confirm_from_business_wallet_balance<T>(…, Balance<T>, …)`: takes the
    output of a funds-withdrawal input. **(R5)** The same arguments, with a
    `Balance<T>`.
  - `settle_from_app<T, W>(…, Balance<T>, …)`: exact amount only. Sui kinds
    only. **(R5)** Now `settle_from_app<T, W>(witness, intent, account,
    config, fee_cfg, registry, declared_kind, funds: Balance<T>, max_fee,
    settle_by_ms, clock, ctx): (SettleReceipt, u8, u64)`. The funds must be
    exactly the principal plus `max_fee` (427). `declared_kind` is the app's
    tag for the recipient, and both it and the intent's own kind must fit the
    derived kind. It returns the derived kind and the fee charged, so
    `splash_spend` can check the fee against its own ceiling.
  - **(R5)** Each path derives the kind (`address_registry::derive_kind`,
    then `assert_kind_fits`, 1400), computes the fee
    (`fee_config::splash_fee`), refuses it above `max_fee` (435), and splits
    it inside Move to `FeeConfig`'s fee recipient (`fee_config::take_fee`).
    A fee of 0 sends nothing. The cross-chain form takes the same `fee_cfg`,
    `registry` and `max_fee`.
  - The cross-chain variant of the wallet path,
    `confirm_cross_chain_from_business_wallet`: see below. **(R4)** There is no
    cross-chain app path any more (`settle_cross_chain_from_app` is removed).
  - **(R4)** Every settle path checks the bank-payout floor again (434).
- **Delivery (R2).** Kind 2 (another Splash business) is credited to the
  recipient's address balance with `send_funds`, because its own spending
  rules draw from there. Kinds 1 and 3 receive a `Coin` object, which every
  exchange and partner deposit system recognises. An overpayment refund goes to
  the wallet's address balance. **(R5)** Delivery follows the DERIVED kind: a
  registered business wallet (kind 0) is credited to its address balance; a
  wallet, an exchange or a partner deposit address (kinds 1, 2 and 4)
  receives a `Coin`. Every remainder, an overpayment or the unused part of
  `max_fee`, goes to `business_account::wallet(account)`'s address balance,
  never to the transaction's sender. That changes the original H-03 fix,
  which refunded the caller.
- **Cross-chain (kind 4; R5: kind 3).** The settle path returns `(SettleReceipt, Coin<T>,
  BridgeObligation)`. **(R4)** This is the owners' wallet path only: a
  cross-chain settlement hands the business's coin to the transaction for a
  bridge to burn, and only the owners' own transaction may hold it. No
  spending rule can open, approve, delegate or pay a kind-4 intent
  (`splash_spend::E_WRONG_PAY_PATH`, 1022). **(R2)** The obligation records the coin's ID, and
  `discharge_bridge_obligation<W, T>(witness, config, obligation, coin:
  &Coin<T>)` asserts that ID, the type and the value. A PTB can no longer keep
  the business's coin and burn another one. The obligation also carries
  `max_fee` and `min_finality_threshold` from the intent. `destination_caller`
  is always zero, so any relayer can complete the mint. The adapter must take
  all of these from the obligation. **(R5)** Splash's fee, the cross-chain
  kind's, is taken in USDC on Sui before the burn, and the coin handed to the
  bridge is exactly the principal. Circle's fee is `bridge_max_fee`, shown
  separately.

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
    (1 wallet, 2 app, 3 legacy). **(R5)** Path 3 is gone with the legacy
    path.
  - **(R5)** The fee leg emits `fee_config::FeeCharged { intent_id, business,
    derived_kind, fee, fee_recipient }`, only when a fee is paid. Why it may
    carry the fee is in `docs/commitments.md`.
  - None carries an amount, an address or the account.
  - `settlement_asset` is a type name the brief requires. It is a deliberate
    exception to the WS5 "no currency" rule, made in its own commit to the
    privacy test.
- `cancel_by_wallet`: the wallet cancels any pending intent of its account.
  **(R4)** `cancel` (the maker, on an intent it still holds) takes `&Clock`
  and stamps the event with the clock, like every other lifecycle event.

## 4. Registries (`splash_core::compliance_config`)

- **(R2) Exactly one config.** `init` mints a `ConfigTicket` to the publisher.
  `create<T>` consumes it, so a second config can never exist. A PTB cannot
  pick a config that is unpaused or more lenient. `create<T>` seeds
  `accepted_assets` with `T` (native USDC). This happens once, at bootstrap.
  **(R4)** Each `SpendPolicy` also records the ID of the config it was created
  against, and `splash_spend` opens and pays only against that one
  (`E_WRONG_CONFIG`, 1028). Spending rules keep the guarantee even if a core
  upgrade added a second constructor. The cost: a policy is bound for life to
  its config, so replacing the config would mean every business rotating its
  wallet to make a new policy.
- Three sets: `accepted_assets`, `settlement_apps` and `bridge_adapters`.
  Entries are `type_name::with_defining_ids` strings.
- **Additions:**
  - `propose_addition<X>` needs `&AdminCap` and **(R2)
    `assert_quorum_sender`**, a non-single-signer multisig sender.
  - The addition becomes eligible at `eta`, which is 24 hours after the
    proposal, and **(R2) lapses 7 days after `eta`**. A stale proposal cannot
    be used after owners have stopped watching.
  - `activate_addition<X>` has the same two requirements and must fall inside
    that window.
  - Every step emits an event. **(R4)** The backend alerts every owner while
    the addition is in the canonical config's `pending_additions`, and again
    when the entry appears in its registry. It reads the config's state, not
    the events (§7).
- **Removals are immediate,** under either `&ComplianceCap` (subtractive) or
  `&AdminCap`. So is cancelling a pending addition. **(R2)** The last accepted
  asset cannot be removed; `pause` is the halt. Removing an app or an adapter
  stops only the staff or cross-chain path, while the owners' path keeps
  working. Re-adding one takes the full 24 hours.
- **(R2) `legacy_enabled`:** a one-way switch. Turning it off is subtractive.
  **(R4)** Turning it off emits `LegacyDisabled`, once; a repeated call
  changes nothing. **(R5)** Removed with the legacy path (369 is retired).
- **(R5) No fee lives here.** Splash's fee is in its own module, `fee_config`
  (§4a), so `ComplianceCap`'s subtractive-only guard (`check:compliance`)
  stays true. A draft of the fee decisions before A1 put the fee and its
  24-hour change in `compliance_config`; A1 moved it out.
- Assets are assumed to have 6 decimals: spending-rule limits and tier
  ceilings are minor units of USDC. D6 makes USDC the only payment asset, and
  the governance checklist refuses to add an asset with other decimals.
  **(R4)** Nothing on chain enforces this: `activate_addition` does not read
  the asset's decimals. The check is a step in the governance checklist
  (`docs/MAINNET-CHECKLIST.md`), before any asset addition is proposed.

## 4a. Splash's fee and the address registry (R5)

Specified in [`docs/v2/fees.md`](fees.md). The design choices, and what each
replaced:

- **(R5) No intent carries a fee** (A1 §1). The decision A1 replaced had each
  intent state a fee rate, bounded by a configured maximum under a 2%
  ceiling. Two reviews showed why that failed: the rate was a PTB argument,
  so a payer could open at 0 and skip the fee, and whoever built a staff PTB
  could pick any rate up to the maximum with no owner seeing it. A1 removes
  every fee parameter from intent creation. Mainnet is a fresh publish, so
  the signatures changed now; a public function can never be removed later.
- **(R5) The fee is computed on chain**, by `fee_config::splash_fee`, from the
  derived kind and the principal, in A1 §2.4's exact order with floor
  rounding. The ceiling is 100 bps, written into both packages.
- **(R5) The kind is derived.** `address_registry::derive_kind` makes a
  registered business wallet a Splash business (free) and a partner deposit
  address a bank payout, whatever was declared. **Sky, 24 Oct:** every settle
  path then refuses a derived kind that does not fit the declared one
  (`assert_kind_fits`, 1400), except a declared wallet or exchange payment to
  a business wallet, which is free. Under A1 as written, a partner address
  declared a wallet was charged as a bank payout; it is now refused, so it
  can never skip the bank floor and the beneficiary. A1's vector row for
  that case pins only what `derive_kind` and `splash_fee` give.
- **(R5) The registries only classify.** One `Registry`, shared at publish,
  holds business wallets, written only by `business_account` (§2), and
  partner deposit addresses, written by the holder of `OpsCap` (minted at
  publish, with `store`), with immediate, evented changes. A stolen `OpsCap`
  can make payments abort; it can never redirect them, or make one pay more
  than its `max_fee`. A1 had accepted an overcharge bounded by `max_fee`;
  with the kind-fit rule it is only a denial of service.
- **(R5) One shared `FeeConfig`**, created at publish with the launch schedule
  and **no fee recipient** (Sky, 24 Oct; A1 had a recipient address). While
  it has none, `splash_fee` is 0, and nothing is ever paid to the publisher.
  Fees turn on when the first fee recipient change is applied.
- **(R5) The fee recipient is proven a multisig** (Sky, 24 Oct, stricter than
  A1's "not `@0x0`"). `propose_fee_recipient` takes the members' keys,
  weights and threshold and derives the address on chain, refusing one any
  single member can sign for (1304). One key under two schemes counts as one
  member (`multisig` 1205, from the A1 review).
- **(R5) 24 hours' notice, then seven days.** A schedule or recipient change
  is proposed, waits `FEE_NOTICE_MS` (24 hours; 1302 before) and must be
  applied within `FEE_APPLY_WINDOW_MS` (seven days; 1306 after), as registry
  additions and upgrades must. A lapsed proposal is made again, so owners are
  alerted again (the A1 review). A pending proposal can be withdrawn
  (`cancel_schedule_proposal`, `cancel_fee_recipient_proposal`), which changes
  nothing in force. The one immediate change is `set_discount`, at most
  100 bps, which only lowers what a business pays. `FeeAdminCap` (minted at
  publish, with `store`) goes to the governance multisig.
- **(R5) No version gate.** `splash_spend` is immutable and runs its core
  version's `splash_fee` for ever: the algorithm is frozen at first publish,
  and only the schedule data changes later.
- **(R5) The payer bounds the fee.** Every money path takes `max_fee`, the fee
  the UI showed, and aborts above it (435; `splash_spend` 1031). A1 §1 also
  settled "any fee difference goes back to the business wallet": no fee is
  negotiated, so there is none. The only remainders, an overpayment and the
  unused part of `max_fee`, go to the business wallet.
- **(R5) No penalty or late fees** (Sky, 24 Oct). Splash is not a party to
  the supplier's invoice, so none exists, on chain or off. A refused payment
  pays nothing, and a quote re-issued after a failed payment is a fresh quote
  at the schedule in force. A rate hold holds only the FX rate, never a fee.
- **Abort codes.** `fee_config` 1300–1306; `address_registry` 1400–1403;
  `payment_intent` 435 (`E_FEE_ABOVE_MAX`) and 427, which now means exactly
  the principal plus `max_fee`. The pre-A1 draft's codes 370–376 and 436, and
  its `fee_bps`, `fee_minor` and `fee_charged_minor` fields, do not exist.

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
  - `Coin` is returned only alongside `BridgeObligation`. **(R4)** Stricter
    now: no `splash_spend` function returns a `Coin` or a `BridgeObligation`
    at all, and `tests/spend-rules-sui-only.test.mjs` enforces it;
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
  - **(R4) Growing needs the account.** Growth (`add_spender`,
    `verify_recipient`, `verify_beneficiary`, raising either limit in
    `set_limits`, **(R5)** shortening the running window with
    `set_running_window`, and `splash_spend::accept`) also needs the policy to be the
    account's current one (1064) and the account not frozen, by an owner or by
    compliance (1065). Removals and lowering the limits stay open in every
    state, so the owners can always cut back. Each mutator that can grow takes
    the `BusinessAccount`.
  - `account`, `wallet`, `wallet_epoch`, and **(R2) `asset`** (USDC; payments
    in any other type abort).
  - **(R4) `config`**: the ID of the `ComplianceConfig` passed to
    `create_policy`, which now takes the config. **(R5)** Also `fee_config`
    and `address_registry`, the IDs of Splash's `FeeConfig` and `Registry`:
    `create_policy<T>(registry, account, config, fee_cfg, addresses, keys,
    weights, threshold, per_payment_max, ctx)`. `pay_intent` accepts no other
    (1035, 1036), so a second `FeeConfig` cannot waive or redirect a rule
    payment's fee, and a second `Registry` cannot reclassify its recipient.
  - `owners`: the members' own addresses, derived at creation from keys that
    must derive the wallet.
  - **(R2) `spenders: Table<address, Spender { role, per_payment_max }>`**.
    The role is STAFF (creates and pays) or EXECUTOR (the KMS operator, which
    may only pay, and only with an approval naming it). **(R4)** That approval
    is always the owners': an owner's `approve_payout` naming it, or the
    wallet's own `delegate_execution`.
  - `recipients: Table<Destination, bool>`, where a destination is `{ domain,
    addr }`. This covers kinds 2–4. **(R4)** Now `Table<Destination, u8>`: the
    value is the kind (2 or 3) the owners chose, which fixes how core delivers
    it (address balance or `Coin`). Domain 8 only (1061); kinds 2–3 only.
    **(R5)** The value is now the tag, 1 (wallet) or 2 (exchange), which is
    the kind a payment to it declares (1062 for any other). Core derives the
    kind it charges and how it delivers: a registered business wallet is a
    Splash business, credited to its address balance, whatever its tag;
    anything else gets a `Coin`. A partner deposit address is never a
    recipient (1067).
  - **(R4) `generation`**: moved by every removal (a spender, a recipient, a
    beneficiary). An approval records it and dies when it moves, so adding
    back what was removed never revives an approval.
  - **(R2) `beneficiaries: Table<commitment, Destination>`**. Each bank
    beneficiary is bound to the one partner deposit address allowed to receive
    payouts for it, so a verified beneficiary cannot be paired with any other
    verified address. **(R5)** Binding a beneficiary makes its address a
    partner deposit address (`partner_deposits`, with the number of
    beneficiaries bound to it), paid only as a bank payout for one of them.
    An address already verified as a recipient is refused (1068), so the two
    lists never overlap. Removing the last beneficiary bound to an address
    clears it.
  - `per_payment_max` and `second_approval_threshold` (default 10,000 USDC).
    **(R5)** The threshold is compared with the payment plus what its payer
    has already paid that recipient (see "Running totals" below).
  - **(R5) `running_window_ms`** (default 24 hours; an hour to thirty days,
    else 1066) and **`running_totals`**.
- `accept<T>(proposal, policy, ctx)`: the funder is the wallet, the spender is
  on the policy, and `T` is the policy's asset. **(R4)** Now
  `accept<T>(proposal, policy, account, ctx)`: the policy must also be current
  and the account not frozen.
  - **(R3)** The allowance's name must be the policy's `allowance_name`
    (`splash-policy:` plus the policy's id), and `pay_intent` checks it on
    every spend. `allowance::issue` returns nothing, so the name is how an
    allowance stays bound to the one policy that accepted it.
  - An allowance from an earlier wallet generation therefore never pays under a
    later policy, even after a rotation from A to B and back to A, and even
    when the later policy lists the same spender.
- **Creating intents.** `create_intent<T>` and `create_cross_chain_intent<T>`
  are for STAFF only. **(R4)** `create_cross_chain_intent` is removed:
  `create_intent<T>` is for STAFF only, and opens Sui kinds 1–3. The config
  must be the policy's (1028). The destination, and the beneficiary binding
  for bank payouts, must be verified, and **(R4)** a recipient's kind must
  equal the kind it was verified as (1025). The amount must be within both
  limits. **(R2)** The intent is returned by value, so the same transaction
  can pay it. **(R5)** It opens a wallet (1), exchange (2) or bank payout (4)
  intent. A recipient's declared kind must equal its tag (1025, "tagged as"
  rather than "verified as"), so staff cannot declare a Splash business (0).
  A wallet or exchange intent to one of the policy's partner deposit
  addresses is refused (1029). It takes no fee argument.
- **Approvals (R2).**
  - `approve_payout(policy, account, intent, payer, …)`: an owner who is
    neither the maker nor the payer approves; the payer is a spender. This is
    the second approval. **(R4)** Now `approve_payout(policy, account, intent,
    payer, settle_by_ms, clock, ctx)`. **(R5)** Now `approve_payout(policy,
    account, intent, payer, max_total, settle_by_ms, clock, ctx)`, and
    `delegate_execution(policy, account, intent, executor, max_total,
    settle_by_ms, clock, ctx)`.
  - `delegate_execution(policy, account, intent, executor, …)`: the intent's
    maker (STAFF, or the wallet) lets an EXECUTOR run their own payment later.
    A delegation from the wallet counts as an owner approval. **(R4)** Staff
    can no longer delegate: the operator pays from its own allowance, so a
    staff delegation would let that person spend past their own rule's caps,
    expiry and revocation. Only the wallet delegates (1024), and only an
    intent the wallet opened (1019). It counts as the owners' approval at any
    amount. For a staff member's intent, the operator needs an owner's
    `approve_payout` naming it as the payer.
  - Both mint a key-only `PayoutApproval` to the payer. It carries the
    account's `authority_epoch` and the intent's expiry, and dies if either
    moves. **(R4)** It now carries the account's `authority_epoch`, the
    policy's `generation` and a `settle_by_ms` the approver chooses: the
    deadline of the quote (or scheduled window) they approved, with
    `now < settle_by_ms <= the intent's expiry` (1026). It dies if the
    authority epoch or the generation moves, or once `settle_by_ms` passes.
    **(R5)** It also carries `amount` and `max_total`, the principal plus the
    Splash fee the approver was shown. A `max_total` below the principal is
    refused (1034), and paying aborts when principal plus fee is above it
    (1033), for example after the schedule rose; the owners approve again.
  - **(R4)** No approval is minted for a kind-4 intent (1022; **R5**: a
    cross-chain intent, kind 3).
    `discard_approval` emits `SpendApprovalDiscarded`.
- **`pay_intent<C>(allowance, withdrawal, intent, account, policy, config,
  approval: Option<PayoutApproval>, settle_by_ms, clock, ctx)`** checks, in
  order (**R5**: now `pay_intent<C>(allowance, withdrawal, intent, account,
  policy: &mut SpendPolicy, config, fee_cfg, registry, approval, max_fee,
  settle_by_ms, clock, ctx)`; the R5 checks follow the list):
  0. **(R4)** The intent is not kind 4 (1022; **R5**: not cross-chain, kind 3).
  1. The allowance's funder is `policy.wallet`. The policy is current: same
     account, same wallet, same `wallet_epoch`. `C` is the policy's asset.
     **(R4)** The config is the policy's (1028). **(R5)** So are the
     `FeeConfig` (1035) and the `Registry` (1036).
  2. The intent is bound to the policy's account.
  3. The payer is a spender. **(R2) The maker is the wallet or a current
     STAFF spender**, so removing a staff member kills their open intents.
  4. The destination is verified (**R5**: in the new numbers, kinds 1–2 for
     recipients and kind 4 for bank payouts; a wallet or exchange intent to a
     policy partner deposit address is refused first, 1029):
     - kinds 2–3: `Destination { 8, recipient }` is in `recipients`. The key
       is built with 8 rather than read from the intent. **(R4)** The kind
       must also equal the stored kind (1025);
     - kind 1: `beneficiaries[beneficiary_ref] == Destination { 8, recipient }`;
     - kind 4: `Destination { domain, recipient }` with `domain != 8`.
       **(R4)** Removed: kind 4 is refused at step 0.
  5. The amount is within the policy's maximum and the payer's (and the
     maker's, when a staff member opened it).
  6. Approvals:
     - above `second_approval_threshold`, an owner approval is required
       (**R5**: when the payment plus the payer's counted total to that
       recipient is above it; see "Running totals");
     - **(R2) an EXECUTOR always needs an approval**. **(R4)** That is an
       owner's `approve_payout` naming it, or the wallet's delegation of an
       intent the wallet opened; the maker's delegation is gone;
     - any approval passed must match this policy, intent, amount, payer and
       `authority_epoch`, and be unexpired. It is consumed. **(R4)** "Unexpired"
       now means `now <` the approval's `settle_by_ms`; the payment's own
       `settle_by_ms` must not be later than the approval's (1027); and its
       `policy_generation` must be current (1021). Who approved is checked
       again at use.
  7. `app_balance_spend`, then core's `settle_from_app`. The allowance's name
     is checked last.

  **(R5)** Added by A1 and the running totals, in `draw`'s order. After step
  4, the kind core will charge: `derive_kind` with the declared tag and
  Splash's registry. A bank payout must derive a bank payout (1030 if its
  partner address is a registered business wallet), and anything else must
  not (1029 for an address in Splash's partner registry). After step 5,
  `max_fee` must be at most 1% of the principal, this package's own ceiling
  (1037), and the fee `splash_fee` computes at most `max_fee` (1031). In step
  6 an approval's `max_total` must cover principal plus fee (1033). Then the
  principal is recorded in the running total, approved or not. The
  withdrawal is exactly principal plus `max_fee`; core charges the fee and
  sends the unused part of `max_fee` to the policy's wallet, never to the
  spender. After core settles, `close_rule_payment` checks the fee core hands
  back against this package's own 1% ceiling (1032) and emits `RuleSpend
  { policy_id, intent_id, allowance_id, approval_id, spender, recipient,
  derived_kind, fee }`, which replaces `PaidUnderPolicy`.
- **(R5) Running totals (decision 4).** The second-approval threshold applies
  to what a payer has paid one recipient in a window, not to each payment
  alone. An invoice split into parts under the threshold still needs an
  owner's approval for the part that takes the total above it.
  - A total is keyed by the payer's ADDRESS and the destination: the
    beneficiary commitment for a bank payout, the recipient address
    otherwise. Removing a spender and adding them back (the only way to
    change a limit or a role) keeps what they paid counting (the review
    finding that a re-add reset it).
  - The window is fixed at the first payment in it. It ends
    `running_window_ms`, as set then, after that payment, and the next
    payment after its end starts a new window. A later `set_running_window`
    applies only to windows opened after it, so it neither shortens, extends
    nor revives one.
  - What the check counts (`threshold_total`) is the current window's total
    plus what the previous window paid less than a window length ago. So a
    window primed at its start cannot carry nearly twice the threshold across
    its boundary. Two parts a full window apart, with nothing paid between,
    still pay alone.
  - The totals live in a `LinkedTable` of dynamic fields, written only by a
    successful payment. Each payment removes up to two expired entries from
    the front, and the wallet can remove more with
    `prune_running_totals(policy, max_entries, clock, ctx)`. Neither touches a
    live entry, so pruning never loosens a total. An entry becomes removable
    once nothing in it counts, at most sixty days after its window opened.
  - Views: `running_total`, `threshold_total`, `running_window_start_ms`,
    `running_window_end_ms`, `running_total_count`.
  - The cost: `pay_intent` takes the policy mutably, so every payment under
    one business is sequenced on its policy object.
- **What a core upgrade can still do (R2, stated plainly).** Additive policy
  forbids changing existing functions. But an added core function could write
  an intent's private fields, for example its status or its recipient among
  addresses the policy allows. So a malicious core upgrade could make a spender
  pay a verified recipient twice, within caps. It cannot add a recipient,
  raise a limit, or create an allowance. That is why every proposed core
  upgrade alerts every owner 24 hours ahead, and the alert says so.
  **(R4)** Stated more exactly: an additive core upgrade cannot change a
  spending rule (spenders, recipients, beneficiaries, the policy's limits) or
  create an allowance, and it cannot point spending rules at a second, laxer
  `ComplianceConfig` (each policy pins its config). It **can** change what
  core itself keeps: an added `business_account` function could write the
  tier ceilings (per transfer, daily, monthly), the KYB flag and both freeze
  flags, and an added `payment_intent` function could write an intent's
  fields. "Cannot raise a limit" meant the spending-rule limits only.
  **(R5)** Each policy also pins Splash's `FeeConfig` and `Registry`, and
  `splash_spend` checks the fee on every rule payment against its own 1%
  ceiling, on `max_fee` before and on the fee core reports after. So no core
  upgrade can make a spending rule pay Splash more than 1%. An added
  `fee_config` function could still rewrite the real `FeeConfig`, its fee
  recipient for example, within that bound. On the owners' path the payer's
  `max_fee` is the bound.

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

**(R4) Revised: the backend reads state, not events.** The table and the
rebuild above are no longer what the code does. `upgrade_delay::wrap` is
public, so anyone can wrap a cap of their own and emit events of exactly the
canonical types, enough to push a genuine announcement out of any bounded walk
through the event feed. `OwnerChange*` events also carry no package field, so
no package filter applies to them. So:

- Every 15 minutes `/api/cron/governance-alerts`
  (`lib/server/governance-alert-monitor.ts`, decided in
  `lib/server/governance-events.ts`) reads two objects. One is the canonical
  `DelayedUpgradeCap` (`SPLASH_UPGRADE_WRAPPER_ID`): `pending`,
  `pending_owner`, and its cap's version. The other is the canonical
  `ComplianceConfig` (`SPLASH_COMPLIANCE_CONFIG_ID`): `pending_additions` and
  the three registries.
- It checks their Move types. The wrapper must be
  `<SPLASH_UPGRADE_DELAY_PACKAGE_ID>::upgrade_delay::DelayedUpgradeCap`. The
  config must be `<wrapper.original_package>::compliance_config::ComplianceConfig`:
  core's original id comes from the wrapper, never from
  `SPLASH_CORE_PACKAGE_ID`.
- It alerts from those fields: a pending upgrade, a pending owner change and a
  pending addition, and then an upgrade committed (the cap's version rose) and
  an addition activated (a registry gained the entry). Each alert is keyed by
  its content, so a re-run records it once. Deliveries are leased per claim.
- An id that is not the canonical object of the canonical type, or a read that
  is incomplete, answers 502, and a mismatch also pages through
  `OPERATOR_ALERT_WEBHOOK_URL`. Nothing is alerted from a read that could not
  be trusted.
- The alert gives the bytecode digest, the upgrade policy and the eta.
  **Nothing rebuilds the source**, and no alert lists what changed. Building
  that (fetch the commit, rebuild with the pinned CLI, compare the digest,
  list the added functions) is Phase 2 work.
- A proposal made and withdrawn between two polls is never alerted. It could
  not have taken effect: each change sits in this state for at least 24 hours
  before the chain will apply it.
- **(R5) Fee proposals are not watched yet.** The monitor does not read
  `FeeConfig`. Alerting every owner on `FeeScheduleProposed`,
  `FeeRecipientProposed`, their application and their withdrawal
  (`FeeScheduleProposalCancelled`, `FeeRecipientProposalCancelled`) is
  Phase 2 (A1 §6). Until then the 24-hour notice on a fee change is public on
  chain but reaches no owner.

## 8. Retiring custody and meter from the mainnet path

`splash_custody` and `splash_meter` keep their code and tests. Neither ever
published to mainnet: both were gated on an e-money licence. In v2 they are
retired from the mainnet path permanently. A production environment on
mainnet refuses to boot with `SPLASH_CUSTODY_PACKAGE_ID` or
`SPLASH_PAYOUT_DELEGATION_ID` set (`lib/env.ts`). Testnet keeps them.
**(R4)** The settlement paths built on `splash_custody` (single transfer,
delegated batch, Smart Treasury allocation) refuse on mainnet in every
`SUI_SETTLEMENT_MODE`, simulate included, with no fallback to the legacy
`SPLASH_PACKAGE_ID` (`lib/server/sui-settlement.ts`). Production on mainnet
also refuses to boot with `FUNDING_DEPOSIT_DERIVATION_SECRET` or
`FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON` set: on mainnet a funding session gives
out no deposit address (D1, D3). `splash_custody` still authorises by
`business_account::owner(account)`, the founder field, which never changes,
even after the wallet removes the founder as an owner. That does not matter
while custody is off the mainnet path; it must be revisited before
`splash_custody` is ever published against this core.

**A decision for Sky, not taken here.** **(R5) Decided by A1.** Splash's fee
is computed on chain in `fee_config`, split inside Move to `FeeConfig`'s fee
recipient (the finance multisig, proven a multisig), never a PTB argument,
and changed only after 24 hours' notice. The Send USDC desk's optional fee is
now the WALLET schedule's, paid to that same recipient
(`lib/server/stablecoin-fee.ts`), and `SPLASH_FEE_ADDRESS_MAINNET` is retired.
The question as first written: the stablecoin lane's audit-anchor fee
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
| 421–449 | `payment_intent` (v2; **R5** adds 435) |
| 1000–1049 | `splash_spend::splash_spend` |
| 1050–1099 | `splash_spend::spend_policy` |
| 1100–1149 | `splash_upgrade_delay::upgrade_delay` |
| 1200–1249 | `splash_core::multisig` |
| 1300–1349 | `splash_core::fee_config` (**R5**; 1300–1306 in use) |
| 1400–1449 | `splash_core::address_registry` (**R5**; 1400–1403 in use) |

## Known limits, accepted

- **Fixed windows.** Allowance rate limits are fixed windows, so a daily limit
  `X` can move `2X` across a window boundary. Keep staff allowances short and
  lifetime-capped.
- **Split payments.** The second-approval threshold is per payment, so the
  backend flags payments to the same beneficiary that together exceed it within
  24 hours. **(R4)** No such flag exists in the code. A staff member can open
  one invoice as several intents at or below the threshold and pay each alone.
  What bounds that is the allowance's own caps (its lifetime cap or rate
  limit, which the owners set when they propose it) and the account's tier
  ceilings (tier 3: 20,000 USDC per transfer and per day, 500,000 a month;
  tier 1 has no daily or monthly ceiling). Nothing ties the allowance's caps
  to the threshold. Owners who want the threshold to hold across payments set
  the allowance's window at or below it. Detecting splits is a Phase 2 item,
  and it can only detect, not prevent: a staff member can build and submit
  the whole transaction alone, without Splash's backend. **(R5)** Superseded
  by decision 4: the threshold now applies to the payer's running total per
  recipient (§5), so one spender splitting one invoice needs an approval for
  the part over it. What remains: a split across several spenders, each
  under the threshold, which Phase 2's near-threshold alert (read from
  `RuleSpend`) is to flag; and several beneficiaries bound to one partner
  deposit address keep separate totals, so the Phase 2 partner
  payout-instruction API must build each instruction strictly from the
  intent's `beneficiary_ref`. A fixed window also lets up to twice the
  allowance's own rate limit move across its boundary, as above.
- **Batches are atomic.** A batch PTB is all-or-nothing against the shared
  tier windows. Phase 2 sizes chunks and dry-runs a 50-row batch on testnet to
  check the protocol's per-transaction input limits.
- **Bank payouts.** On-chain checks prove that the USDC reached the
  beneficiary's bound partner address. The partner pays the bank account in
  the payout instruction, and Phase 2 recomputes the beneficiary commitment
  from that instruction and refuses to send it if they differ.
- **Partner deposit model.** Phase 0 check 6 is still open: whether a partner
  uses a fixed deposit address per business must be confirmed before mainnet.
  Per-payout addresses would need the wallet to verify each one. **(R5)**
  Decided by Sky (decision 2): a partner's deposit address is fixed per
  business per partner, verified once by a test deposit, and bound to its
  beneficiaries by the wallet. The policy keeps it off the recipient list and
  pays it only as a bank payout for a beneficiary bound to it, so the partner
  can match sender, amount and intent. Splash's ops capability also lists
  partner deposit addresses in `address_registry`. Which networks each
  partner deposits on is still a per-partner question
  (`docs/mainnet-checks-2026-10.md`).
- **(R5) The fee is outside the principal's limits.** The tier ceilings and a
  policy's limits and threshold count the principal only; Splash's fee, at
  most 1%, comes on top. The allowance's caps count principal plus `max_fee`.
- **(R5) Fee proposals alert no owner yet** (§7): until the Phase 2
  listener, governance's 24-hour notice on a schedule or recipient change is
  visible on chain only.
