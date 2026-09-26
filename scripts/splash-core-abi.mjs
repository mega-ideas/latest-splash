/**
 * The splash_core functions scripts/e2e-testnet.mjs calls, with their
 * parameters as move/splash_core/sources declares them (the trailing TxContext
 * left off), written the way the node reports them.
 *
 * The verify script compares this table with the published package, so a
 * package published from older source is named instead of failing with the
 * node's unnamed "Mutable parameter provided, immutable parameter expected".
 * tests/e2e-verify-abi.test.mjs compares it with the Move source, so a
 * signature change there fails a test rather than the key ceremony.
 */
export const SPLASH_CORE_ABI = {
  'peg_monitor::update_peg':
    '&mut peg_monitor::PegState, &business_account::AnchorCap, &cap_registry::CapRegistry, u64, u64, &clock::Clock',
  'payment_intent::create_payment_intent': 'address, u64, string::String, u64, vector<u8>, &clock::Clock',
  'payment_intent::create':
    'address, vector<u8>, u64, vector<u8>, vector<u8>, string::String, u64, vector<u8>, &clock::Clock',
  'payment_intent::confirm_payment_intent': '&mut payment_intent::PaymentIntent, coin::Coin<T0>, &clock::Clock',
  'payment_intent::delete_finalized': 'payment_intent::PaymentIntent',
  'audit_anchor::anchor': 'payment_intent::SettleReceipt, vector<u8>, vector<u8>, &clock::Clock',
  'audit_anchor::anchor_audit_hash':
    '&business_account::AnchorCap, &cap_registry::CapRegistry, string::String, string::String, string::String, address, &clock::Clock',
};
