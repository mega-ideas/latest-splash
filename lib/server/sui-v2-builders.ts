/**
 * v2 transaction builders: the PTBs the Business Splash Wallet signs.
 *
 * These replace, for v2 core, the v1 builders in lib/server/sui-settlement.ts
 * (createPaymentIntentOnSui, confirmComposedPaymentOnSui), which stay as they
 * are, marked V1 TESTNET ONLY, and refuse on mainnet. Every function here
 * calls a v2 `splash_core` entry point with the signature Phase 1 published
 * (move/splash_core/sources/business_account.move, payment_intent.move,
 * audit_anchor.move), and nothing else:
 *
 *   nominateWalletTx           business_account::nominate_wallet     founder
 *   registerWalletTx           business_account::register_wallet     the new multisig
 *   rotateWalletTx             business_account::rotate_wallet       the current wallet
 *   confirmWalletRotationTx    business_account::confirm_wallet_rotation  the new wallet
 *   cancelWalletRotationTx     business_account::cancel_wallet_rotation   the current wallet
 *   walletMembershipTx         add_owner / remove_owner / set_recovery_party, wallet-only
 *                              once a wallet is registered (Phase 1 R4)
 *   payFromWalletTx            create_for_wallet<T> -> redeem_funds<T> ->
 *                              confirm_from_business_wallet_balance<T> (max_fee,
 *                              FeeConfig, Registry; A1 §2.6) -> audit_anchor::anchor
 *                              -> delete_finalized, in one PTB the owners sign once
 *   payOpenIntentFromWalletTx  the owners pay an intent a staff member opened
 *                              and shared
 *
 * Gas. A wallet holds no SUI. Every transaction here is sponsored: the gas
 * owner is Splash's sponsor (lib/server/wallet-sponsor.ts), paying from its
 * own address balance (no gas coin, so nothing in the PTB can touch one), with
 * a ValidDuring window and a nonce, which is what Sui requires of a
 * transaction with no owned gas input and which also bounds how long the
 * signed bytes stay valid on chain. The signers sign the whole TransactionData,
 * gas fields included, so they see that Splash pays and how much at most.
 *
 * Every builder is offline: shared objects are named with their initial
 * shared version, so the bytes are fixed when built and the same bytes are
 * shown, hashed, signed, simulated and submitted. Simulation before anyone
 * signs is the caller's job (lib/server/wallet-signing.ts refuses to open a
 * request whose bytes do not simulate).
 */
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

export type SharedRef = { objectId: string; initialSharedVersion: string | number };

/** The v2 objects a wallet transaction names. */
export type V2Chain = {
  corePackageId: string;
  complianceConfig: SharedRef;
  feeConfig: SharedRef;
  registry: SharedRef;
  /** Native USDC on Sui (D6). */
  usdcType: string;
};

/** How the sponsor pays for a transaction (lib/server/wallet-sponsor.ts). */
export type SponsoredGas = {
  owner: string;
  price: bigint;
  budget: bigint;
  /** ValidDuring: the epoch it was built in and the next. */
  epoch: bigint;
  chain: string;
  nonce: number;
};

export class V2BuildError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'V2BuildError';
    this.code = code;
  }
}

/** A v2 intent kind (splash_core::fee_config). */
export const V2_KIND = Object.freeze({ SPLASH_BUSINESS: 0, WALLET: 1, EXCHANGE: 2, CROSS_CHAIN: 3, BANK_PAYOUT: 4 });
/** splash_core::payment_intent::MAX_INTENT_LIFETIME_MS, 30 days (D11). */
export const MAX_INTENT_LIFETIME_MS = 2_592_000_000n;

const fn = (chain: V2Chain, target: string) => `${normalizeSuiAddress(chain.corePackageId)}::${target}`;

function shared(tx: Transaction, ref: SharedRef, mutable: boolean) {
  return tx.sharedObjectRef({ objectId: ref.objectId, initialSharedVersion: ref.initialSharedVersion, mutable });
}

function bytes32(value: Uint8Array, what: string): Uint8Array {
  if (value.length !== 32) throw new V2BuildError(`${what} must be 32 bytes`, 'bad_commitment');
  return value;
}

function applyGas(tx: Transaction, sender: string, gas: SponsoredGas) {
  if (gas.budget <= 0n) throw new V2BuildError('a sponsored transaction needs a gas budget', 'bad_gas');
  tx.setSender(normalizeSuiAddress(sender));
  tx.setGasOwner(normalizeSuiAddress(gas.owner));
  tx.setGasPrice(gas.price);
  tx.setGasBudget(gas.budget);
  // The sponsor's address balance, never a gas coin: a PTB that cannot name
  // a gas coin cannot spend one.
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(gas.epoch),
      maxEpoch: String(gas.epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: gas.chain,
      nonce: gas.nonce,
    },
  });
}

/** The same sponsored gas, for the spending-rule builders (lib/server/spend-rules-builders.ts). */
export const applySponsoredGas = applyGas;

async function build(tx: Transaction): Promise<Uint8Array> {
  return tx.build();
}

/**
 * The founder names the wallet that may register (Phase 1 R2). Sender: the
 * founder. `addOwners` are wallet members whose own passkey address is not
 * yet an owner of the BusinessAccount: `register_wallet` refuses a member who
 * is not one (E_SIGNER_NOT_AN_OWNER), and before a wallet registers any owner
 * may add one, so the founder adds them in the same transaction.
 */
export function nominateWalletTx(
  chain: V2Chain,
  input: { founder: string; account: SharedRef; wallet: string; singleSigner: boolean; gas: SponsoredGas; addOwners?: readonly string[] },
): Promise<Uint8Array> {
  const tx = new Transaction();
  for (const owner of input.addOwners ?? []) {
    tx.moveCall({
      target: fn(chain, 'business_account::add_owner'),
      arguments: [shared(tx, input.account, true), tx.pure.address(normalizeSuiAddress(owner))],
    });
  }
  tx.moveCall({
    target: fn(chain, 'business_account::nominate_wallet'),
    arguments: [shared(tx, input.account, true), tx.pure.address(normalizeSuiAddress(input.wallet)), tx.pure.bool(input.singleSigner)],
  });
  applyGas(tx, input.founder, input.gas);
  return build(tx);
}

type Members = { keys: Uint8Array[]; weights: number[]; threshold: number; singleSignerAck: boolean };

function membersArgs(tx: Transaction, m: Members) {
  if (m.keys.length !== m.weights.length || m.keys.length === 0) throw new V2BuildError('as many weights as keys, and at least one', 'bad_members');
  return [
    tx.pure.vector('vector<u8>', m.keys.map((k) => Array.from(k))),
    tx.pure.vector('u8', m.weights),
    tx.pure.u16(m.threshold),
    tx.pure.bool(m.singleSignerAck),
  ];
}

/** The new multisig registers itself. Sender: the multisig. */
export function registerWalletTx(
  chain: V2Chain,
  input: Members & { wallet: string; account: SharedRef; gas: SponsoredGas },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: fn(chain, 'business_account::register_wallet'),
    arguments: [shared(tx, input.account, true), shared(tx, chain.registry, true), ...membersArgs(tx, input)],
  });
  applyGas(tx, input.wallet, input.gas);
  return build(tx);
}

/** Propose a new wallet. Sender: the current wallet. */
export function rotateWalletTx(
  chain: V2Chain,
  input: Members & { currentWallet: string; account: SharedRef; gas: SponsoredGas },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: fn(chain, 'business_account::rotate_wallet'),
    arguments: [shared(tx, input.account, true), ...membersArgs(tx, input)],
  });
  applyGas(tx, input.currentWallet, input.gas);
  return build(tx);
}

/** The proposed wallet takes over. Sender: the new wallet. */
export function confirmWalletRotationTx(
  chain: V2Chain,
  input: { newWallet: string; account: SharedRef; gas: SponsoredGas },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: fn(chain, 'business_account::confirm_wallet_rotation'),
    arguments: [shared(tx, input.account, true), shared(tx, chain.registry, true)],
  });
  applyGas(tx, input.newWallet, input.gas);
  return build(tx);
}

/** Withdraw a rotation the new wallet has not confirmed. Sender: the current wallet. */
export function cancelWalletRotationTx(
  chain: V2Chain,
  input: { currentWallet: string; account: SharedRef; gas: SponsoredGas },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({ target: fn(chain, 'business_account::cancel_wallet_rotation'), arguments: [shared(tx, input.account, true)] });
  applyGas(tx, input.currentWallet, input.gas);
  return build(tx);
}

/** Owner membership, wallet-only once a wallet is registered. Sender: the wallet. */
export function walletMembershipTx(
  chain: V2Chain,
  input: { wallet: string; account: SharedRef; change: 'add_owner' | 'remove_owner' | 'set_recovery_party'; address: string; gas: SponsoredGas },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: fn(chain, `business_account::${input.change}`),
    arguments: [shared(tx, input.account, true), tx.pure.address(normalizeSuiAddress(input.address))],
  });
  applyGas(tx, input.wallet, input.gas);
  return build(tx);
}

export type WalletPayment = {
  wallet: string;
  account: SharedRef;
  /** 32 bytes: the commitment over the business's payment id (idempotency). */
  paymentRef: Uint8Array;
  recipient: string;
  /** 32 bytes on a bank payout, empty otherwise. */
  beneficiaryRef: Uint8Array;
  amountMinor: bigint;
  targetCurrency: string;
  fxRateUsdLocal: bigint;
  commitment: Uint8Array;
  kind: number;
  railCommitment: Uint8Array;
  expiresAtMs: bigint;
  /** The Splash fee the signer was shown (A1 §2.6). The chain charges at most this. */
  maxFeeMinor: bigint;
  /** The quote's expiry: the chain refuses the payment from then on. */
  settleByMs: bigint;
  /** The audit bundle the receipt anchors. */
  contentHash: Uint8Array;
  walrusBlobId: Uint8Array;
  gas: SponsoredGas;
};

function paymentChecks(p: Pick<WalletPayment, 'amountMinor' | 'maxFeeMinor' | 'settleByMs' | 'expiresAtMs' | 'kind' | 'beneficiaryRef' | 'contentHash' | 'walrusBlobId'>) {
  if (p.amountMinor <= 0n) throw new V2BuildError('the amount must be above zero', 'bad_amount');
  if (p.maxFeeMinor < 0n) throw new V2BuildError('the maximum fee cannot be negative', 'bad_fee');
  if (p.amountMinor + p.maxFeeMinor > 18_446_744_073_709_551_615n) throw new V2BuildError('the amount is out of range', 'bad_amount');
  if (p.settleByMs > p.expiresAtMs) throw new V2BuildError('the quote cannot outlive the intent', 'bad_deadline');
  if (p.kind === V2_KIND.CROSS_CHAIN) {
    throw new V2BuildError('a cross-chain payment is paid through a bridge adapter, which is not registered yet', 'cross_chain_not_built');
  }
  if (p.kind < 0 || p.kind > V2_KIND.BANK_PAYOUT) throw new V2BuildError('unknown intent kind', 'bad_kind');
  if (p.kind === V2_KIND.BANK_PAYOUT) bytes32(p.beneficiaryRef, 'a bank payout beneficiary reference');
  if (p.contentHash.length === 0 || p.walrusBlobId.length === 0) throw new V2BuildError('the receipt needs its audit bundle', 'no_audit_bundle');
}

/**
 * Open, pay and anchor an intent from the business wallet in one PTB.
 *
 * The wallet withdraws exactly principal + max_fee from its own address
 * balance; the chain sends the principal to the recipient, the fee to
 * FeeConfig's recipient, and any unused fee back to the wallet (A1 §2.6).
 */
export function payFromWalletTx(chain: V2Chain, p: WalletPayment): Promise<Uint8Array> {
  paymentChecks(p);
  const T = normalizeStructTag(chain.usdcType);
  const tx = new Transaction();
  const account = shared(tx, p.account, true);
  const clock = tx.object.clock();
  const [funds] = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [T],
    arguments: [tx.withdrawal({ amount: p.amountMinor + p.maxFeeMinor, type: T })],
  });
  const [intent] = tx.moveCall({
    target: fn(chain, 'payment_intent::create_for_wallet'),
    typeArguments: [T],
    arguments: [
      account,
      shared(tx, chain.complianceConfig, false),
      tx.pure.vector('u8', Array.from(bytes32(p.paymentRef, 'the payment reference'))),
      tx.pure.address(normalizeSuiAddress(p.recipient)),
      tx.pure.vector('u8', Array.from(p.beneficiaryRef)),
      tx.pure.u64(p.amountMinor),
      tx.pure.string(p.targetCurrency),
      tx.pure.u64(p.fxRateUsdLocal),
      tx.pure.vector('u8', Array.from(bytes32(p.commitment, 'the commitment'))),
      tx.pure.u8(p.kind),
      tx.pure.vector('u8', Array.from(bytes32(p.railCommitment, 'the rail commitment'))),
      tx.pure.u64(p.expiresAtMs),
      clock,
    ],
  });
  const [receipt] = tx.moveCall({
    target: fn(chain, 'payment_intent::confirm_from_business_wallet_balance'),
    typeArguments: [T],
    arguments: [
      intent,
      account,
      shared(tx, chain.complianceConfig, false),
      shared(tx, chain.feeConfig, false),
      shared(tx, chain.registry, false),
      funds,
      tx.pure.u64(p.maxFeeMinor),
      tx.pure.u64(p.settleByMs),
      clock,
    ],
  });
  tx.moveCall({
    target: fn(chain, 'audit_anchor::anchor'),
    arguments: [receipt, tx.pure.vector('u8', Array.from(p.contentHash)), tx.pure.vector('u8', Array.from(p.walrusBlobId)), clock],
  });
  tx.moveCall({ target: fn(chain, 'payment_intent::delete_finalized'), arguments: [intent] });
  applyGas(tx, p.wallet, p.gas);
  return build(tx);
}

/**
 * The owners pay an intent that already exists (a staff member opened and
 * shared it, or the wallet shared it for later). `amountMinor` must be the
 * intent's principal, read from the chain by the caller; the withdrawal is
 * principal + max_fee.
 */
export function payOpenIntentFromWalletTx(
  chain: V2Chain,
  p: { wallet: string; account: SharedRef; intent: SharedRef; amountMinor: bigint; maxFeeMinor: bigint; settleByMs: bigint; contentHash: Uint8Array; walrusBlobId: Uint8Array; gas: SponsoredGas },
): Promise<Uint8Array> {
  if (p.amountMinor <= 0n || p.maxFeeMinor < 0n) throw new V2BuildError('the amount must be above zero', 'bad_amount');
  if (p.contentHash.length === 0 || p.walrusBlobId.length === 0) throw new V2BuildError('the receipt needs its audit bundle', 'no_audit_bundle');
  const T = normalizeStructTag(chain.usdcType);
  const tx = new Transaction();
  const clock = tx.object.clock();
  const [funds] = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [T],
    arguments: [tx.withdrawal({ amount: p.amountMinor + p.maxFeeMinor, type: T })],
  });
  const [receipt] = tx.moveCall({
    target: fn(chain, 'payment_intent::confirm_from_business_wallet_balance'),
    typeArguments: [T],
    arguments: [
      shared(tx, p.intent, true),
      shared(tx, p.account, true),
      shared(tx, chain.complianceConfig, false),
      shared(tx, chain.feeConfig, false),
      shared(tx, chain.registry, false),
      funds,
      tx.pure.u64(p.maxFeeMinor),
      tx.pure.u64(p.settleByMs),
      clock,
    ],
  });
  tx.moveCall({
    target: fn(chain, 'audit_anchor::anchor'),
    arguments: [receipt, tx.pure.vector('u8', Array.from(p.contentHash)), tx.pure.vector('u8', Array.from(p.walrusBlobId)), clock],
  });
  applyGas(tx, p.wallet, p.gas);
  return build(tx);
}

export type OwnedCoinRef = { objectId: string; version: string | number; digest: string };

/**
 * A member moves their own USDC to the business wallet (migration from the
 * per-person passkey wallets; Sky's decision: a plain signed transfer).
 *
 * Every USDC coin object the member holds and, separately, what sits in their
 * address balance are gathered into one balance and sent with
 * `0x2::balance::send_funds`, which is all the transaction does. Gasless by
 * default (Sui's stablecoin lane: gas price 0, budget 0, no gas coin; moving
 * everything satisfies its "use the entire balance" rule); with `sponsor`, the
 * sponsor pays gas from its address balance instead (STABLECOIN_GASLESS=off).
 * Sender: the member.
 */
export function memberToWalletTransferTx(input: {
  member: string;
  wallet: string;
  usdcType: string;
  coins: OwnedCoinRef[];
  addressBalanceMinor: bigint;
  validity: { epoch: bigint; chain: string; nonce: number };
  sponsor?: SponsoredGas;
}): Promise<Uint8Array> {
  if (input.coins.length === 0 && input.addressBalanceMinor <= 0n) throw new V2BuildError('there is no USDC to move', 'nothing_to_move');
  const T = normalizeStructTag(input.usdcType);
  const tx = new Transaction();
  type Result = ReturnType<Transaction['moveCall']>[number];
  let balance: Result | null = null;
  if (input.coins.length > 0) {
    const [first, ...rest] = input.coins.map((c) => tx.objectRef(c));
    if (rest.length > 0) tx.mergeCoins(first, rest);
    [balance] = tx.moveCall({ target: '0x2::coin::into_balance', typeArguments: [T], arguments: [first] });
  }
  if (input.addressBalanceMinor > 0n) {
    const [redeemed] = tx.moveCall({
      target: '0x2::balance::redeem_funds',
      typeArguments: [T],
      arguments: [tx.withdrawal({ amount: input.addressBalanceMinor, type: T })],
    });
    if (balance) tx.moveCall({ target: '0x2::balance::join', typeArguments: [T], arguments: [balance, redeemed] });
    else balance = redeemed;
  }
  tx.moveCall({
    target: '0x2::balance::send_funds',
    typeArguments: [T],
    arguments: [balance as Result, tx.pure.address(normalizeSuiAddress(input.wallet))],
  });
  if (input.sponsor) {
    applyGas(tx, input.member, input.sponsor);
  } else {
    tx.setSender(normalizeSuiAddress(input.member));
    tx.setGasPrice(0);
    tx.setGasBudget(0);
    tx.setGasPayment([]);
    tx.setExpiration({
      ValidDuring: {
        minEpoch: String(input.validity.epoch),
        maxEpoch: String(input.validity.epoch + 1n),
        minTimestamp: null,
        maxTimestamp: null,
        chain: input.validity.chain,
        nonce: input.validity.nonce,
      },
    });
  }
  return build(tx);
}

/**
 * The v2 objects from the environment, or why they are not usable. Every id
 * must be set; nothing falls back to the v1 package. The initial shared
 * versions are read from the chain by the caller (they never change).
 */
export function v2ObjectIdsFromEnv(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; ids: { corePackageId: string; complianceConfigId: string; feeConfigId: string; registryId: string } }
  | { ok: false; reason: string } {
  const pick = (key: 'SPLASH_CORE_PACKAGE_ID' | 'SPLASH_COMPLIANCE_CONFIG_ID' | 'SPLASH_FEE_CONFIG_ID' | 'SPLASH_ADDRESS_REGISTRY_ID') => (env[key] ?? '').trim();
  const corePackageId = pick('SPLASH_CORE_PACKAGE_ID');
  const complianceConfigId = pick('SPLASH_COMPLIANCE_CONFIG_ID');
  const feeConfigId = pick('SPLASH_FEE_CONFIG_ID');
  const registryId = pick('SPLASH_ADDRESS_REGISTRY_ID');
  const missing = Object.entries({
    SPLASH_CORE_PACKAGE_ID: corePackageId,
    SPLASH_COMPLIANCE_CONFIG_ID: complianceConfigId,
    SPLASH_FEE_CONFIG_ID: feeConfigId,
    SPLASH_ADDRESS_REGISTRY_ID: registryId,
  })
    .filter(([, v]) => !/^0x[0-9a-fA-F]{64}$/.test(v))
    .map(([k]) => k);
  if (missing.length > 0) return { ok: false, reason: `the v2 wallet needs ${missing.join(', ')} (0x + 64 hex each)` };
  return { ok: true, ids: { corePackageId, complianceConfigId, feeConfigId, registryId } };
}
