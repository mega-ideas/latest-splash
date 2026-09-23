/// SpendWindow — a rolling velocity ceiling, used for both the 24-hour and the
/// 30-day limits a tier grants.
///
/// AUDIT A-11, at the account level. `splash_meter::spend_meter` bounds what the
/// PROTOCOL can move out of pooled custody; this bounds what a single tenant can
/// move. Different object, different lifecycle, different threat: the meter
/// contains a compromised operator key, this contains a compromised tenant key
/// and gives a stolen approver credential a ceiling.
///
/// ─── Why this is not `splash_meter` ─────────────────────────────────────────
///
/// The arithmetic is deliberately the same shape and the obvious move is to
/// depend on it rather than restate it. That is the wrong trade here for one
/// reason: `splash_meter` publishes UPGRADEABLE under the cold multisig, and
/// `splash_core` burns its `UpgradeCap`. A dependency would make core's payout
/// ceiling mutable through someone else's upgrade, which is exactly the
/// property core exists not to have. `splash_core` also keeps a dependency
/// surface of the Sui framework and nothing else, on the Cetus reasoning in
/// `Move.toml`.
///
/// ─── The window ─────────────────────────────────────────────────────────────
///
/// A ring of buckets, rolled forward lazily by the spender's own transaction.
/// Sui has no cron, so nothing can be scheduled to reset a counter, and any
/// design needing one silently stops working when nobody calls it.
///
/// Buckets rather than a `(window_start, spent)` pair because a TUMBLING window
/// with lazy reset is trivially defeated: spend the ceiling at `t = end - 1ms`
/// and again at `t = end + 1ms` for 2x the advertised cap in two blocks. The
/// ring makes it genuinely sliding at one-bucket granularity, so that trick
/// buys at most one bucket of slack.
///
/// ─── The shape is still not caller-supplied ────────────────────────────────
///
/// The struct now carries `bucket_ms` and `bucket_count` because a tier grants
/// both a daily and a monthly ceiling and one shape cannot serve both. That is
/// NOT the same as making the window configurable: the only constructors are
/// `new_daily` and `new_monthly`, both of which hardcode their shape. Nothing
/// public lets a caller invent a window, so "how long is a day here?" is still
/// answered by reading this file rather than a shared object's state.
module splash_core::spend_window;

use sui::clock::{Self, Clock};

// ─── Abort codes (200-block, reserved for spend_window) ─────────────────────
//
// Move abort codes are per-module and the VM would never confuse two modules
// using the same number — but the off-chain table in
// `lib/server/sui-settlement.ts` maps a bare code to a sentence, and it is
// FLAT. This module first took the 600s, which `dual_treasury` already owns, so
// a tenant hitting their ceiling would have been told "E_USDT_BUFFER_EMPTY —
// emergency_sweep called with zero balance": a wrong explanation during a
// failed payment, which is worse than none. `scripts/check-abort-codes.mjs`
// keeps them globally unique.
const E_ZERO_AMOUNT: u64 = 200;
/// The payout would push this account past the ceiling of this window.
const E_CAP_EXCEEDED: u64 = 201;
const E_INVALID_CAP: u64 = 202;

// ─── The two shapes, fixed in code ──────────────────────────────────────────
const DAILY_BUCKETS: u64 = 24;
const DAILY_BUCKET_MS: u64 = 3_600_000;
const DAILY_WINDOW_MS: u64 = 86_400_000;

const MONTHLY_BUCKETS: u64 = 30;
const MONTHLY_BUCKET_MS: u64 = 86_400_000;
const MONTHLY_WINDOW_MS: u64 = 2_592_000_000;

/// A tier with no ceiling. `u64::MAX` rather than a `None` branch: every
/// arithmetic path below stays identical, and a cap that is merely enormous
/// cannot be confused with a cap that was forgotten and left at zero — zero is
/// rejected outright by `new`.
const UNLIMITED: u64 = 18_446_744_073_709_551_615;

/// Deliberately NOT `drop`. A window must be explicitly destroyed, so removing
/// one from an account is a visible edit rather than a silent omission.
public struct SpendWindow has store {
    buckets: vector<u64>,
    head: u64,
    head_start_ms: u64,
    bucket_ms: u64,
    bucket_count: u64,
    /// Ceiling in the settled coin's MINOR UNITS — the same unit as
    /// `PaymentIntent.amount_usd` and `ComplianceConfig.min_settlement_amount`.
    /// Never a whole-currency figure: a cap of `1000` on a 6-decimal coin is a
    /// tenth of a cent, which reads like a limit and is a brick.
    cap_minor: u64,
}

fun new_window(cap_minor: u64, bucket_ms: u64, bucket_count: u64, clock: &Clock): SpendWindow {
    assert!(cap_minor > 0, E_INVALID_CAP);

    let mut buckets = vector<u64>[];
    let mut i = 0;
    while (i < bucket_count) {
        buckets.push_back(0);
        i = i + 1;
    };

    SpendWindow {
        buckets,
        head: 0,
        head_start_ms: bucket_start(clock::timestamp_ms(clock), bucket_ms),
        bucket_ms,
        bucket_count,
        cap_minor,
    }
}

/// 24 hourly buckets.
public fun new_daily(cap_minor: u64, clock: &Clock): SpendWindow {
    new_window(cap_minor, DAILY_BUCKET_MS, DAILY_BUCKETS, clock)
}

/// 30 daily buckets. A rolling thirty days, not a calendar month — a calendar
/// boundary is a scheduled reset, and a scheduled reset is the tumbling-window
/// double spend at a coarser grain.
public fun new_monthly(cap_minor: u64, clock: &Clock): SpendWindow {
    new_window(cap_minor, MONTHLY_BUCKET_MS, MONTHLY_BUCKETS, clock)
}

public fun destroy(window: SpendWindow) {
    let SpendWindow {
        buckets: _,
        head: _,
        head_start_ms: _,
        bucket_ms: _,
        bucket_count: _,
        cap_minor: _,
    } = window;
}

fun bucket_start(now_ms: u64, bucket_ms: u64): u64 {
    now_ms - (now_ms % bucket_ms)
}

/// Advance to `now`, zeroing buckets that have aged out.
///
/// Gas is bounded at `bucket_count` writes worst case, and a full turnover
/// short-circuits: a window untouched for a year costs the same as one
/// untouched for a day.
fun roll_forward(window: &mut SpendWindow, now_ms: u64) {
    let now_start = bucket_start(now_ms, window.bucket_ms);
    // A clock that reads BACKWARDS (or an unchanged bucket) must not rewind the
    // window — that would resurrect spend that has already aged out.
    if (now_start <= window.head_start_ms) return;

    let elapsed = (now_start - window.head_start_ms) / window.bucket_ms;
    if (elapsed >= window.bucket_count) {
        let mut i = 0;
        while (i < window.bucket_count) {
            *window.buckets.borrow_mut(i) = 0;
            i = i + 1;
        };
        window.head = 0;
    } else {
        let mut step = 0;
        while (step < elapsed) {
            window.head = (window.head + 1) % window.bucket_count;
            *window.buckets.borrow_mut(window.head) = 0;
            step = step + 1;
        };
    };
    window.head_start_ms = now_start;
}

fun total(window: &SpendWindow): u64 {
    let mut sum = 0;
    let mut i = 0;
    while (i < window.bucket_count) {
        sum = sum + *window.buckets.borrow(i);
        i = i + 1;
    };
    sum
}

/// Charge `amount` against the window, or abort.
///
/// `public(package)` rather than `public`: the only holder of a
/// `&mut SpendWindow` is `business_account`, which owns the field, and nothing
/// outside this package has any business burning a tenant's allowance.
/// (`spend_meter` had to be `public` because its consumer is a different
/// package; this one does not, so it is not.)
public(package) fun charge(window: &mut SpendWindow, amount: u64, clock: &Clock) {
    assert!(amount > 0, E_ZERO_AMOUNT);

    let now = clock::timestamp_ms(clock);
    roll_forward(window, now);

    let spent = total(window);
    // The window can hold MORE than the cap: spend to the ceiling, then have the
    // ceiling lowered under you. `cap - spent` then underflows, and a u64
    // arithmetic abort is a fail-closed outcome with a useless diagnostic — the
    // operator sees an arithmetic error where the truth is "this account is over
    // its (new, lower) ceiling".
    assert!(spent < window.cap_minor, E_CAP_EXCEEDED);
    // Written as a subtraction, not `spent + amount <= cap`, so a large amount
    // cannot overflow u64 before the comparison happens.
    assert!(amount <= window.cap_minor - spent, E_CAP_EXCEEDED);

    let head = window.head;
    *window.buckets.borrow_mut(head) = *window.buckets.borrow(head) + amount;
}

/// Replace the ceiling. Takes effect immediately in both directions.
///
/// Note what this deliberately does NOT do: it does not clear the window.
/// Raising the cap does not forgive spend already made inside it, so
/// "raise, drain, lower" moves no more than "raise and drain" would.
public(package) fun set_cap(window: &mut SpendWindow, cap_minor: u64) {
    assert!(cap_minor > 0, E_INVALID_CAP);
    window.cap_minor = cap_minor;
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun cap_minor(window: &SpendWindow): u64 { window.cap_minor }
public fun is_unlimited(window: &SpendWindow): bool { window.cap_minor == UNLIMITED }

/// Spend inside the window AS OF `clock`, without mutating.
///
/// Recomputed rather than read off the stored buckets: a stored total is stale
/// the moment a bucket passes, and a view that overstates spend would have
/// off-chain callers refusing payments the chain would accept.
public fun spent(window: &SpendWindow, clock: &Clock): u64 {
    let now_start = bucket_start(clock::timestamp_ms(clock), window.bucket_ms);
    if (now_start <= window.head_start_ms) return total(window);

    let elapsed = (now_start - window.head_start_ms) / window.bucket_ms;
    if (elapsed >= window.bucket_count) return 0;

    // Sum only the buckets that survive the roll. `roll_forward` advances the
    // head `elapsed` times and zeroes each bucket it lands on, and those are the
    // `elapsed` OLDEST — so what survives is the newest `bucket_count - elapsed`,
    // counted BACKWARDS from the head.
    //
    // Counting backwards is the whole point. `spend_meter::remaining_at` counted
    // forwards, which wraps onto the buckets the roll is about to zero and skips
    // the same number of live ones (fixed there, with its own regression test).
    let mut sum = 0;
    let mut j = 0;
    while (j < window.bucket_count - elapsed) {
        let idx = (window.head + window.bucket_count - j) % window.bucket_count;
        sum = sum + *window.buckets.borrow(idx);
        j = j + 1;
    };
    sum
}

public fun remaining(window: &SpendWindow, clock: &Clock): u64 {
    let used = spent(window, clock);
    if (used >= window.cap_minor) 0 else window.cap_minor - used
}

public fun unlimited(): u64 { UNLIMITED }
public fun daily_window_ms(): u64 { DAILY_WINDOW_MS }
public fun monthly_window_ms(): u64 { MONTHLY_WINDOW_MS }
public fun daily_buckets(): u64 { DAILY_BUCKETS }
public fun monthly_buckets(): u64 { MONTHLY_BUCKETS }

#[test_only]
public fun charge_for_testing(window: &mut SpendWindow, amount: u64, clock: &Clock) {
    charge(window, amount, clock)
}

#[test_only]
public fun set_cap_for_testing(window: &mut SpendWindow, cap_minor: u64) {
    set_cap(window, cap_minor)
}
