/// BusinessAccount — who may move money out of a tenant, and under what bound.
///
/// ─── What Phase 6 changed, and why ──────────────────────────────────────────
///
/// Before this, a `BusinessAccount` was an address-owned object with a single
/// `owner` field and no notion of approval at all. Every authority question the
/// product answers — who can release a payment, what happens when that person
/// leaves, how much can leave in a day, how do we stop an account we believe is
/// compromised — was answered off-chain, in a Postgres row, by a server the
/// tenant does not control. The chain recorded the outcome and enforced none of
/// the rules.
///
/// It now holds:
///
///   * `owners` — may change membership. Plural, because a company is not a
///     private key, and a sole owner losing their key was previously terminal.
///   * `approvers` — may release a payout, and may not be the person who
///     initiated it. Four eyes, enforced by the chain rather than by a UI.
///   * `frozen` — two independent flags. An owner can stop their own account;
///     compliance can stop it too, and owners cannot lift the compliance one.
///   * `recovery_party` — a nominated outsider who can restore access after a
///     72-hour public notice that any owner can cancel.
///   * `authority_epoch` — a counter bumped by EVERY membership or freeze
///     change. An approval carries the value it was minted at, so revoking an
///     approver kills approvals already in flight, and revoke-then-regrant does
///     not resurrect them: the second change bumps again.
///   * a 24h payout ceiling (`daily_limit`), so a stolen approver credential
///     has a bound and not just an alarm.
///
/// ─── The object is now SHARED ───────────────────────────────────────────────
///
/// It has to be. Owned means "nameable only by its owner's transactions", and
/// an object several owners and several approvers must all touch cannot be
/// owned by one of them. This is also SECURITY.md's own recommendation at the
/// end of the audit.
///
/// The consequence is that anybody can pass `&mut BusinessAccount` into any
/// function here, so authority is never inferred from possession — every
/// mutator checks the caller against the sets above. That is the correct shape
/// for authority anyway: possession of a reference to a shared object proves
/// nothing.
///
/// ─── What this does not do ──────────────────────────────────────────────────
///
/// Four eyes is a check on ADDRESSES. One person holding two approver keys, or
/// an owner key and an approver key, satisfies it — the chain cannot tell them
/// apart, and no on-chain rule can. What the chain does give is that the two
/// addresses are named, the approval names one of them, and the event stream
/// records which. Detecting that they are the same person is a KYB and an
/// operations question, and belongs to the console, not here.
///
/// An account whose owner set is full (`MAX_MEMBERS`) cannot be recovered,
/// because `execute_recovery` has nowhere to add the new owner. Sixteen owners
/// all losing their keys is not the failure this is guarding against, but it is
/// a way to make an account deliberately recovery-proof, and it is better said
/// than discovered.
module splash_core::business_account;

use splash_core::cap_registry::{Self, CapRegistry};
use splash_core::daily_limit::{Self, DailyLimit};
use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use sui::vec_set::{Self, VecSet};

// ─── Abort codes ───────────────────────────────────────────────────────────
const E_ALREADY_VERIFIED: u64 = 1;
const E_EMPTY_SSM_NUMBER: u64 = 2;
const E_EMPTY_KYB_CID: u64 = 3;
const E_INVALID_HOLDER: u64 = 4;
/// `revoke_verification` called on an account that was never verified.
const E_NOT_VERIFIED_YET: u64 = 5;

// ─── Phase 6 authority (20-block) ──────────────────────────────────────────
const E_NOT_AN_OWNER: u64 = 20;
const E_NOT_AN_APPROVER: u64 = 21;
const E_FROZEN: u64 = 22;
const E_NOT_FROZEN: u64 = 23;
/// Removing this owner would leave the account with none, which is a brick.
const E_LAST_OWNER: u64 = 24;
const E_ALREADY_A_MEMBER: u64 = 25;
const E_NOT_A_MEMBER: u64 = 26;
const E_NOT_RECOVERY_PARTY: u64 = 27;
const E_INVALID_ADDRESS: u64 = 28;
/// The approver is the same address that initiated the payment.
const E_SELF_APPROVAL: u64 = 29;
/// The approval was minted under an authority set that has since changed.
const E_STALE_AUTHORITY: u64 = 30;
const E_WRONG_ACCOUNT: u64 = 31;
const E_APPROVAL_EXPIRED: u64 = 32;
const E_AMOUNT_MISMATCH: u64 = 33;
const E_TOO_MANY_MEMBERS: u64 = 34;
/// A recovery party that is already an owner or approver is not a recovery
/// party, it is a second key held by the same people.
const E_RECOVERY_IS_INSIDER: u64 = 35;
const E_NOT_VERIFIED: u64 = 36;
const E_NO_RECOVERY_PARTY: u64 = 37;
const E_RECOVERY_PENDING: u64 = 38;
const E_NO_PENDING_RECOVERY: u64 = 39;
const E_RECOVERY_NOT_DUE: u64 = 40;
const E_WRONG_INTENT: u64 = 41;

// ─── Bounds ────────────────────────────────────────────────────────────────
/// `VecSet` membership is a linear scan and an unbounded set is both a gas
/// cliff and an object-size risk. Sixteen owners or sixteen approvers is well
/// past any real finance team.
const MAX_MEMBERS: u64 = 16;

/// An approval is good for fifteen minutes. In practice the intent's own
/// five-minute window binds first; this is the backstop for an approval minted
/// against an intent that is then cancelled and never used.
const APPROVAL_TTL_MS: u64 = 900_000;

/// Recovery is announced 72 hours before it can execute. The delay is a
/// DETECTION window: it is worthless if nobody watches, which is why
/// `RecoveryRequested` is an event and why any owner can cancel.
const RECOVERY_DELAY_MS: u64 = 259_200_000;

/// USD 1,000 in the settled coin's MINOR UNITS, at the six decimals every
/// stablecoin in the supported corridors uses. Deliberately written as the
/// scaled integer rather than `1_000`, which would be a tenth of a cent and
/// would read like a limit while being a brick.
const DEFAULT_DAILY_CAP_MINOR: u64 = 1_000_000_000;

// ─── Capabilities ──────────────────────────────────────────────────────────

/// AdminCap — GOVERNANCE authority. Gates KYB verification and its withdrawal,
/// compliance-side freezing, per-account ceilings, anchor-cap rotation,
/// `compliance_config::create`, relaxations of the compliance parameters, and
/// `peg_monitor::init_peg_state`.
///
/// Has `store` so it can be transferred to a cold 2-of-3 Sui multisig address
/// (see the key-ceremony runbook).
///
/// What it is NOT, since Phase 6: a money key. Value movement in
/// `splash_custody` is gated by `TreasuryCap`, and payouts from a business
/// account require an approver in that account's own set — `AdminCap` cannot
/// approve one. The cold multisig can stop a tenant and cannot spend from one.
public struct AdminCap has key, store {
    id: UID,
}

/// TreasuryCap — MONEY authority. The ONLY capability that can take value out
/// of a custodial object in `splash_custody`.
///
/// Not `sui::coin::TreasuryCap`, which mints a currency. This one spends one.
/// Different module path, and they never appear in the same signature, but the
/// collision is worth naming rather than discovering.
///
/// Before Phase 6 this was `AdminCap`, which also gated KYB verification, the
/// compliance config, guardian minting, pause and unpause, every limit change
/// and every allowlist. Auditing "who can move money" therefore meant auditing
/// thirty-odd functions across three modules and concluding that they all
/// could. Now it is a grep: `&TreasuryCap` appears five times, and
/// `scripts/check-treasury-cap.mjs` fails the build if any function taking
/// `&AdminCap` learns to split a balance.
///
/// The key ceremony changes with it. `TreasuryCap` is the cold 2-of-3 that
/// must never be online; `AdminCap` governs, and a governance action that
/// cannot move a coin does not need the same ceremony.
///
/// `store`, so it can be transferred to a multisig address.
public struct TreasuryCap has key, store {
    id: UID,
}

/// AnchorCap — hot-key authority for routine, NON-FINANCIAL attestations:
/// `audit_anchor::anchor_audit_hash`, `receipt_v2::create_receipt`,
/// `peg_monitor::update_peg`.
///
/// S-10 fix (see SECURITY.md). Those writes previously required `&AdminCap`;
/// because the peg daemon signs one every ~30s, `AdminCap` could never move to
/// the cold multisig, leaving full authority on a hot host.
///
/// Renamed from `AttestationCap` in Phase 6 alongside the split, so the four
/// caps say what they gate: govern (`AdminCap`), spend (`TreasuryCap`), attest
/// (`AnchorCap`), restrict (`ComplianceCap`).
///
/// Deliberately `key` ONLY (no `store`): it cannot be `public_transfer`red out
/// of this module, so every custody change goes through `rotate_anchor_cap` /
/// `destroy_anchor_cap` and leaves an event for off-chain monitoring.
///
/// Phase 7 added the generation. Possession is no longer authority on its own:
/// every function that accepts one checks it against `CapRegistry`, so a cap
/// from a superseded generation is dead on chain rather than merely
/// discouraged off it. That is what makes a STOLEN cap recoverable — the old
/// answer, "off-chain rejection of anchors bearing the retired id", was a hope
/// about future consumers, not a control.
public struct AnchorCap has key {
    id: UID,
    generation: u64,
}

// ─── Objects ───────────────────────────────────────────────────────────────

/// A recovery in its notice period.
public struct PendingRecovery has store, drop {
    new_owner: address,
    requested_at_ms: u64,
    effective_at_ms: u64,
}

public struct BusinessAccount has key {
    id: UID,
    /// The founding owner. Kept as a stable attribution anchor for events and
    /// for `splash_custody::delegation`, which records it on every delegation;
    /// it is NOT the authority check. Use `is_owner`.
    owner: address,
    owners: VecSet<address>,
    approvers: VecSet<address>,
    /// Set by an owner. An owner can lift it.
    frozen: bool,
    /// Set by `AdminCap`. An owner CANNOT lift it — that is the point.
    admin_frozen: bool,
    recovery_party: Option<address>,
    pending_recovery: Option<PendingRecovery>,
    /// Bumped by every membership change, freeze, unfreeze, recovery and
    /// verification withdrawal. Approvals carry the value they were minted at.
    authority_epoch: u64,
    ssm_number: String,
    kyb_cid: String,
    is_verified: bool,
    risk_score: u8,
    limit: DailyLimit,
}

/// Authority to release ONE payout, from ONE account, for ONE intent, at ONE
/// amount, for fifteen minutes, under the authority set that existed when it
/// was minted.
///
/// `key` only — no `store` — so it cannot be `public_transfer`red onward,
/// wrapped or sold. It is consumed by value on use, so it cannot be replayed.
public struct PayoutApproval has key {
    id: UID,
    account: ID,
    intent: ID,
    approver: address,
    /// The account's `authority_epoch` at the moment of approval. Compared on
    /// use; any change in between makes this approval dead.
    authority_epoch: u64,
    amount: u64,
    approved_at_ms: u64,
    expires_at_ms: u64,
}

// ─── Events ────────────────────────────────────────────────────────────────

/// WS5: the registration number and the KYB pointer stay on the object, off
/// the event stream — an event is forever, and a company number is metadata.
public struct ApplicationReceived has copy, drop {
    business_account_id: address,
    owner: address,
}

public struct BusinessUnverified has copy, drop {
    business_account_id: address,
    owner: address,
}

/// WS5: the risk score stays on the object, off the event stream.
public struct BusinessVerified has copy, drop {
    business_account_id: address,
    owner: address,
}

/// Every authority change, in one event shape, carrying the epoch it produced.
/// An off-chain watcher that sees an epoch it did not expect has seen an
/// authority change it did not initiate.
public struct AuthorityChanged has copy, drop {
    business_account_id: address,
    /// `b"add_owner"`, `b"remove_owner"`, `b"add_approver"`,
    /// `b"remove_approver"`, `b"freeze"`, `b"unfreeze"`, `b"admin_freeze"`,
    /// `b"admin_unfreeze"`, `b"recovery_party"`, `b"recovered"`,
    /// `b"verification_revoked"`.
    change: vector<u8>,
    subject: address,
    by: address,
    authority_epoch: u64,
}

public struct RecoveryRequested has copy, drop {
    business_account_id: address,
    new_owner: address,
    requested_by: address,
    effective_at_ms: u64,
}

public struct RecoveryCancelled has copy, drop {
    business_account_id: address,
    cancelled_by: address,
}

/// WS5: the ceiling is read off the object; the event says only that it moved.
public struct DailyCapChanged has copy, drop {
    business_account_id: address,
}

/// WS5: the payment's commitment where the amount used to be. The approver
/// reads the amount off the intent object they are shown; the event stream
/// gets thirty-two bytes only the Seal policy's allowlist can open.
public struct PayoutApproved has copy, drop {
    approval_id: address,
    business_account_id: address,
    intent_id: ID,
    approver: address,
    maker: address,
    commitment: vector<u8>,
    authority_epoch: u64,
    expires_at_ms: u64,
}

public struct PayoutApprovalConsumed has copy, drop {
    approval_id: address,
    business_account_id: address,
    intent_id: ID,
    approver: address,
    commitment: vector<u8>,
    consumed_at_ms: u64,
}

/// Emitted whenever anchor authority moves. Security-critical: off-chain
/// monitoring should alert on any rotation it did not initiate.
public struct AnchorCapRotated has copy, drop {
    retired_cap_id: address,
    new_cap_id: address,
    holder: address,
}

public struct AnchorCapDestroyed has copy, drop {
    anchor_cap_id: address,
}

// ─── Publish ───────────────────────────────────────────────────────────────

/// Mint exactly one of each cap, to the publisher.
///
/// The `AnchorCap` is minted HERE and nowhere else. Phase 6 deleted
/// `mint_attestation_cap`, which let `AdminCap` mint attestation authority to
/// an arbitrary address any number of times — authority created from nothing,
/// which is the inverse of every other rule in this package. Rotation is now
/// one-in-one-out through `rotate_anchor_cap`, so the number of anchor caps
/// that exist is fixed at publish and cannot be increased by anyone.
fun init(ctx: &mut TxContext) {
    let publisher = tx_context::sender(ctx);
    transfer::transfer(AdminCap { id: object::new(ctx) }, publisher);
    transfer::transfer(TreasuryCap { id: object::new(ctx) }, publisher);
    // Minted at the genesis generation. `cap_registry::init` shares the
    // registry at the same value in this same publish transaction — neither
    // module can read the other's object during `init`, so both hardcode it
    // and a test asserts they agree.
    transfer::transfer(
        AnchorCap { id: object::new(ctx), generation: cap_registry::genesis() },
        publisher,
    );
}

// ─── Application ───────────────────────────────────────────────────────────

public fun submit_application(
    ssm_number: String,
    kyb_cid: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(std::string::length(&ssm_number) > 0, E_EMPTY_SSM_NUMBER);
    assert!(std::string::length(&kyb_cid) > 0, E_EMPTY_KYB_CID);

    let owner = tx_context::sender(ctx);
    let mut owners = vec_set::empty<address>();
    owners.insert(owner);

    let account = BusinessAccount {
        id: object::new(ctx),
        owner,
        owners,
        // Deliberately EMPTY. An account that arrives with its founder already
        // able to approve their own payouts has no four-eyes rule on day one,
        // and day one is when nobody is watching.
        approvers: vec_set::empty<address>(),
        frozen: false,
        admin_frozen: false,
        recovery_party: option::none(),
        pending_recovery: option::none(),
        authority_epoch: 0,
        ssm_number,
        kyb_cid,
        is_verified: false,
        risk_score: 0,
        limit: daily_limit::new(DEFAULT_DAILY_CAP_MINOR, clock),
    };

    event::emit(ApplicationReceived {
        business_account_id: object::uid_to_address(&account.id),
        owner,
    });

    transfer::share_object(account);
}

// ─── KYB ───────────────────────────────────────────────────────────────────

public fun verify_business(_: &AdminCap, account: &mut BusinessAccount, risk_score: u8) {
    assert!(!account.is_verified, E_ALREADY_VERIFIED);
    account.is_verified = true;
    account.risk_score = risk_score;

    event::emit(BusinessVerified {
        business_account_id: object::uid_to_address(&account.id),
        owner: account.owner,
    });
}

/// Withdraw a business's verified status.
///
/// `verify_business` asserts `!is_verified` and there was no inverse anywhere
/// in the package, so an account verified on mainnet was verified FOREVER. For
/// a licensed e-money issuer that is a compliance defect standing on its own.
///
/// Deliberately resets `risk_score` to 0 as well — leaving a stale score on an
/// unverified account invites a later reader to treat it as still assessed —
/// and bumps the authority epoch, so approvals already in flight against this
/// account die with the verification rather than settling after it.
public fun revoke_verification(_: &AdminCap, account: &mut BusinessAccount, ctx: &TxContext) {
    assert!(account.is_verified, E_NOT_VERIFIED_YET);
    account.is_verified = false;
    account.risk_score = 0;
    let founder = account.owner;
    bump(account, b"verification_revoked", founder, ctx);

    event::emit(BusinessUnverified {
        business_account_id: object::uid_to_address(&account.id),
        owner: account.owner,
    });
}

// ─── Membership ────────────────────────────────────────────────────────────

/// Every authority change goes through here, so no path can change membership
/// without invalidating in-flight approvals. A change that forgets to bump is
/// a change that lets a revoked approver's signature still settle.
fun bump(account: &mut BusinessAccount, change: vector<u8>, subject: address, ctx: &TxContext) {
    account.authority_epoch = account.authority_epoch + 1;
    event::emit(AuthorityChanged {
        business_account_id: object::uid_to_address(&account.id),
        change,
        subject,
        by: tx_context::sender(ctx),
        authority_epoch: account.authority_epoch,
    });
}

fun assert_owner(account: &BusinessAccount, ctx: &TxContext) {
    assert!(account.owners.contains(&tx_context::sender(ctx)), E_NOT_AN_OWNER);
}

/// Membership cannot change while the account is stopped.
///
/// Without this, an owner watching a freeze land could add a fresh approver
/// address and be ready the moment it lifts — and a compliance freeze is
/// exactly the situation where the people with owner keys may be the problem.
fun assert_thawed(account: &BusinessAccount) {
    assert!(!account.frozen && !account.admin_frozen, E_FROZEN);
}

public fun add_owner(account: &mut BusinessAccount, who: address, ctx: &TxContext) {
    assert_owner(account, ctx);
    assert_thawed(account);
    assert!(who != @0x0, E_INVALID_ADDRESS);
    assert!(!account.owners.contains(&who), E_ALREADY_A_MEMBER);
    assert!(account.owners.length() < MAX_MEMBERS, E_TOO_MANY_MEMBERS);
    // An address that is already the nominated recovery party cannot also be
    // an owner; see `set_recovery_party`.
    assert!(!is_recovery_party(account, who), E_RECOVERY_IS_INSIDER);

    account.owners.insert(who);
    bump(account, b"add_owner", who, ctx);
}

/// Remove an owner.
///
/// The FOUNDING owner (`account.owner`) can only be removed by themselves.
///
/// Without that rule, one compromised owner key is a complete account
/// takeover: remove every co-owner, add two addresses you control as
/// approvers, and the four-eyes check is satisfied by two halves of the same
/// person. The 24h ceiling bounds what that is worth and `admin_freeze` stops
/// it — but both of those are recovery, and this is prevention. Pinning the
/// founder means a co-owner compromise leaves someone standing who can freeze,
/// revoke and re-grant.
///
/// It is not symmetric and cannot be: if the FOUNDER's key is the compromised
/// one, they can still remove everyone else. Something has to be the anchor.
/// Choosing the address that opened the account — the one the KYB file is
/// against — makes the anchor the party the licence already knows.
public fun remove_owner(account: &mut BusinessAccount, who: address, ctx: &TxContext) {
    assert_owner(account, ctx);
    assert_thawed(account);
    assert!(account.owners.contains(&who), E_NOT_A_MEMBER);
    // The last owner cannot remove themselves. An account with no owners has no
    // path back except the recovery party, and `recovery_party` is optional.
    assert!(account.owners.length() > 1, E_LAST_OWNER);
    assert!(who != account.owner || tx_context::sender(ctx) == account.owner, E_NOT_AN_OWNER);

    account.owners.remove(&who);
    bump(account, b"remove_owner", who, ctx);
}

public fun add_approver(account: &mut BusinessAccount, who: address, ctx: &TxContext) {
    assert_owner(account, ctx);
    assert_thawed(account);
    assert!(who != @0x0, E_INVALID_ADDRESS);
    assert!(!account.approvers.contains(&who), E_ALREADY_A_MEMBER);
    assert!(account.approvers.length() < MAX_MEMBERS, E_TOO_MANY_MEMBERS);
    assert!(!is_recovery_party(account, who), E_RECOVERY_IS_INSIDER);

    account.approvers.insert(who);
    bump(account, b"add_approver", who, ctx);
}

/// Remove an approver. THIS is the revocation that must kill work in flight.
///
/// The bump does it: an approval carries the epoch it was minted at, and this
/// increments it. Re-granting the same address increments AGAIN, so the
/// revoke-then-regrant sequence does not resurrect the approval that was live
/// across it — which a "is this address currently an approver?" check would.
public fun remove_approver(account: &mut BusinessAccount, who: address, ctx: &TxContext) {
    assert_owner(account, ctx);
    // Deliberately callable while frozen, unlike every other membership
    // change: removing authority is always safe, and a freeze is exactly when
    // you most want to strip a compromised approver.
    assert!(account.approvers.contains(&who), E_NOT_A_MEMBER);

    account.approvers.remove(&who);
    bump(account, b"remove_approver", who, ctx);
}

// ─── Freeze ────────────────────────────────────────────────────────────────

/// Owner-initiated stop. Any owner can set it, any owner can lift it.
public fun freeze_account(account: &mut BusinessAccount, ctx: &TxContext) {
    assert_owner(account, ctx);
    assert!(!account.frozen, E_FROZEN);
    account.frozen = true;
    bump(account, b"freeze", tx_context::sender(ctx), ctx);
}

public fun unfreeze_account(account: &mut BusinessAccount, ctx: &TxContext) {
    assert_owner(account, ctx);
    assert!(account.frozen, E_NOT_FROZEN);
    // Note what this does NOT clear: `admin_frozen`. An owner lifting their own
    // freeze must not lift a compliance one.
    account.frozen = false;
    bump(account, b"unfreeze", tx_context::sender(ctx), ctx);
}

/// Compliance stop. Separate flag, `AdminCap`-only in both directions, so an
/// owner cannot lift it by lifting their own.
public fun admin_freeze(_: &AdminCap, account: &mut BusinessAccount, ctx: &TxContext) {
    assert!(!account.admin_frozen, E_FROZEN);
    account.admin_frozen = true;
    let founder = account.owner;
    bump(account, b"admin_freeze", founder, ctx);
}

public fun admin_unfreeze(_: &AdminCap, account: &mut BusinessAccount, ctx: &TxContext) {
    assert!(account.admin_frozen, E_NOT_FROZEN);
    account.admin_frozen = false;
    let founder = account.owner;
    bump(account, b"admin_unfreeze", founder, ctx);
}

// ─── Recovery ──────────────────────────────────────────────────────────────

fun is_recovery_party(account: &BusinessAccount, who: address): bool {
    account.recovery_party.is_some() && *account.recovery_party.borrow() == who
}

/// Nominate an outsider who can restore access if the owner keys are lost.
///
/// They must not already be an owner or an approver. A recovery party drawn
/// from the same set of people is not a recovery path, it is a second copy of
/// the same failure.
public fun set_recovery_party(account: &mut BusinessAccount, who: address, ctx: &TxContext) {
    assert_owner(account, ctx);
    assert_thawed(account);
    assert!(who != @0x0, E_INVALID_ADDRESS);
    assert!(!account.owners.contains(&who), E_RECOVERY_IS_INSIDER);
    assert!(!account.approvers.contains(&who), E_RECOVERY_IS_INSIDER);
    // Changing the nominee while a recovery is running would let an owner swap
    // in their own address mid-notice and execute immediately.
    assert!(account.pending_recovery.is_none(), E_RECOVERY_PENDING);

    account.recovery_party = option::some(who);
    bump(account, b"recovery_party", who, ctx);
}

/// Begin a recovery. Recovery party only, and it does not take effect for 72
/// hours, during which any owner can cancel it.
public fun request_recovery(
    account: &mut BusinessAccount,
    new_owner: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(account.recovery_party.is_some(), E_NO_RECOVERY_PARTY);
    assert!(is_recovery_party(account, tx_context::sender(ctx)), E_NOT_RECOVERY_PARTY);
    assert!(account.pending_recovery.is_none(), E_RECOVERY_PENDING);
    assert!(new_owner != @0x0, E_INVALID_ADDRESS);
    assert!(!account.owners.contains(&new_owner), E_ALREADY_A_MEMBER);

    let now = clock::timestamp_ms(clock);
    let effective_at_ms = now + RECOVERY_DELAY_MS;
    account.pending_recovery = option::some(PendingRecovery {
        new_owner,
        requested_at_ms: now,
        effective_at_ms,
    });

    event::emit(RecoveryRequested {
        business_account_id: object::uid_to_address(&account.id),
        new_owner,
        requested_by: tx_context::sender(ctx),
        effective_at_ms,
    });
}

/// Cancel a running recovery. Any owner — this is what makes the notice period
/// a defence rather than a countdown — or the recovery party, who may simply
/// have made a mistake.
public fun cancel_recovery(account: &mut BusinessAccount, ctx: &TxContext) {
    let caller = tx_context::sender(ctx);
    assert!(
        account.owners.contains(&caller) || is_recovery_party(account, caller),
        E_NOT_AN_OWNER,
    );
    assert!(account.pending_recovery.is_some(), E_NO_PENDING_RECOVERY);

    let _ = account.pending_recovery.extract();
    event::emit(RecoveryCancelled {
        business_account_id: object::uid_to_address(&account.id),
        cancelled_by: caller,
    });
}

/// Execute a matured recovery.
///
/// It ADDS an owner. It does not remove the existing ones, and it does not
/// transfer the account. That asymmetry is the containment: a hostile recovery
/// party who waits out the notice gets co-ownership, not the company, and the
/// surviving owners can remove them the moment it lands. If the owner keys are
/// genuinely lost there is nobody left to remove, and adding is all that was
/// needed.
///
/// Approvers are cleared, because a recovery means the account's people have
/// changed and every existing release authority should be re-granted
/// deliberately rather than inherited.
public fun execute_recovery(account: &mut BusinessAccount, clock: &Clock, ctx: &TxContext) {
    assert!(is_recovery_party(account, tx_context::sender(ctx)), E_NOT_RECOVERY_PARTY);
    assert!(account.pending_recovery.is_some(), E_NO_PENDING_RECOVERY);
    assert!(
        clock::timestamp_ms(clock) >= account.pending_recovery.borrow().effective_at_ms,
        E_RECOVERY_NOT_DUE,
    );
    assert!(account.owners.length() < MAX_MEMBERS, E_TOO_MANY_MEMBERS);

    let new_owner = account.pending_recovery.borrow().new_owner;
    // If the surviving owners added this address themselves during the notice
    // period, the recovery has already happened and there is nothing to do.
    // Aborting rather than proceeding matters: `execute_recovery` also clears
    // the approver set, and a rescuer who can force that on an account that
    // did not need rescuing holds a 72-hour delayed denial-of-service.
    assert!(!account.owners.contains(&new_owner), E_ALREADY_A_MEMBER);

    let _ = account.pending_recovery.extract();
    account.owners.insert(new_owner);
    account.approvers = vec_set::empty<address>();

    bump(account, b"recovered", new_owner, ctx);
}

// ─── The ceiling ───────────────────────────────────────────────────────────

/// Set this account's 24h payout ceiling, in the settled coin's minor units.
///
/// `AdminCap`-gated because it is a KYB-tier decision, not a tenant one — an
/// account that could raise its own ceiling does not have one. Raising does not
/// forgive spend already inside the window (see `daily_limit::set_cap`), so
/// "raise, drain, lower" moves no more than "raise and drain".
public fun set_daily_cap(_: &AdminCap, account: &mut BusinessAccount, cap_minor: u64) {
    daily_limit::set_cap(&mut account.limit, cap_minor);
    event::emit(DailyCapChanged {
        business_account_id: object::uid_to_address(&account.id),
    });
}

// ─── Approval ──────────────────────────────────────────────────────────────

/// Mint one approval: one account, one intent, one amount, fifteen minutes.
///
/// `public(package)`, and the only caller is `payment_intent::approve_payout`.
/// That indirection is the point. This module cannot import `payment_intent`
/// (that module imports this one, and Move forbids the cycle), so an approval
/// minted here could only ever be bound to an intent id and an amount the
/// CALLER supplied — and an approver who is handed a PTB has no way to check
/// that the amount beside the id is the amount in the intent.
///
/// Moving the entry point into `payment_intent`, which can see both objects,
/// makes the amount and the maker DERIVED from the intent rather than asserted
/// about it. The mismatch is then unrepresentable instead of merely checked.
public(package) fun mint_approval(
    account: &BusinessAccount,
    intent: ID,
    maker: address,
    amount: u64,
    commitment: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let approver = tx_context::sender(ctx);
    assert!(account.approvers.contains(&approver), E_NOT_AN_APPROVER);
    assert!(account.is_verified, E_NOT_VERIFIED);
    assert!(!account.frozen && !account.admin_frozen, E_FROZEN);
    assert!(amount > 0, E_AMOUNT_MISMATCH);
    assert!(maker != @0x0, E_INVALID_ADDRESS);
    assert!(maker != approver, E_SELF_APPROVAL);

    let now = clock::timestamp_ms(clock);
    let approval = PayoutApproval {
        id: object::new(ctx),
        account: object::id(account),
        intent,
        approver,
        authority_epoch: account.authority_epoch,
        amount,
        approved_at_ms: now,
        expires_at_ms: now + APPROVAL_TTL_MS,
    };

    event::emit(PayoutApproved {
        approval_id: object::uid_to_address(&approval.id),
        business_account_id: object::uid_to_address(&account.id),
        intent_id: intent,
        approver,
        maker,
        commitment,
        authority_epoch: approval.authority_epoch,
        expires_at_ms: approval.expires_at_ms,
    });

    transfer::transfer(approval, maker);
}

/// Consume an approval and charge the account's window.
///
/// `public(package)` so that `payment_intent` — which holds the coin and the
/// intent — is the only caller. Exposing this publicly would let anyone burn a
/// tenant's daily allowance by consuming approvals without settling anything.
///
/// Every check here is a check something else could have been trusted to do,
/// and is not:
///   * the account, so an approval for tenant A cannot release tenant B's money
///   * the intent, so an approval for a $10 invoice cannot release a $10,000 one
///   * the amount, for the same reason, independently of the intent id
///   * the epoch, so a revoked approver's approval is dead even though the
///     object still exists in their counterparty's wallet
///   * membership again, which the epoch already implies — kept because a
///     future membership path that forgets to bump would otherwise be silently
///     exploitable
///   * expiry, verification, and both freeze flags
public(package) fun consume_approval(
    account: &mut BusinessAccount,
    approval: PayoutApproval,
    intent: ID,
    amount: u64,
    commitment: vector<u8>,
    clock: &Clock,
) {
    assert!(approval.account == object::id(account), E_WRONG_ACCOUNT);
    assert!(approval.intent == intent, E_WRONG_INTENT);
    assert!(approval.amount == amount, E_AMOUNT_MISMATCH);
    assert!(approval.authority_epoch == account.authority_epoch, E_STALE_AUTHORITY);
    assert!(account.approvers.contains(&approval.approver), E_NOT_AN_APPROVER);
    assert!(clock::timestamp_ms(clock) < approval.expires_at_ms, E_APPROVAL_EXPIRED);
    assert!(account.is_verified, E_NOT_VERIFIED);
    assert!(!account.frozen && !account.admin_frozen, E_FROZEN);

    daily_limit::charge(&mut account.limit, amount, clock);

    let PayoutApproval {
        id,
        account: account_id,
        intent: intent_id,
        approver,
        authority_epoch: _,
        amount: _,
        approved_at_ms: _,
        expires_at_ms: _,
    } = approval;

    event::emit(PayoutApprovalConsumed {
        approval_id: object::uid_to_address(&id),
        business_account_id: object::id_to_address(&account_id),
        intent_id,
        approver,
        commitment,
        consumed_at_ms: clock::timestamp_ms(clock),
    });
    object::delete(id);
}

/// Discard an approval that was never used. Callable by whoever holds it,
/// which is the maker — an unused approval is otherwise an owned object that
/// lives forever.
public fun discard_approval(approval: PayoutApproval) {
    let PayoutApproval {
        id,
        account: _,
        intent: _,
        approver: _,
        authority_epoch: _,
        amount: _,
        approved_at_ms: _,
        expires_at_ms: _,
    } = approval;
    object::delete(id);
}

// ─── Anchor cap custody ────────────────────────────────────────────────────

/// Rotate anchor authority: one cap in, one cap out.
///
/// This replaces `mint_attestation_cap`, which took an `AdminCap` and a
/// destination address and created authority from nothing, any number of
/// times. Consuming the retired cap conserves the count, so the cold multisig
/// can MOVE anchor authority and can never manufacture a second concurrent
/// holder.
///
/// The honest cost: if the live cap is LOST rather than rotated, anchoring is
/// bricked and this function cannot help, because there is no old cap to
/// consume. That recovery is Phase 7's break-glass and is not built yet — it
/// is the reason this package must not be published as immutable until Phase 7
/// lands.
public fun rotate_anchor_cap(
    _: &AdminCap,
    retired: AnchorCap,
    holder: address,
    ctx: &mut TxContext,
) {
    assert!(holder != @0x0, E_INVALID_HOLDER);

    // The generation is CARRIED, not bumped. This is a custody move — the
    // operator is handing the cap to a new host — and bumping here would
    // revoke nothing that is not already being consumed.
    let AnchorCap { id: retired_id, generation } = retired;
    let fresh = AnchorCap { id: object::new(ctx), generation };

    event::emit(AnchorCapRotated {
        retired_cap_id: object::uid_to_address(&retired_id),
        new_cap_id: object::uid_to_address(&fresh.id),
        holder,
    });

    object::delete(retired_id);
    transfer::transfer(fresh, holder);
}

/// Burn an `AnchorCap` without replacing it. Callable by its holder.
///
/// Note honestly what this is NOT: it cannot claw back a *stolen* cap, since
/// the thief simply never calls this. Containment for a stolen anchor cap is
/// (a) it can move no funds by construction, and (b) off-chain rejection of
/// anchors bearing the retired cap id. See the key-ceremony runbook.
public fun destroy_anchor_cap(cap: AnchorCap) {
    let AnchorCap { id, generation: _ } = cap;
    event::emit(AnchorCapDestroyed {
        anchor_cap_id: object::uid_to_address(&id),
    });
    object::delete(id);
}

/// BREAK-GLASS. Revoke every outstanding `AnchorCap` and mint one replacement.
///
/// This is the answer to the two holes Phase 6 left open and named: a cap that
/// is LOST (so `rotate_anchor_cap` has nothing to consume) and a cap that is
/// STOLEN (so its holder will never destroy it). Both are the same operation —
/// the old cap's generation stops being current, so it stops working, whether
/// it is at the bottom of a river or in a thief's wallet.
///
/// It does not restore the arbitrary minting Phase 6 deleted. The bump that
/// creates this capability is the same bump that kills the previous one, in one
/// transaction, so there is still never a second concurrent holder.
///
/// There is no delay, and `cap_registry`'s module comment argues that at
/// length: a delay would protect against an `AdminCap` that already holds
/// strictly more authority than the cap being rotated, and would hand a thief
/// a window.
///
/// Operational cost, which is real: the operator server's cap dies the instant
/// this lands, and anchoring fails until the new object id is deployed. The
/// `CapabilityRevoked` event is the signal. See the key-ceremony runbook.
public fun break_glass_anchor_cap(
    _: &AdminCap,
    registry: &mut CapRegistry,
    holder: address,
    reason: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(holder != @0x0, E_INVALID_HOLDER);
    let generation = cap_registry::bump(registry, cap_registry::kind_anchor(), holder, reason, ctx);
    transfer::transfer(AnchorCap { id: object::new(ctx), generation }, holder);
}

/// The check every consumer of an `AnchorCap` must make.
///
/// `scripts/check-cap-generations.mjs` fails the build if a function takes
/// `&AnchorCap` without calling this — because a single consumer that forgets
/// is a hole through which a revoked cap keeps working, and it would be found
/// by an incident rather than by a build.
public fun assert_anchor_cap(registry: &CapRegistry, cap: &AnchorCap) {
    cap_registry::assert_current(registry, cap_registry::kind_anchor(), cap.generation);
}

public fun anchor_cap_generation(cap: &AnchorCap): u64 { cap.generation }

// ─── Views ─────────────────────────────────────────────────────────────────

public fun owner(account: &BusinessAccount): address { account.owner }
public fun owners(account: &BusinessAccount): vector<address> { *account.owners.keys() }
public fun approvers(account: &BusinessAccount): vector<address> { *account.approvers.keys() }
public fun is_owner(account: &BusinessAccount, who: address): bool { account.owners.contains(&who) }
public fun is_approver(account: &BusinessAccount, who: address): bool {
    account.approvers.contains(&who)
}
public fun is_frozen(account: &BusinessAccount): bool { account.frozen || account.admin_frozen }
public fun frozen_by_owner(account: &BusinessAccount): bool { account.frozen }
public fun frozen_by_admin(account: &BusinessAccount): bool { account.admin_frozen }
public fun authority_epoch(account: &BusinessAccount): u64 { account.authority_epoch }
public fun recovery_party(account: &BusinessAccount): Option<address> { account.recovery_party }
public fun has_pending_recovery(account: &BusinessAccount): bool {
    account.pending_recovery.is_some()
}
public fun recovery_effective_at_ms(account: &BusinessAccount): u64 {
    account.pending_recovery.borrow().effective_at_ms
}
public fun ssm_number(account: &BusinessAccount): &String { &account.ssm_number }
public fun kyb_cid(account: &BusinessAccount): &String { &account.kyb_cid }
public fun is_verified(account: &BusinessAccount): bool { account.is_verified }
public fun risk_score(account: &BusinessAccount): u8 { account.risk_score }
public fun daily_cap_minor(account: &BusinessAccount): u64 {
    daily_limit::cap_minor(&account.limit)
}
public fun daily_spent(account: &BusinessAccount, clock: &Clock): u64 {
    daily_limit::spent(&account.limit, clock)
}
public fun daily_remaining(account: &BusinessAccount, clock: &Clock): u64 {
    daily_limit::remaining(&account.limit, clock)
}
public fun default_daily_cap_minor(): u64 { DEFAULT_DAILY_CAP_MINOR }
public fun max_members(): u64 { MAX_MEMBERS }
public fun approval_ttl_ms(): u64 { APPROVAL_TTL_MS }
public fun recovery_delay_ms(): u64 { RECOVERY_DELAY_MS }

public fun approval_account(approval: &PayoutApproval): ID { approval.account }
public fun approval_intent(approval: &PayoutApproval): ID { approval.intent }
public fun approval_approver(approval: &PayoutApproval): address { approval.approver }
public fun approval_amount(approval: &PayoutApproval): u64 { approval.amount }
public fun approval_epoch(approval: &PayoutApproval): u64 { approval.authority_epoch }
public fun approval_expires_at_ms(approval: &PayoutApproval): u64 { approval.expires_at_ms }

// ─── Test helpers ──────────────────────────────────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

#[test_only]
public fun admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx) }
}

#[test_only]
public fun treasury_cap_for_testing(ctx: &mut TxContext): TreasuryCap {
    TreasuryCap { id: object::new(ctx) }
}

#[test_only]
public fun destroy_treasury_cap_for_testing(cap: TreasuryCap) {
    let TreasuryCap { id } = cap;
    object::delete(id);
}

#[test_only]
public fun anchor_cap_for_testing(ctx: &mut TxContext): AnchorCap {
    AnchorCap { id: object::new(ctx), generation: cap_registry::genesis() }
}

#[test_only]
public fun anchor_cap_at_generation_for_testing(generation: u64, ctx: &mut TxContext): AnchorCap {
    AnchorCap { id: object::new(ctx), generation }
}

#[test_only]
public fun destroy_admin_cap_for_testing(cap: AdminCap) {
    let AdminCap { id } = cap;
    object::delete(id);
}

#[test_only]
public fun consume_approval_for_testing(
    account: &mut BusinessAccount,
    approval: PayoutApproval,
    intent: ID,
    amount: u64,
    commitment: vector<u8>,
    clock: &Clock,
) {
    consume_approval(account, approval, intent, amount, commitment, clock)
}

#[test_only]
public fun unpack_payout_approved_for_testing(
    e: PayoutApproved,
): (address, address, ID, address, address, vector<u8>, u64, u64) {
    let PayoutApproved {
        approval_id,
        business_account_id,
        intent_id,
        approver,
        maker,
        commitment,
        authority_epoch,
        expires_at_ms,
    } = e;
    (approval_id, business_account_id, intent_id, approver, maker, commitment, authority_epoch, expires_at_ms)
}

#[test_only]
public fun unpack_payout_approval_consumed_for_testing(
    e: PayoutApprovalConsumed,
): (address, address, ID, address, vector<u8>, u64) {
    let PayoutApprovalConsumed {
        approval_id,
        business_account_id,
        intent_id,
        approver,
        commitment,
        consumed_at_ms,
    } = e;
    (approval_id, business_account_id, intent_id, approver, commitment, consumed_at_ms)
}
