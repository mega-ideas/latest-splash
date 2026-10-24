/// SpendPolicy — the business's own rules for spending under its allowances.
///
/// One shared object per account and wallet generation, and ONLY the business
/// wallet can change it: every mutation asserts that the sender is the wallet
/// the policy was created by. The wallet is the owners' multisig, so a change
/// to who may spend, where, how much, or above what amount a second owner must
/// approve is itself an owners' decision, enforced by the protocol.
///
/// A policy GROWS (a spender, a recipient, a beneficiary, looser limits, a
/// new spending rule) only while it is its account's current one and the
/// account is not frozen, by an owner or by compliance, as core refuses
/// membership growth under a freeze. So a wallet rotated away from (often
/// because a signer was compromised) cannot keep writing to its old policy,
/// and nobody is ready to pay the moment a freeze lifts. Removals and
/// tightening stay open in every state, so the owners can always cut back.
///
/// It lives in this package, not in `splash_core`, so no upgrade of
/// `splash_core` can reach it. Everything that matters (the wallet, its
/// generation, the asset, the compliance config, Splash's fee config and
/// address registry, the owners, the lists, the limits) is copied in at
/// creation or set by the wallet, and never read back from core's mutable
/// state.
///
/// ─── One policy per wallet generation ───────────────────────────────────────
///
/// The policy's UID is derived from `(account, wallet_epoch)` under a registry
/// shared at publish, so a second policy for the same wallet generation cannot
/// exist. Without that, a spender listed on two policies could pick the looser
/// one, and a "replaced" policy would stay live. Rotating the wallet moves the
/// account to a new generation: the old policy stops paying (`splash_spend`
/// checks the generation) and the new wallet creates its own.
///
/// ─── Running totals (decision 4) ────────────────────────────────────────────
///
/// The second-approval threshold applies to what a payer has paid one
/// recipient in a window, not to each payment alone, so an invoice split into
/// parts under the threshold still needs an owner's approval for the part
/// that takes the total above it. The policy keeps, per (payer, recipient),
/// the start and the end of the current window and the principal paid in
/// it. The window is fixed at the first payment in it: it ends
/// `running_window_ms` (as set then) after that payment, and the next payment
/// after its end starts a new window at its own time. A later change to the
/// window applies to windows opened after it, so it neither cuts short nor
/// extends one already open, and never revives one that has ended. The
/// recipient is the beneficiary commitment for a bank payout and the
/// recipient address otherwise. Every payment, approved or not, adds its
/// principal. The mechanism is fixed; the wallet sets the window (an hour
/// to thirty days) and the threshold.
///
/// A total is the payer ADDRESS's, not its grant's. Removing a spender and
/// adding them back (the only way to change a limit or a role) leaves what
/// they paid in the window counting, so it cannot hand them a fresh
/// threshold's room.
///
/// ─── How the totals stay bounded ────────────────────────────────────────────
///
/// The totals live in a `LinkedTable` (dynamic fields), so the policy object
/// itself does not grow, and each payment touches its own entry and the
/// front of the list. Entries are written only by a successful payment, so
/// only the wallet's own spenders, paying the wallet's verified destinations,
/// create them, and at most one per (payer address, destination). A new
/// window is pushed to the back, replacing the entry's expired window in
/// place, so the list is in order of window start. Every payment then
/// removes up to two expired entries from the front, and the wallet can
/// remove more with `prune_running_totals`; neither touches a live entry, so
/// pruning never loosens a total. Since no window lasts more than thirty
/// days, every entry is at most thirty days past its start before it can be
/// pruned. So the table holds the windows opened in the last thirty days,
/// plus expired entries that each later payment, or the wallet, clears.
module splash_spend::spend_policy;

use splash_core::address_registry::Registry;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::fee_config::FeeConfig;
use splash_core::multisig;
use splash_core::payment_intent;
use std::string::String;
use sui::clock::Clock;
use sui::derived_object;
use sui::event;
use sui::linked_table::{Self, LinkedTable};
use sui::table::{Self, Table};

// ─── Abort codes ───────────────────────────────────────────────────────────
/// The sender is not this policy's wallet.
const E_NOT_THE_WALLET: u64 = 1050;
/// The members do not derive the sender, or the sender is not the account's
/// registered wallet.
const E_WALLET_MISMATCH: u64 = 1051;
const E_TOO_MANY_SPENDERS: u64 = 1052;
const E_ALREADY_A_SPENDER: u64 = 1053;
const E_NOT_A_SPENDER: u64 = 1054;
/// Zero, or the wallet itself: the wallet pays through its own path.
const E_INVALID_ADDRESS: u64 = 1055;
const E_ALREADY_VERIFIED: u64 = 1056;
const E_NOT_VERIFIED: u64 = 1057;
/// A beneficiary is named by its 32-byte commitment.
const E_BAD_BENEFICIARY: u64 = 1058;
/// A per-payment maximum of zero would refuse every payment.
const E_BAD_LIMIT: u64 = 1059;
/// A spender's role is STAFF (1) or EXECUTOR (2).
const E_UNKNOWN_ROLE: u64 = 1060;
/// A spending rule pays only on Sui (domain 8). A recipient on another chain
/// is paid from the wallet.
const E_NOT_ON_SUI: u64 = 1061;
/// A recipient is tagged a wallet (kind 1) or an exchange (kind 2). A
/// Splash business (kind 0) is derived by core, never tagged; bank payouts
/// (kind 4) go through `verify_beneficiary`.
const E_BAD_KIND: u64 = 1062;
/// The compliance config does not accept `T` as a settlement asset. A policy
/// in it could never pay, and its wallet generation's one slot would be gone.
const E_ASSET_NOT_ACCEPTED: u64 = 1063;
/// The policy is not its account's current one: the account has rotated to
/// another wallet generation, or this is another account. It can only be
/// cut back.
const E_POLICY_NOT_CURRENT: u64 = 1064;
/// The account is frozen. The policy can be cut back, not grown, until it
/// thaws.
const E_ACCOUNT_FROZEN: u64 = 1065;
/// A running-total window is at least an hour and at most thirty days.
const E_BAD_WINDOW: u64 = 1066;
/// The address is a partner deposit address (a verified beneficiary is bound
/// to it). It is paid only as a bank payout, so it is not also a recipient.
const E_PARTNER_DEPOSIT: u64 = 1067;
/// The address is a verified recipient (a wallet or an exchange). It cannot also be a
/// partner deposit address; remove it as a recipient first.
const E_ALREADY_A_RECIPIENT: u64 = 1068;

// ─── Constants ─────────────────────────────────────────────────────────────
/// Staff open intents and pay them.
const ROLE_STAFF: u8 = 1;
/// The KMS operator: opens nothing, and pays only with the owners' approval
/// naming it as the payer (an owner's, or the wallet's delegation).
const ROLE_EXECUTOR: u8 = 2;
const MAX_SPENDERS: u64 = 64;
/// D2: a second owner approval above 10,000 USDC, in minor units (6 decimals).
const DEFAULT_SECOND_APPROVAL_THRESHOLD: u64 = 10_000_000_000;
const COMMITMENT_BYTES: u64 = 32;
/// Every destination a policy verifies is on Sui: a bank payout's partner
/// deposit address, another Splash business, a wallet.
const SUI_DOMAIN: u32 = 8;
/// Decision 4: a running total is kept over 24 hours unless the wallet
/// chooses otherwise.
const DEFAULT_RUNNING_WINDOW_MS: u64 = 86_400_000;
/// Under an hour, the rule barely holds: a spender waits a few minutes
/// between the parts of a split payment. Zero would switch it off while it
/// still looks set.
const MIN_RUNNING_WINDOW_MS: u64 = 3_600_000;
/// Thirty days: the longest an intent lives. Longer, the total becomes a
/// lifetime cap per recipient, which is the allowance's own job, and a
/// payment months old would still force approvals.
const MAX_RUNNING_WINDOW_MS: u64 = 2_592_000_000;
/// How many expired running totals a payment removes from the front of the
/// list, at most: more than the one entry a payment can add, so the backlog
/// shrinks while payments run.
const PRUNE_PER_PAYMENT: u64 = 2;

/// Shared once, at publish. The parent every policy's UID is derived from.
public struct PolicyRegistry has key {
    id: UID,
}

/// What a policy's UID is derived from.
public struct PolicyKey has copy, drop, store {
    account: ID,
    wallet_epoch: u64,
}

/// Where a payment lands: a CCTP domain and an address there. The domain is
/// always 8 (Sui): a spending rule pays nowhere else.
public struct Destination has copy, drop, store {
    domain: u32,
    addr: address,
}

public struct Spender has copy, drop, store {
    role: u8,
    /// This spender's own ceiling per payment, inside the policy's.
    per_payment_max: u64,
}

/// Whose running total, to whom. For a bank payout `beneficiary` is the
/// beneficiary commitment and `recipient` is zero; otherwise `beneficiary`
/// is empty and `recipient` is the recipient address. So a bank beneficiary
/// and an address never share a total.
public struct RunningKey has copy, drop, store {
    payer: address,
    beneficiary: vector<u8>,
    recipient: address,
}

/// The principal a payer has paid one recipient in the current window.
public struct RunningTotal has copy, drop, store {
    /// The first payment in the window.
    window_start_ms: u64,
    /// When the window ends: its start plus the window length in force at
    /// its first payment. Fixed for the life of the window.
    window_end_ms: u64,
    total: u64,
}

public struct SpendPolicy has key {
    id: UID,
    account: ID,
    /// The business wallet that created this policy, and the only sender that
    /// can change it.
    wallet: address,
    /// The account's wallet generation when this policy was created.
    wallet_epoch: u64,
    /// The one coin type this policy pays in (USDC). Its limits are minor
    /// units of it.
    asset: String,
    /// The `ComplianceConfig` this policy was created against.
    /// `splash_spend` opens and pays only against it, so its pause and
    /// registries cannot be swapped for another config's: core v1 mints
    /// one, but an additive core upgrade could add a constructor.
    config: ID,
    /// Splash's `FeeConfig` and address `Registry` when this policy was
    /// created (A1 §2.3, §2.6), pinned for the same reason: `splash_spend`
    /// pays only against them, so a second FeeConfig cannot redirect or
    /// waive a rule payment's fee, and a second Registry cannot reclassify
    /// its recipient.
    fee_config: ID,
    address_registry: ID,
    /// The wallet members' own addresses, derived at creation from the keys
    /// that also derive `wallet`. Who may give a second approval.
    owners: vector<address>,
    spenders: Table<address, Spender>,
    spender_count: u64,
    /// Verified destinations on Sui, each with its tag: the kind a payment
    /// to it declares (A1 §2.3), a wallet (1) or an exchange (2). Core
    /// derives the kind it charges and delivers from the tag and Splash's
    /// registries: a registered business wallet is a Splash business,
    /// credited to its address balance, whatever its tag; anything else
    /// receives a Coin. Never a partner deposit address.
    recipients: Table<Destination, u8>,
    recipient_count: u64,
    /// Kind 4: each bank beneficiary (by 32-byte commitment) bound to the one
    /// partner deposit destination allowed to receive payouts for it.
    beneficiaries: Table<vector<u8>, Destination>,
    beneficiary_count: u64,
    /// Decision 2: every partner deposit address (an address at least one
    /// verified beneficiary is bound to), with how many are bound to it. It
    /// is paid only as a bank payout for one of them, and never appears in
    /// `recipients`: the two lists do not overlap. Removing the last
    /// beneficiary bound to an address removes its entry.
    partner_deposits: Table<address, u64>,
    per_payment_max: u64,
    /// A payment needs a second approval from an owner when it takes what
    /// its payer has paid its recipient in the current window above this.
    second_approval_threshold: u64,
    /// Moves on every removal (a spender, a recipient, a beneficiary). Each
    /// approval records the generation it was given under and dies when it
    /// moves, so adding back what was removed never brings an approval back.
    generation: u64,
    /// How long a running total's window lasts, from its first payment, for
    /// windows opened from now on.
    running_window_ms: u64,
    /// Decision 4: per (payer, recipient), the principal paid in the current
    /// window, in order of window start. Written only by `record_payment`,
    /// from `splash_spend`'s draw; expired entries are removed from the
    /// front by each payment and by `prune_running_totals`.
    running_totals: LinkedTable<RunningKey, RunningTotal>,
}

// ─── Events ────────────────────────────────────────────────────────────────

/// What the event stream learns is that a policy exists and for which
/// account; limits and lists stay on the object, as WS5 keeps ceilings and
/// counterparties off events.
public struct PolicyCreated has copy, drop {
    policy_id: ID,
    business_account_id: ID,
    wallet: address,
    wallet_epoch: u64,
    owner_count: u64,
}

/// `change` is one of `add_spender`, `remove_spender`, `verify_recipient`,
/// `remove_recipient`, `verify_beneficiary`, `remove_beneficiary`,
/// `set_limits`, `set_running_window`. Which entry changed is read off the
/// object, not the event. A payment's running total, and pruning expired
/// totals, are not changes to the rules and emit nothing here.
public struct PolicyChanged has copy, drop {
    policy_id: ID,
    change: vector<u8>,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(PolicyRegistry { id: object::new(ctx) });
}

// ─── Creation ──────────────────────────────────────────────────────────────

/// Create the policy for an account's current wallet generation, signed by
/// the wallet, paying in `T`.
///
/// The keys, weights and threshold must derive the sender, exactly as
/// `register_wallet` checked, and the sender must be the account's registered
/// wallet. The owners are derived from the same keys. `T` must be an asset
/// the compliance config accepts, checked before the generation's one slot is
/// claimed, and the policy records that config's ID: `splash_spend` opens and
/// pays under this policy only against it. It records the IDs of Splash's
/// `FeeConfig` and address `Registry` passed too, and pays only against
/// those.
public fun create_policy<T>(
    registry: &mut PolicyRegistry,
    account: &BusinessAccount,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    addresses: &Registry,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    per_payment_max: u64,
    ctx: &mut TxContext,
): ID {
    let sender = ctx.sender();
    assert!(multisig::derive_address(&keys, &weights, threshold) == sender, E_WALLET_MISMATCH);
    assert!(business_account::has_wallet(account), E_WALLET_MISMATCH);
    assert!(business_account::wallet(account) == sender, E_WALLET_MISMATCH);
    assert!(per_payment_max > 0, E_BAD_LIMIT);
    let asset = compliance_config::type_string<T>();
    assert!(compliance_config::is_asset_accepted(config, &asset), E_ASSET_NOT_ACCEPTED);

    let owners = multisig::signer_addresses(&keys);
    let owner_count = owners.length();
    let account_id = object::id(account);
    let wallet_epoch = business_account::wallet_epoch(account);
    let policy = SpendPolicy {
        // One policy per wallet generation: a second claim aborts.
        id: derived_object::claim(&mut registry.id, PolicyKey { account: account_id, wallet_epoch }),
        account: account_id,
        wallet: sender,
        wallet_epoch,
        asset,
        config: object::id(config),
        fee_config: object::id(fee_cfg),
        address_registry: object::id(addresses),
        owners,
        spenders: table::new(ctx),
        spender_count: 0,
        recipients: table::new(ctx),
        recipient_count: 0,
        beneficiaries: table::new(ctx),
        beneficiary_count: 0,
        partner_deposits: table::new(ctx),
        per_payment_max,
        second_approval_threshold: DEFAULT_SECOND_APPROVAL_THRESHOLD,
        generation: 0,
        running_window_ms: DEFAULT_RUNNING_WINDOW_MS,
        running_totals: linked_table::new(ctx),
    };
    let policy_id = object::id(&policy);
    event::emit(PolicyCreated {
        policy_id,
        business_account_id: account_id,
        wallet: sender,
        wallet_epoch,
        owner_count,
    });
    transfer::share_object(policy);
    policy_id
}

// ─── Mutation: the wallet only ─────────────────────────────────────────────

fun assert_wallet(policy: &SpendPolicy, ctx: &TxContext) {
    assert!(ctx.sender() == policy.wallet, E_NOT_THE_WALLET);
}

fun changed(policy: &SpendPolicy, change: vector<u8>) {
    event::emit(PolicyChanged { policy_id: object::id(policy), change });
}

/// Growth needs the account: this policy is its current one (same account,
/// wallet and wallet generation) and the account is not frozen. Also used by
/// `splash_spend::accept`, since a new spending rule grows the policy too.
public(package) fun assert_can_grow(policy: &SpendPolicy, account: &BusinessAccount) {
    assert!(object::id(account) == policy.account, E_POLICY_NOT_CURRENT);
    assert!(business_account::has_wallet(account), E_POLICY_NOT_CURRENT);
    assert!(business_account::wallet(account) == policy.wallet, E_POLICY_NOT_CURRENT);
    assert!(business_account::wallet_epoch(account) == policy.wallet_epoch, E_POLICY_NOT_CURRENT);
    assert!(!business_account::is_frozen(account), E_ACCOUNT_FROZEN);
}

/// A removal withdraws the owners' trust in someone or somewhere. Every
/// approval given before it, to anyone, dies with it, so that re-adding the
/// same entry never revives one; the owners approve again.
fun retire_approvals(policy: &mut SpendPolicy) {
    policy.generation = policy.generation + 1;
}

/// Add a spender: STAFF, who open and pay, or EXECUTOR (Splash's KMS
/// operator), who only pays what the owners approved for it.
public fun add_spender(
    policy: &mut SpendPolicy,
    account: &BusinessAccount,
    spender: address,
    role: u8,
    per_payment_max: u64,
    ctx: &TxContext,
) {
    assert_wallet(policy, ctx);
    assert_can_grow(policy, account);
    assert!(spender != @0x0 && spender != policy.wallet, E_INVALID_ADDRESS);
    assert!(role == ROLE_STAFF || role == ROLE_EXECUTOR, E_UNKNOWN_ROLE);
    assert!(per_payment_max > 0, E_BAD_LIMIT);
    assert!(!policy.spenders.contains(spender), E_ALREADY_A_SPENDER);
    assert!(policy.spender_count < MAX_SPENDERS, E_TOO_MANY_SPENDERS);
    policy.spenders.add(spender, Spender { role, per_payment_max });
    policy.spender_count = policy.spender_count + 1;
    changed(policy, b"add_spender");
}

/// Stops a spender at once, without waiting for the business to revoke the
/// allowance: `pay_intent` checks this list on every payment, for the payer
/// and for the intent's maker, so the spender's open intents stop too while
/// they stay removed. It also retires every approval given so far, so
/// adding the spender back (for example with a new limit) revives none of
/// them. Their open intents do become payable again if they are added
/// back; the wallet cancels any it does not want with `cancel_by_wallet`.
/// Their running totals do NOT end with the grant: a total is the address's,
/// and lasts its window, so removing and re-adding someone (to change their
/// limit or role) gives them no fresh room under the threshold.
public fun remove_spender(policy: &mut SpendPolicy, spender: address, ctx: &TxContext) {
    assert_wallet(policy, ctx);
    assert!(policy.spenders.contains(spender), E_NOT_A_SPENDER);
    policy.spenders.remove(spender);
    policy.spender_count = policy.spender_count - 1;
    retire_approvals(policy);
    changed(policy, b"remove_spender");
}

/// Verify a destination on Sui, with its tag (A1 §2.3): `kind` 1 for a
/// wallet the business has proved belongs to the payee, or 2 for an
/// exchange deposit address. The tag is the kind every payment to it under
/// the policy declares, so a spender cannot choose it, and Splash's fee
/// follows the kind core derives from it: a registered business wallet is
/// charged and delivered as a Splash business whatever its tag, and an
/// address in Splash's partner registry is refused as anything but a bank
/// payout when it is paid. A Splash business is never a tag. To change a
/// tag, the wallet removes the recipient and verifies it again.
///
/// The ownership proof behind a wallet tag is checked off chain before the
/// wallet signs this; the chain only knows that the wallet chose the tag.
///
/// A recipient on any other domain is refused: no spending rule could pay
/// it, because a cross-chain payment would hand the business's coin to the
/// spender's transaction. The owners pay those from the wallet. So is a
/// partner deposit address (decision 2): it is paid only as a bank payout for
/// a beneficiary bound to it, where the partner can match the deposit to a
/// payout instruction.
public fun verify_recipient(
    policy: &mut SpendPolicy,
    account: &BusinessAccount,
    domain: u32,
    addr: address,
    kind: u8,
    ctx: &TxContext,
) {
    assert_wallet(policy, ctx);
    assert_can_grow(policy, account);
    assert!(addr != @0x0, E_INVALID_ADDRESS);
    assert!(domain == SUI_DOMAIN, E_NOT_ON_SUI);
    assert!(kind == payment_intent::kind_wallet() || kind == payment_intent::kind_exchange(), E_BAD_KIND);
    assert!(!policy.partner_deposits.contains(addr), E_PARTNER_DEPOSIT);
    let key = Destination { domain, addr };
    assert!(!policy.recipients.contains(key), E_ALREADY_VERIFIED);
    policy.recipients.add(key, kind);
    policy.recipient_count = policy.recipient_count + 1;
    changed(policy, b"verify_recipient");
}

/// Removing a recipient stops its open intents at once, and retires every
/// approval given so far.
public fun remove_recipient(policy: &mut SpendPolicy, domain: u32, addr: address, ctx: &TxContext) {
    assert_wallet(policy, ctx);
    let key = Destination { domain, addr };
    assert!(policy.recipients.contains(key), E_NOT_VERIFIED);
    policy.recipients.remove(key);
    policy.recipient_count = policy.recipient_count - 1;
    retire_approvals(policy);
    changed(policy, b"remove_recipient");
}

/// Verify a bank beneficiary (by its stable 32-byte commitment,
/// `splash:beneficiary:v1`) together with the one partner deposit address on
/// Sui that payouts to it may go to. A verified beneficiary cannot then be
/// paired with any other verified address.
///
/// Decision 2: the address is the partner's fixed deposit address for this
/// business (ideally the business's own sub-account there), verified once
/// off chain by a test deposit. Binding a beneficiary makes it a partner
/// deposit address, paid only as a bank payout for a beneficiary bound to
/// it. An address already verified as a recipient (either tag) is refused,
/// so the two lists never overlap; the wallet removes the recipient first.
public fun verify_beneficiary(
    policy: &mut SpendPolicy,
    account: &BusinessAccount,
    commitment: vector<u8>,
    partner_deposit: address,
    ctx: &TxContext,
) {
    assert_wallet(policy, ctx);
    assert_can_grow(policy, account);
    assert!(commitment.length() == COMMITMENT_BYTES, E_BAD_BENEFICIARY);
    assert!(partner_deposit != @0x0, E_INVALID_ADDRESS);
    assert!(!policy.beneficiaries.contains(commitment), E_ALREADY_VERIFIED);
    assert!(
        !policy.recipients.contains(Destination { domain: SUI_DOMAIN, addr: partner_deposit }),
        E_ALREADY_A_RECIPIENT,
    );
    policy.beneficiaries.add(commitment, Destination { domain: SUI_DOMAIN, addr: partner_deposit });
    policy.beneficiary_count = policy.beneficiary_count + 1;
    if (policy.partner_deposits.contains(partner_deposit)) {
        let bound = policy.partner_deposits.borrow_mut(partner_deposit);
        *bound = *bound + 1;
    } else {
        policy.partner_deposits.add(partner_deposit, 1);
    };
    changed(policy, b"verify_beneficiary");
}

/// Removing a beneficiary stops its open bank payouts at once, and retires
/// every approval given so far. Removing the last beneficiary bound to a
/// partner deposit address clears its partner flag, so the wallet may then
/// verify it as a recipient.
public fun remove_beneficiary(policy: &mut SpendPolicy, commitment: vector<u8>, ctx: &TxContext) {
    assert_wallet(policy, ctx);
    assert!(policy.beneficiaries.contains(commitment), E_NOT_VERIFIED);
    let Destination { domain: _, addr } = policy.beneficiaries.remove(commitment);
    policy.beneficiary_count = policy.beneficiary_count - 1;
    let bound = policy.partner_deposits.borrow_mut(addr);
    *bound = *bound - 1;
    if (*bound == 0) {
        policy.partner_deposits.remove(addr);
    };
    retire_approvals(policy);
    changed(policy, b"remove_beneficiary");
}

/// Set the per-payment maximum and the second-approval threshold, in minor
/// units. A threshold of zero means every payment needs a second approval.
/// Raising either grows the policy, so it needs the policy current and the
/// account not frozen; lowering them is always open.
public fun set_limits(
    policy: &mut SpendPolicy,
    account: &BusinessAccount,
    per_payment_max: u64,
    second_approval_threshold: u64,
    ctx: &TxContext,
) {
    assert_wallet(policy, ctx);
    assert!(object::id(account) == policy.account, E_POLICY_NOT_CURRENT);
    assert!(per_payment_max > 0, E_BAD_LIMIT);
    let loosens =
        per_payment_max > policy.per_payment_max || second_approval_threshold > policy.second_approval_threshold;
    if (loosens) assert_can_grow(policy, account);
    policy.per_payment_max = per_payment_max;
    policy.second_approval_threshold = second_approval_threshold;
    changed(policy, b"set_limits");
}

/// Set how long a running total's window lasts, in milliseconds: at least
/// an hour, at most thirty days. It applies to windows opened from now on;
/// a window already open keeps the end it was given at its first payment,
/// and one that has ended stays ended. A shorter window lets future totals
/// lapse sooner, so shortening grows the policy and needs it current and the
/// account not frozen; lengthening is always open.
public fun set_running_window(
    policy: &mut SpendPolicy,
    account: &BusinessAccount,
    window_ms: u64,
    ctx: &TxContext,
) {
    assert_wallet(policy, ctx);
    assert!(object::id(account) == policy.account, E_POLICY_NOT_CURRENT);
    assert!(window_ms >= MIN_RUNNING_WINDOW_MS && window_ms <= MAX_RUNNING_WINDOW_MS, E_BAD_WINDOW);
    if (window_ms < policy.running_window_ms) assert_can_grow(policy, account);
    policy.running_window_ms = window_ms;
    changed(policy, b"set_running_window");
}

// ─── Running totals: written by splash_spend's draw only ───────────────────

fun running_key(payer: address, kind: u8, recipient: address, beneficiary_ref: vector<u8>): RunningKey {
    if (kind == payment_intent::kind_bank_payout()) {
        RunningKey { payer, beneficiary: beneficiary_ref, recipient: @0x0 }
    } else {
        RunningKey { payer, beneficiary: vector[], recipient }
    }
}

/// The entry still counts at `now_ms`: its window has not ended. (A view
/// asked about a moment before the window started also sees it.)
fun is_live(policy: &SpendPolicy, key: &RunningKey, now_ms: u64): bool {
    policy.running_totals.contains(*key) && now_ms < policy.running_totals.borrow(*key).window_end_ms
}

/// Add `amount` of principal to what `payer` has paid this recipient in the
/// current window, starting a new window at `now_ms`, at the back of the
/// list, if the last one has ended; then remove up to `PRUNE_PER_PAYMENT`
/// expired entries from the front. Saturates rather than aborts: a total
/// that large is already far above any threshold.
public(package) fun record_payment(
    policy: &mut SpendPolicy,
    payer: address,
    kind: u8,
    recipient: address,
    beneficiary_ref: vector<u8>,
    amount: u64,
    now_ms: u64,
) {
    let key = running_key(payer, kind, recipient, beneficiary_ref);
    if (is_live(policy, &key, now_ms)) {
        let entry = policy.running_totals.borrow_mut(key);
        entry.total = if (entry.total > std::u64::max_value!() - amount) std::u64::max_value!()
        else entry.total + amount;
    } else {
        // An expired window for this key is replaced, not kept beside it.
        if (policy.running_totals.contains(key)) {
            policy.running_totals.remove(key);
        };
        let window = policy.running_window_ms;
        let window_end_ms = if (now_ms > std::u64::max_value!() - window) std::u64::max_value!()
        else now_ms + window;
        policy.running_totals.push_back(key, RunningTotal { window_start_ms: now_ms, window_end_ms, total: amount });
    };
    prune_expired(policy, PRUNE_PER_PAYMENT, now_ms);
}

/// Remove up to `max_entries` expired entries from the front of the list,
/// stopping at the first live one. Returns how many it removed.
fun prune_expired(policy: &mut SpendPolicy, max_entries: u64, now_ms: u64): u64 {
    let mut pruned = 0;
    while (pruned < max_entries) {
        let front = *policy.running_totals.front();
        if (front.is_none()) break;
        let key = front.destroy_some();
        if (now_ms < policy.running_totals.borrow(key).window_end_ms) break;
        policy.running_totals.remove(key);
        pruned = pruned + 1;
    };
    pruned
}

/// Remove up to `max_entries` running totals whose windows have ended, from
/// the front of the list (the oldest windows first), and return how many
/// went. Only the wallet, which gets the storage rebate; open in every state,
/// like any cutting back. A live total is never removed, so this cannot
/// loosen the threshold, and it stops at the first live entry: one behind it
/// is removed once that one ends, at most thirty days later.
public fun prune_running_totals(policy: &mut SpendPolicy, max_entries: u64, clock: &Clock, ctx: &TxContext): u64 {
    assert_wallet(policy, ctx);
    prune_expired(policy, max_entries, clock.timestamp_ms())
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun account(policy: &SpendPolicy): ID { policy.account }
public fun wallet(policy: &SpendPolicy): address { policy.wallet }
public fun wallet_epoch(policy: &SpendPolicy): u64 { policy.wallet_epoch }
public fun asset(policy: &SpendPolicy): String { policy.asset }
/// The ID of the `ComplianceConfig` this policy was created against.
public fun config(policy: &SpendPolicy): ID { policy.config }
/// The ID of Splash's `FeeConfig` this policy pays against.
public fun fee_config(policy: &SpendPolicy): ID { policy.fee_config }
/// The ID of Splash's address `Registry` this policy pays against.
public fun address_registry(policy: &SpendPolicy): ID { policy.address_registry }
public fun owners(policy: &SpendPolicy): vector<address> { policy.owners }
public fun is_owner(policy: &SpendPolicy, who: address): bool { policy.owners.contains(&who) }
public fun is_spender(policy: &SpendPolicy, who: address): bool { policy.spenders.contains(who) }
public fun is_staff(policy: &SpendPolicy, who: address): bool {
    policy.spenders.contains(who) && policy.spenders.borrow(who).role == ROLE_STAFF
}
public fun is_executor(policy: &SpendPolicy, who: address): bool {
    policy.spenders.contains(who) && policy.spenders.borrow(who).role == ROLE_EXECUTOR
}
/// A spender's own per-payment ceiling. Aborts if `who` is not a spender.
public fun spender_per_payment_max(policy: &SpendPolicy, who: address): u64 {
    assert!(policy.spenders.contains(who), E_NOT_A_SPENDER);
    policy.spenders.borrow(who).per_payment_max
}
public fun spender_count(policy: &SpendPolicy): u64 { policy.spender_count }
public fun is_recipient_verified(policy: &SpendPolicy, domain: u32, addr: address): bool {
    policy.recipients.contains(Destination { domain, addr })
}
/// A verified recipient's tag, the kind payments to it declare: 1 (a
/// wallet) or 2 (an exchange). Aborts if it is not verified.
public fun recipient_kind(policy: &SpendPolicy, domain: u32, addr: address): u8 {
    let key = Destination { domain, addr };
    assert!(policy.recipients.contains(key), E_NOT_VERIFIED);
    *policy.recipients.borrow(key)
}
/// The beneficiary is verified AND bound to this partner deposit address.
public fun is_beneficiary_bound_to(policy: &SpendPolicy, commitment: vector<u8>, partner_deposit: address): bool {
    policy.beneficiaries.contains(commitment) &&
        *policy.beneficiaries.borrow(commitment) == Destination { domain: SUI_DOMAIN, addr: partner_deposit }
}
/// Decision 2: at least one verified beneficiary is bound to `addr`, so it is
/// paid only as a bank payout for one of them.
public fun is_partner_deposit(policy: &SpendPolicy, addr: address): bool {
    policy.partner_deposits.contains(addr)
}
/// How many verified beneficiaries are bound to `addr` (0 if it is not a
/// partner deposit address).
public fun beneficiaries_bound_to(policy: &SpendPolicy, addr: address): u64 {
    if (policy.partner_deposits.contains(addr)) *policy.partner_deposits.borrow(addr) else 0
}
public fun recipient_count(policy: &SpendPolicy): u64 { policy.recipient_count }
public fun beneficiary_count(policy: &SpendPolicy): u64 { policy.beneficiary_count }
public fun per_payment_max(policy: &SpendPolicy): u64 { policy.per_payment_max }
public fun second_approval_threshold(policy: &SpendPolicy): u64 { policy.second_approval_threshold }
/// How many removals this policy has seen. An approval is valid only under
/// the generation it was given in.
public fun generation(policy: &SpendPolicy): u64 { policy.generation }
public fun default_second_approval_threshold(): u64 { DEFAULT_SECOND_APPROVAL_THRESHOLD }
/// How long a running total's window lasts, from its first payment.
public fun running_window_ms(policy: &SpendPolicy): u64 { policy.running_window_ms }
public fun default_running_window_ms(): u64 { DEFAULT_RUNNING_WINDOW_MS }
public fun min_running_window_ms(): u64 { MIN_RUNNING_WINDOW_MS }
public fun max_running_window_ms(): u64 { MAX_RUNNING_WINDOW_MS }
/// The principal `payer` has paid this recipient in the window that is
/// current at `now_ms`: 0 if there is none or it has ended. It counts while
/// `payer` is off the policy too, and after they are added back. The
/// recipient is named as an intent names it: for a bank payout (kind 4) by
/// `beneficiary_ref`, the recipient address being ignored; otherwise by
/// `recipient`.
public fun running_total(
    policy: &SpendPolicy,
    payer: address,
    kind: u8,
    recipient: address,
    beneficiary_ref: vector<u8>,
    now_ms: u64,
): u64 {
    let key = running_key(payer, kind, recipient, beneficiary_ref);
    if (is_live(policy, &key, now_ms)) policy.running_totals.borrow(key).total else 0
}
/// When the window counted by `running_total` started, if there is one.
public fun running_window_start_ms(
    policy: &SpendPolicy,
    payer: address,
    kind: u8,
    recipient: address,
    beneficiary_ref: vector<u8>,
    now_ms: u64,
): Option<u64> {
    let key = running_key(payer, kind, recipient, beneficiary_ref);
    if (is_live(policy, &key, now_ms)) option::some(policy.running_totals.borrow(key).window_start_ms)
    else option::none()
}
/// When the window counted by `running_total` ends, if there is one: fixed
/// at its first payment.
public fun running_window_end_ms(
    policy: &SpendPolicy,
    payer: address,
    kind: u8,
    recipient: address,
    beneficiary_ref: vector<u8>,
    now_ms: u64,
): Option<u64> {
    let key = running_key(payer, kind, recipient, beneficiary_ref);
    if (is_live(policy, &key, now_ms)) option::some(policy.running_totals.borrow(key).window_end_ms)
    else option::none()
}
/// How many running totals the policy holds, live or expired and not yet
/// pruned.
public fun running_total_count(policy: &SpendPolicy): u64 { policy.running_totals.length() }
public fun max_spenders(): u64 { MAX_SPENDERS }
public fun role_staff(): u8 { ROLE_STAFF }
public fun role_executor(): u8 { ROLE_EXECUTOR }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}
