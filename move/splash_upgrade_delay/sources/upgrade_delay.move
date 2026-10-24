/// A 24-hour delay between proposing an upgrade and being able to run it.
///
/// `splash_core`'s `UpgradeCap` goes into a `DelayedUpgradeCap` and never comes
/// out. From then on the only way to upgrade is:
///
///   1. `propose(digest)` — records the digest of the new bytecode and the time,
///      in `pending`, and emits `UpgradeProposed`. The backend reads `pending`
///      and alerts every business owner with the bytecode digest, the policy
///      and when it can take effect, plus a link to review their spending
///      rules and revoke allowances.
///   2. wait 24 hours.
///   3. `authorize_upgrade(digest)` — only for the digest proposed, only once
///      the delay has passed and within seven days of it. The validators then
///      check the upgrade's bytecode against that digest and its changes
///      against the stored policy.
///   4. `commit_upgrade(receipt)`.
///
/// ─── Who can call it ────────────────────────────────────────────────────────
///
/// `DelayedUpgradeCap` is an OWNED object, kept by the governance multisig
/// that wrapped it, and `wrap` proves on chain that this sender is a multisig
/// no single member can sign for. The protocol only lets an owned object into
/// a transaction its owner signed, so possession is the authorisation. It is
/// `key` only, with no `store`, so it cannot be wrapped into anything else or
/// `public_transfer`red. The one way it moves is `complete_owner_change`, to a
/// new governance multisig, behind the same 24-hour notice.
///
/// ─── What it refuses to do ──────────────────────────────────────────────────
///
/// There is no function that unwraps the cap, shortens the delay, or makes the
/// policy more permissive than additive. The package publishes immutable, so
/// none can be added. `only_dep_upgrades` and `make_immutable` are allowed at
/// any time, because they can only take power away.
module splash_upgrade_delay::upgrade_delay;

use splash_core::multisig;
use sui::clock::Clock;
use sui::event;
use sui::package::{Self, UpgradeCap, UpgradeReceipt, UpgradeTicket};

// ─── Abort codes ───────────────────────────────────────────────────────────
/// A digest is the 32-byte hash the build tool prints for the new bytecode.
const E_BAD_DIGEST: u64 = 1100;
/// A proposal is already pending. Cancel it first, so every proposal owners
/// are alerted to starts its own full delay.
const E_ALREADY_PROPOSED: u64 = 1101;
/// There is no proposal to authorise or cancel.
const E_NOTHING_PROPOSED: u64 = 1102;
/// The digest to authorise is not the digest that was proposed.
const E_DIGEST_MISMATCH: u64 = 1103;
/// The 24-hour notice has not run yet.
const E_TOO_EARLY: u64 = 1104;
/// The new owner would be a multisig a single member can sign for.
const E_INVALID_OWNER: u64 = 1105;
/// The cap is mid-upgrade (authorised, not yet committed).
const E_UPGRADE_IN_PROGRESS: u64 = 1106;
/// The proposal's window closed seven days after its notice ran. Propose it
/// again, so owners are alerted again.
const E_PROPOSAL_LAPSED: u64 = 1107;
/// The cap has already been used for an upgrade outside this wrapper.
const E_CAP_ALREADY_USED: u64 = 1108;

// ─── Constants ─────────────────────────────────────────────────────────────
/// Twenty-four hours, in milliseconds. A constant in an immutable package.
const DELAY_MS: u64 = 86_400_000;
/// Seven days after the notice runs, an unused proposal lapses.
const WINDOW_MS: u64 = 604_800_000;
const DIGEST_BYTES: u64 = 32;

public struct DelayedUpgradeCap has key {
    id: UID,
    cap: UpgradeCap,
    /// The package's ORIGINAL id, recorded at `wrap` (version 1, so the cap's
    /// package is the original). Every event names the package by this, which
    /// never changes, so a listener filtering on it still sees the second
    /// upgrade and every one after.
    original_package: ID,
    pending: Option<Proposal>,
    pending_owner: Option<OwnerChange>,
}

public struct Proposal has store, drop {
    digest: vector<u8>,
    proposed_at_ms: u64,
    eta_ms: u64,
}

public struct OwnerChange has store, drop {
    new_owner: address,
    eta_ms: u64,
}

// ─── Events ────────────────────────────────────────────────────────────────

/// The event every business owner is alerted to.
public struct UpgradeProposed has copy, drop {
    wrapper_id: ID,
    package: ID,
    digest: vector<u8>,
    proposed_at_ms: u64,
    eta_ms: u64,
    policy: u8,
}

public struct UpgradeCancelled has copy, drop {
    wrapper_id: ID,
    package: ID,
    digest: vector<u8>,
}

/// Owners are alerted again when the upgrade is actually authorised.
public struct UpgradeAuthorized has copy, drop {
    wrapper_id: ID,
    package: ID,
    digest: vector<u8>,
    policy: u8,
}

public struct UpgradeCommitted has copy, drop {
    wrapper_id: ID,
    package: ID,
    /// The id of the package version just committed.
    latest_package: ID,
    version: u64,
}

public struct CapWrapped has copy, drop {
    wrapper_id: ID,
    package: ID,
    owner: address,
    policy: u8,
}

public struct OwnerChangeProposed has copy, drop {
    wrapper_id: ID,
    new_owner: address,
    eta_ms: u64,
}

public struct OwnerChangeCancelled has copy, drop {
    wrapper_id: ID,
    new_owner: address,
}

public struct OwnerChanged has copy, drop {
    wrapper_id: ID,
    new_owner: address,
}

public struct MadeImmutable has copy, drop {
    wrapper_id: ID,
    package: ID,
}

// ─── Wrapping ──────────────────────────────────────────────────────────────

/// Put an `UpgradeCap` behind the delay, for ever, kept by the sender.
///
/// The sender must be the governance multisig itself, proved by its members
/// (`multisig::assert_quorum_sender`): the publisher first transfers the cap
/// to it, and it signs this. A typo in an `owner` argument cannot strand the
/// cap, because there is no such argument.
///
/// The cap must be unused (version 1), so the wrapper's history is the
/// package's whole history. The policy is tightened to additive if it is any
/// looser: the "set the core upgrade policy to additive before wrapping" step,
/// done in the same call rather than trusted to have happened. A cap that is
/// already stricter (dependency-only) keeps its stricter policy.
public fun wrap(
    mut cap: UpgradeCap,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    ctx: &mut TxContext,
) {
    multisig::assert_quorum_sender(&keys, &weights, threshold, ctx);
    assert!(package::upgrade_package(&cap) != @0x0.to_id(), E_UPGRADE_IN_PROGRESS);
    assert!(package::version(&cap) == 1, E_CAP_ALREADY_USED);
    if (package::upgrade_policy(&cap) < package::additive_policy()) {
        package::only_additive_upgrades(&mut cap);
    };

    let owner = ctx.sender();
    let original_package = package::upgrade_package(&cap);
    let wrapper = DelayedUpgradeCap {
        id: object::new(ctx),
        cap,
        original_package,
        pending: option::none(),
        pending_owner: option::none(),
    };
    event::emit(CapWrapped {
        wrapper_id: object::id(&wrapper),
        package: original_package,
        owner,
        policy: package::upgrade_policy(&wrapper.cap),
    });
    transfer::transfer(wrapper, owner);
}

// ─── The delay ─────────────────────────────────────────────────────────────

/// Announce an upgrade. It can run no sooner than 24 hours from now, and no
/// later than eight days from now.
public fun propose(self: &mut DelayedUpgradeCap, digest: vector<u8>, clock: &Clock) {
    assert!(digest.length() == DIGEST_BYTES, E_BAD_DIGEST);
    assert!(self.pending.is_none(), E_ALREADY_PROPOSED);
    assert!(package::upgrade_package(&self.cap) != @0x0.to_id(), E_UPGRADE_IN_PROGRESS);
    let package = self.original_package;

    let now = clock.timestamp_ms();
    let eta_ms = now + DELAY_MS;
    self.pending = option::some(Proposal { digest, proposed_at_ms: now, eta_ms });

    event::emit(UpgradeProposed {
        wrapper_id: object::id(self),
        package,
        digest,
        proposed_at_ms: now,
        eta_ms,
        policy: package::upgrade_policy(&self.cap),
    });
}

/// Withdraw a pending proposal, lapsed or not.
public fun cancel(self: &mut DelayedUpgradeCap) {
    assert!(self.pending.is_some(), E_NOTHING_PROPOSED);
    let Proposal { digest, proposed_at_ms: _, eta_ms: _ } = self.pending.extract();
    event::emit(UpgradeCancelled {
        wrapper_id: object::id(self),
        package: self.original_package,
        digest,
    });
}

/// Authorise the proposed upgrade, once its notice has run and before its
/// window closes.
///
/// The ticket carries the stored policy, never a looser one, and the digest
/// that was announced, so the bytecode that runs is the bytecode owners were
/// told about. The proposal is consumed: one notice, one upgrade.
public fun authorize_upgrade(
    self: &mut DelayedUpgradeCap,
    digest: vector<u8>,
    clock: &Clock,
): UpgradeTicket {
    assert!(self.pending.is_some(), E_NOTHING_PROPOSED);
    assert!(self.pending.borrow().digest == digest, E_DIGEST_MISMATCH);
    let now = clock.timestamp_ms();
    let eta_ms = self.pending.borrow().eta_ms;
    assert!(now >= eta_ms, E_TOO_EARLY);
    assert!(now < eta_ms + WINDOW_MS, E_PROPOSAL_LAPSED);

    let _ = self.pending.extract();
    let package = self.original_package;
    let policy = package::upgrade_policy(&self.cap);
    event::emit(UpgradeAuthorized { wrapper_id: object::id(self), package, digest, policy });
    package::authorize_upgrade(&mut self.cap, policy, digest)
}

/// Finish an upgrade the validators ran.
public fun commit_upgrade(self: &mut DelayedUpgradeCap, receipt: UpgradeReceipt) {
    package::commit_upgrade(&mut self.cap, receipt);
    event::emit(UpgradeCommitted {
        wrapper_id: object::id(self),
        package: self.original_package,
        latest_package: package::upgrade_package(&self.cap),
        version: package::version(&self.cap),
    });
}

// ─── Moving to a new governance multisig ───────────────────────────────────

/// Announce a move to a new governance multisig.
///
/// A multisig's address is the hash of its members, so replacing a lost or
/// compromised governance key means a new address, and the wrapper must be
/// able to follow. The new owner is named by its members, and must be a
/// multisig no single member can sign for. The move gives the same 24-hour
/// notice as an upgrade, because whoever holds the wrapper can upgrade.
public fun propose_owner_change(
    self: &mut DelayedUpgradeCap,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    clock: &Clock,
) {
    assert!(self.pending_owner.is_none(), E_ALREADY_PROPOSED);
    assert!(!multisig::is_single_signer(&weights, threshold), E_INVALID_OWNER);
    let new_owner = multisig::derive_address(&keys, &weights, threshold);
    let eta_ms = clock.timestamp_ms() + DELAY_MS;
    self.pending_owner = option::some(OwnerChange { new_owner, eta_ms });
    event::emit(OwnerChangeProposed { wrapper_id: object::id(self), new_owner, eta_ms });
}

public fun cancel_owner_change(self: &mut DelayedUpgradeCap) {
    assert!(self.pending_owner.is_some(), E_NOTHING_PROPOSED);
    let OwnerChange { new_owner, eta_ms: _ } = self.pending_owner.extract();
    event::emit(OwnerChangeCancelled { wrapper_id: object::id(self), new_owner });
}

/// Hand the wrapper to the announced new owner, once the notice has run and
/// before its window closes.
public fun complete_owner_change(mut self: DelayedUpgradeCap, clock: &Clock) {
    assert!(self.pending_owner.is_some(), E_NOTHING_PROPOSED);
    let now = clock.timestamp_ms();
    let eta_ms = self.pending_owner.borrow().eta_ms;
    assert!(now >= eta_ms, E_TOO_EARLY);
    assert!(now < eta_ms + WINDOW_MS, E_PROPOSAL_LAPSED);

    let OwnerChange { new_owner, eta_ms: _ } = self.pending_owner.extract();
    event::emit(OwnerChanged { wrapper_id: object::id(&self), new_owner });
    transfer::transfer(self, new_owner);
}

// ─── Taking power away (no notice needed) ──────────────────────────────────

/// Restrict future upgrades to dependency changes only.
public fun only_dep_upgrades(self: &mut DelayedUpgradeCap) {
    package::only_dep_upgrades(&mut self.cap);
}

/// End upgrades for good.
public fun make_immutable(self: DelayedUpgradeCap) {
    let DelayedUpgradeCap { id, cap, original_package, pending: _, pending_owner: _ } = self;
    event::emit(MadeImmutable { wrapper_id: id.to_inner(), package: original_package });
    id.delete();
    package::make_immutable(cap);
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun delay_ms(): u64 { DELAY_MS }
public fun window_ms(): u64 { WINDOW_MS }
/// The package's original id: what every event names it by.
public fun package_id(self: &DelayedUpgradeCap): ID { self.original_package }
/// The id of the package's current version.
public fun latest_package_id(self: &DelayedUpgradeCap): ID { package::upgrade_package(&self.cap) }
public fun version(self: &DelayedUpgradeCap): u64 { package::version(&self.cap) }
public fun policy(self: &DelayedUpgradeCap): u8 { package::upgrade_policy(&self.cap) }
public fun has_pending(self: &DelayedUpgradeCap): bool { self.pending.is_some() }
public fun pending_digest(self: &DelayedUpgradeCap): vector<u8> { self.pending.borrow().digest }
public fun pending_eta_ms(self: &DelayedUpgradeCap): u64 { self.pending.borrow().eta_ms }
public fun has_pending_owner(self: &DelayedUpgradeCap): bool { self.pending_owner.is_some() }
public fun pending_owner(self: &DelayedUpgradeCap): address { self.pending_owner.borrow().new_owner }

// ─── Test-only ─────────────────────────────────────────────────────────────

#[test_only]
public fun unpack_upgrade_proposed_for_testing(e: UpgradeProposed): (ID, ID, vector<u8>, u64, u64, u8) {
    let UpgradeProposed { wrapper_id, package, digest, proposed_at_ms, eta_ms, policy } = e;
    (wrapper_id, package, digest, proposed_at_ms, eta_ms, policy)
}
