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
/// generation, the asset, the compliance config, the owners, the lists, the
/// limits) is copied in at creation or set by the wallet, and never read back
/// from core's mutable state.
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
/// the start of the current window and the principal paid in it. The window
/// is fixed and anchored at the first payment in it: once `running_window_ms`
/// has passed since that payment, the next payment starts a new window at its
/// own time with a total of zero. The recipient is the beneficiary commitment
/// for a bank payout and the recipient address otherwise. Every payment,
/// approved or not, adds its principal. The mechanism is fixed; the wallet
/// sets the window (an hour to thirty days) and the threshold.
///
/// The totals live in a `Table`, so each payment touches one entry and the
/// policy object does not grow. Entries are written only by a successful
/// payment under the policy, so only the wallet's own spenders, paying the
/// wallet's verified destinations, create them. There is at most one per
/// (payer address, destination); a lapsed window, or a spender removed and
/// added back, overwrites its entry in place rather than adding one.
module splash_spend::spend_policy;

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::multisig;
use splash_core::payment_intent;
use std::string::String;
use sui::derived_object;
use sui::event;
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
/// A recipient is verified as a Splash business (kind 2) or a wallet
/// (kind 3). Bank payouts (kind 1) go through `verify_beneficiary`.
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
/// Thirty days: the longest an intent lives and the length of the tier's
/// monthly window. Longer, the total becomes a lifetime cap per recipient,
/// which is the allowance's own job, and a payment months old would still
/// force approvals.
const MAX_RUNNING_WINDOW_MS: u64 = 2_592_000_000;

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
    /// Which grant this is: a number the policy hands out once, when the
    /// spender is added. A running total records it, so a spender removed
    /// and added back starts a new total.
    serial: u64,
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
    /// The payer's `Spender.serial` when the window started.
    spender_serial: u64,
    /// The first payment in the window.
    window_start_ms: u64,
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
    /// The wallet members' own addresses, derived at creation from the keys
    /// that also derive `wallet`. Who may give a second approval.
    owners: vector<address>,
    spenders: Table<address, Spender>,
    spender_count: u64,
    /// Kinds 2–3: verified destinations on Sui, each with the one kind it is
    /// paid as, which is how core delivers it: a Splash business (2) is
    /// credited to its address balance, a wallet (3) receives a Coin.
    recipients: Table<Destination, u8>,
    recipient_count: u64,
    /// Kind 1: each bank beneficiary (by 32-byte commitment) bound to the one
    /// partner deposit destination allowed to receive payouts for it.
    beneficiaries: Table<vector<u8>, Destination>,
    beneficiary_count: u64,
    per_payment_max: u64,
    /// A payment needs a second approval from an owner when it takes what
    /// its payer has paid its recipient in the current window above this.
    second_approval_threshold: u64,
    /// Moves on every removal (a spender, a recipient, a beneficiary). Each
    /// approval records the generation it was given under and dies when it
    /// moves, so adding back what was removed never brings an approval back.
    generation: u64,
    /// The next `Spender.serial` to hand out.
    next_spender_serial: u64,
    /// How long a running total's window lasts, from its first payment.
    running_window_ms: u64,
    /// Decision 4: per (payer, recipient), the principal paid in the current
    /// window. Written only by `record_payment`, from `splash_spend`'s draw.
    running_totals: Table<RunningKey, RunningTotal>,
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
/// object, not the event. A payment's running total is not a change to the
/// rules and emits nothing here.
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
/// pays under this policy only against it.
public fun create_policy<T>(
    registry: &mut PolicyRegistry,
    account: &BusinessAccount,
    config: &ComplianceConfig,
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
        owners,
        spenders: table::new(ctx),
        spender_count: 0,
        recipients: table::new(ctx),
        recipient_count: 0,
        beneficiaries: table::new(ctx),
        beneficiary_count: 0,
        per_payment_max,
        second_approval_threshold: DEFAULT_SECOND_APPROVAL_THRESHOLD,
        generation: 0,
        next_spender_serial: 0,
        running_window_ms: DEFAULT_RUNNING_WINDOW_MS,
        running_totals: table::new(ctx),
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
    let serial = policy.next_spender_serial;
    policy.next_spender_serial = serial + 1;
    policy.spenders.add(spender, Spender { role, per_payment_max, serial });
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
/// Their running totals end with the grant: added back, they start new ones
/// (each old entry is overwritten by their next payment to that recipient).
public fun remove_spender(policy: &mut SpendPolicy, spender: address, ctx: &TxContext) {
    assert_wallet(policy, ctx);
    assert!(policy.spenders.contains(spender), E_NOT_A_SPENDER);
    policy.spenders.remove(spender);
    policy.spender_count = policy.spender_count - 1;
    retire_approvals(policy);
    changed(policy, b"remove_spender");
}

/// Verify a destination on Sui, and how it is paid: `kind` 2 for another
/// Splash business (credited to its address balance, where its own rules
/// draw) or 3 for a supplier's wallet or an exchange deposit address (sent a
/// Coin, which every deposit system recognises). Payments to it under the
/// policy must be of that kind, so a spender cannot choose the delivery
/// form. To change it, the wallet removes the recipient and verifies it
/// again.
///
/// A recipient on any other domain is refused: no spending rule could pay
/// it, because a cross-chain payment would hand the business's coin to the
/// spender's transaction. The owners pay those from the wallet.
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
    assert!(
        kind == payment_intent::kind_splash_business() || kind == payment_intent::kind_wallet(),
        E_BAD_KIND,
    );
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
    policy.beneficiaries.add(commitment, Destination { domain: SUI_DOMAIN, addr: partner_deposit });
    policy.beneficiary_count = policy.beneficiary_count + 1;
    changed(policy, b"verify_beneficiary");
}

/// Removing a beneficiary stops its open bank payouts at once, and retires
/// every approval given so far.
public fun remove_beneficiary(policy: &mut SpendPolicy, commitment: vector<u8>, ctx: &TxContext) {
    assert_wallet(policy, ctx);
    assert!(policy.beneficiaries.contains(commitment), E_NOT_VERIFIED);
    policy.beneficiaries.remove(commitment);
    policy.beneficiary_count = policy.beneficiary_count - 1;
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
/// an hour, at most thirty days. It applies at once, to windows already open
/// too, since a window lapses when this long has passed since its first
/// payment. A shorter window lets totals lapse sooner, so shortening grows
/// the policy and needs it current and the account not frozen; lengthening
/// is always open.
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

/// The entry still counts at `now_ms`: it belongs to the payer's current
/// grant and its window has not run out.
fun is_live(policy: &SpendPolicy, key: &RunningKey, now_ms: u64): bool {
    if (!policy.running_totals.contains(*key)) return false;
    if (!policy.spenders.contains(key.payer)) return false;
    let entry = policy.running_totals.borrow(*key);
    if (entry.spender_serial != policy.spenders.borrow(key.payer).serial) return false;
    // `now_ms` before the start only happens in a view asked about the past.
    now_ms < entry.window_start_ms || now_ms - entry.window_start_ms < policy.running_window_ms
}

/// Add `amount` of principal to what `payer` has paid this recipient in the
/// current window, starting a new window at `now_ms` if the last one has run
/// out (or belonged to an earlier grant). Saturates rather than aborts: a
/// total that large is already far above any threshold.
public(package) fun record_payment(
    policy: &mut SpendPolicy,
    payer: address,
    kind: u8,
    recipient: address,
    beneficiary_ref: vector<u8>,
    amount: u64,
    now_ms: u64,
) {
    let serial = policy.spenders.borrow(payer).serial;
    let key = running_key(payer, kind, recipient, beneficiary_ref);
    if (is_live(policy, &key, now_ms)) {
        let entry = policy.running_totals.borrow_mut(key);
        entry.total = if (entry.total > std::u64::max_value!() - amount) std::u64::max_value!()
        else entry.total + amount;
        return
    };
    let fresh = RunningTotal { spender_serial: serial, window_start_ms: now_ms, total: amount };
    if (policy.running_totals.contains(key)) *policy.running_totals.borrow_mut(key) = fresh
    else policy.running_totals.add(key, fresh);
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun account(policy: &SpendPolicy): ID { policy.account }
public fun wallet(policy: &SpendPolicy): address { policy.wallet }
public fun wallet_epoch(policy: &SpendPolicy): u64 { policy.wallet_epoch }
public fun asset(policy: &SpendPolicy): String { policy.asset }
/// The ID of the `ComplianceConfig` this policy was created against.
public fun config(policy: &SpendPolicy): ID { policy.config }
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
/// The kind a verified recipient is paid as: 2 (a Splash business) or 3 (a
/// wallet). Aborts if it is not verified.
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
/// current at `now_ms`: 0 if there is none, it has run out, or `payer` is no
/// longer (or no longer the same) spender. The recipient is named as an
/// intent names it: for a bank payout (kind 1) by `beneficiary_ref`, the
/// recipient address being ignored; otherwise by `recipient`.
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
public fun max_spenders(): u64 { MAX_SPENDERS }
public fun role_staff(): u8 { ROLE_STAFF }
public fun role_executor(): u8 { ROLE_EXECUTOR }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}
