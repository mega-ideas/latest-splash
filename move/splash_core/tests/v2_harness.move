/// Shared set-up for the v2 tests: a verified account whose owners are the
/// three Phase 0 passkeys, its 2-of-3 business wallet registered, the one
/// `ComplianceConfig` accepting a test USDC, and a shared clock.
///
/// Move tests do not check signatures, so a test acts as the multisig simply
/// by sending as its address. What the chain would check (that the sender is
/// the address these members derive) is exactly what the code under test
/// asserts.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::v2_harness;

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry;
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::payment_intent::{Self, PaymentIntent};
use std::string::String;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// The settlement asset under test. Six decimals, like USDC.
public struct USDC has drop {}

// The Phase 0 passkeys (flag || compressed key) and their own addresses.
const PASSKEY_1: vector<u8> = x"060355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16";
const PASSKEY_2: vector<u8> = x"06025cb0f7961afbdc293a3cd22290d86697bcceb402011804a4e72119960f2741f9";
const PASSKEY_3: vector<u8> = x"060399ca5c2f751fbe57d9e493e174085dee6144965b20fd5895e28902fb1148e04a";
const OWNER_1: address = @0xf22bbbc884a1184c6f3da3fff986c2f05c977e70a142ee8e2550b22a33890253;
const OWNER_2: address = @0xed53becafe1911c288e33fa008d03e86b63131e55e226abe103e47dce34e61fa;
const OWNER_3: address = @0xcfbaedef6b0b04e2fa6e40f6981aa3257e9cdbc097738346e75533f423fff067;
/// The 2-of-3 of the three passkeys (`multisig_tests::PHASE0_PASSKEY_2_OF_3`).
const WALLET: address = @0xafea5352bb6313c6af89594eac518d24049e5bc6dfd4bbc18a14bf191f82b6b5;

const RECIPIENT: address = @0xB0B;
const DAY: u64 = 86_400_000;
const COMMITMENT: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const RAIL: vector<u8> = x"ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const BENEFICIARY: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/// 100 USDC: above the 99 USDC bank-payout floor, under every Tier 3 ceiling.
const AMOUNT: u64 = 100_000_000;
const QUOTE_MS: u64 = 300_000;

public fun owner_1(): address { OWNER_1 }
public fun owner_2(): address { OWNER_2 }
public fun owner_3(): address { OWNER_3 }
public fun founder(): address { OWNER_1 }
public fun wallet(): address { WALLET }
public fun recipient(): address { RECIPIENT }
public fun day(): u64 { DAY }
public fun commitment(): vector<u8> { COMMITMENT }
public fun rail(): vector<u8> { RAIL }
public fun beneficiary(): vector<u8> { BENEFICIARY }
public fun amount(): u64 { AMOUNT }
public fun keys(): vector<vector<u8>> { vector[PASSKEY_1, PASSKEY_2, PASSKEY_3] }
public fun passkey(i: u64): vector<u8> { keys()[i] }
public fun weights(): vector<u8> { vector[1, 1, 1] }
public fun threshold(): u16 { 2 }

/// A distinct 32-byte payment reference for each `n`.
public fun payment_ref(n: u8): vector<u8> {
    let mut r = x"0000000000000000000000000000000000000000000000000000000000000000";
    *&mut r[31] = n;
    *&mut r[0] = 0xAA;
    r
}

/// Clock at day one; the account submitted by the founder, verified, with
/// owners 2 and 3 added; the config created; NO wallet yet.
public fun setup_without_wallet(): Scenario {
    let mut s = ts::begin(OWNER_1);
    {
        let ctx = s.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(DAY);
        clock::share_for_testing(c);
    };
    s.next_tx(OWNER_1);
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-202401012345".to_string(), b"bafy-kyb".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    s.next_tx(OWNER_1);
    {
        let mut account = s.take_shared<BusinessAccount>();
        let ctx = s.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::verify_business(&admin, &mut account, 20);
        business_account::add_owner(&mut account, OWNER_2, ctx);
        business_account::add_owner(&mut account, OWNER_3, ctx);
        let registry = cap_registry::new_for_testing(ctx);
        compliance_config::create<USDC>(
            compliance_config::ticket_for_testing(ctx),
            &admin,
            &registry,
            5_000,
            60_000,
            50,
            1_000_000,
            1_000_000,
            vector[object::id_from_address(@0xF001)],
            ctx,
        );
        cap_registry::share_for_testing(registry);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    s
}

/// `setup_without_wallet`, then the founder nominates and the 2-of-3
/// registers itself.
public fun setup(): Scenario {
    let mut s = setup_without_wallet();
    register_wallet(&mut s);
    s
}

public fun register_wallet(s: &mut Scenario) {
    s.next_tx(OWNER_1);
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::nominate_wallet(&mut account, WALLET, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(WALLET);
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::register_wallet(&mut account, keys(), weights(), threshold(), false, s.ctx());
        ts::return_shared(account);
    };
}

/// The wallet opens a bank payout for `amount` and returns it by value.
public fun wallet_intent(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        payment_ref(n),
        RECIPIENT,
        BENEFICIARY,
        amount,
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        payment_intent::kind_bank_payout(),
        RAIL,
        clock.timestamp_ms() + QUOTE_MS,
        clock,
        ctx,
    )
}

/// The wallet opens an intent of any Sui kind to `to`.
public fun wallet_intent_of_kind(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    kind: u8,
    to: address,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let beneficiary = if (kind == payment_intent::kind_bank_payout()) BENEFICIARY else vector[];
    let currency: String = if (kind == payment_intent::kind_bank_payout()) b"PHP".to_string() else b"USDC".to_string();
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        payment_ref(n),
        to,
        beneficiary,
        amount,
        currency,
        56_000_000,
        COMMITMENT,
        kind,
        RAIL,
        clock.timestamp_ms() + QUOTE_MS,
        clock,
        ctx,
    )
}

public fun usdc(amount: u64, ctx: &mut TxContext): Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, ctx)
}

/// Settle-by a little in the future of `clock`: the quote is still good.
public fun settle_by(clock: &Clock): u64 { clock.timestamp_ms() + QUOTE_MS }
