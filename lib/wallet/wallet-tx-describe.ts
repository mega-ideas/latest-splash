/**
 * What a Business Splash Wallet transaction does, read from its bytes.
 *
 * Review item B10: "a signer cannot be tricked into signing a different PTB
 * than the one displayed (show and hash the exact bytes); the approver's
 * screen shows payee, amount, asset and rate from the PTB, not from client
 * state." This is that reader. It takes the exact BCS `TransactionData` a
 * signer is asked to sign and returns what it does, decoded from the bytes
 * alone, with the digest the chain will give it. The server stores and sends
 * the description it computed, and a signer's device can run the same
 * function on the bytes it received and compare. Nothing a client sends is an
 * input here.
 *
 * It is also a refusal. It knows a short list of commands: the v2
 * `splash_core` wallet and payment calls, `0x2::balance::redeem_funds` and
 * `0x2::balance::send_funds`. Anything else (another package, any
 * `0x2::address_alias` call, Publish, Upgrade, TransferObjects, SplitCoins,
 * MakeMoveVec), any use of the gas coin, any withdrawal from the sponsor's
 * address balance, and any object argument that is not the expected account,
 * a config, or the one existing intent whose fields the server read from the
 * chain (`expect.openIntent`) is refused with WalletTxRefused. MergeCoins is
 * allowed only over the sender's own coins (a migration transfer). A wallet
 * signer is shown every command, and there is nothing it could be shown that
 * this reader does not understand.
 *
 * The address-alias rule is Phase 0 finding 6 (docs/v2/phase1-move-design.md
 * §1): if a wallet's quorum ever signed `0x2::address_alias::enable`, one
 * aliased key could then send as the whole multisig, and Move cannot see it.
 */
import { bcs } from '@mysten/sui/bcs';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toHex } from '@mysten/sui/utils';
import { blake2b } from '@noble/hashes/blake2.js';

export class WalletTxRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'WalletTxRefused';
    this.code = code;
  }
}

/** The ids a wallet transaction may touch. */
export type WalletTxExpectations = {
  corePackageId: string;
  /** The BusinessAccount of the org the request belongs to. */
  accountId: string;
  complianceConfigId?: string;
  feeConfigId?: string;
  registryId?: string;
  /** Native USDC's type: the only asset a payment may move (D6). */
  usdcType?: string;
  /**
   * The one existing intent a transaction may pay, as the server read it
   * from the chain before building the bytes. A shared intent object is
   * refused unless it is this one: the bytes name only the object, so what
   * the signer is shown (payee, principal, rate, expiry) has to come from the
   * intent itself, read by the server, bound to its id here, and stored with
   * the request.
   */
  openIntent?: OpenIntentExpectation;
};

/** An existing intent's fields, read from the chain (payment_intent::PaymentIntent). */
export type OpenIntentExpectation = {
  intentId: string;
  recipient: string;
  amountMinor: string;
  kind: number;
  targetCurrency: string;
  fxRateUsdLocal: string;
  expiresAtMs: string;
  /** The intent's settlement asset, a full type tag. */
  asset: string;
};

type Arg =
  | { kind: 'pure'; bytes: Uint8Array }
  | { kind: 'object'; objectId: string; mutable: boolean | null; owned: boolean }
  | { kind: 'withdrawal'; amount: bigint; type: string; from: string }
  | { kind: 'result'; command: number }
  | { kind: 'gas' };

export type WalletAction =
  | { type: 'nominate_wallet'; wallet: string; singleSigner: boolean }
  | { type: 'register_wallet'; wallet: string; threshold: number; members: Array<{ address: string; weight: number }>; singleSignerAck: boolean }
  | { type: 'rotate_wallet'; newWallet: string; threshold: number; members: Array<{ address: string; weight: number }>; singleSignerAck: boolean }
  | { type: 'confirm_wallet_rotation' }
  | { type: 'cancel_wallet_rotation' }
  | { type: 'add_owner' | 'remove_owner' | 'set_recovery_party'; address: string }
  | { type: 'withdraw'; asset: string; amountMinor: string }
  /** The sender's own coin objects merged into one (a migration transfer). */
  | { type: 'merge_coins'; coins: number }
  /** One of the sender's coins (or the merged coin) turned into a balance. */
  | { type: 'coin_to_balance'; asset: string }
  | { type: 'join_balance'; asset: string }
  /** `amountMinor` is known from the bytes only when the balance is one
   *  withdrawal; from coins it is what the simulation showed. */
  | { type: 'send_funds'; asset: string; recipient: string; amountMinor: string | null }
  | {
      type: 'open_intent';
      asset: string;
      recipient: string;
      amountMinor: string;
      kind: number;
      targetCurrency: string;
      fxRateUsdLocal: string;
      beneficiaryRef: string;
      expiresAtMs: string;
    }
  | {
      type: 'pay_intent';
      asset: string;
      maxFeeMinor: string;
      settleByMs: string;
      paysFromCommand: number;
      intentFromCommand: number | null;
      /** The existing intent this pays, its fields as read from the chain;
       *  null when the intent is opened in this same transaction. */
      intent: OpenIntentExpectation | null;
    }
  | { type: 'anchor_receipt' }
  | { type: 'delete_intent' };

export type WalletTxDescription = {
  /** What the chain will call this transaction. */
  digest: string;
  /** blake2b-256 of the exact bytes, hex: what the signer's screen shows. */
  bytesHash: string;
  sender: string;
  gas: { owner: string; budget: string; price: string; fromAddressBalance: boolean; sponsored: boolean };
  validity: { minEpoch: string | null; maxEpoch: string | null; nonce: number | null } | null;
  actions: WalletAction[];
};

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
const SUI_FRAMEWORK = normalizeSuiAddress('0x2');
const CLOCK = normalizeSuiAddress('0x6');

/** The digest and the content hash a signer is shown, from bytes alone. */
export function walletTxDigest(bytes: Uint8Array): { digest: string; bytesHash: string } {
  return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), bytesHash: toHex(blake2b(bytes, { dkLen: 32 })) };
}

function refuse(message: string, code = 'refused'): never {
  throw new WalletTxRefused(message, code);
}

/** Decode the exact bytes. */
export function describeWalletTransaction(input: Uint8Array | string, expect: WalletTxExpectations): WalletTxDescription {
  const bytes = typeof input === 'string' ? fromBase64(input) : input;
  let data: ReturnType<Transaction['getData']>;
  try {
    data = Transaction.from(bytes).getData();
  } catch {
    refuse('these are not Sui transaction bytes', 'not_a_transaction');
  }

  const core = normalizeSuiAddress(expect.corePackageId);
  const sender = data.sender ? normalizeSuiAddress(data.sender) : refuse('the transaction names no sender', 'no_sender');
  const gasOwner = normalizeSuiAddress(data.gasData.owner ?? sender);
  const payment = data.gasData.payment ?? [];

  const args: Arg[] = data.inputs.map((input) => {
    if (input.$kind === 'Pure') return { kind: 'pure', bytes: fromBase64(input.Pure.bytes) };
    if (input.$kind === 'Object') {
      const o = input.Object;
      if (o.$kind === 'SharedObject') return { kind: 'object', objectId: normalizeSuiAddress(o.SharedObject.objectId), mutable: o.SharedObject.mutable, owned: false };
      if (o.$kind === 'ImmOrOwnedObject') return { kind: 'object', objectId: normalizeSuiAddress(o.ImmOrOwnedObject.objectId), mutable: null, owned: true };
      return refuse('a transaction that receives objects is not a wallet transaction', 'receiving_not_allowed');
    }
    if (input.$kind === 'FundsWithdrawal') {
      const w = input.FundsWithdrawal;
      if (w.withdrawFrom.$kind !== 'Sender') {
        // A withdrawal "from the sponsor" would let a wallet transaction spend
        // Splash's gas balance; from an allowance, a staff path the owners'
        // wallet never uses.
        refuse(`a withdrawal from ${w.withdrawFrom.$kind === 'Sponsor' ? "the gas sponsor's" : 'an allowance'} balance is not allowed here`, 'foreign_withdrawal');
      }
      if (w.typeArg.$kind !== 'Balance') refuse('an unknown withdrawal type', 'bad_withdrawal');
      return { kind: 'withdrawal', amount: BigInt(w.reservation.MaxAmountU64), type: normalizeStructTag(w.typeArg.Balance), from: 'sender' };
    }
    return refuse('an input that was not resolved', 'unresolved_input');
  });

  const resolve = (arg: unknown): Arg => {
    const a = arg as { $kind: string; Input?: number; Result?: number; NestedResult?: [number, number] };
    if (a.$kind === 'GasCoin') refuse('the transaction uses the gas coin, which belongs to the gas sponsor', 'uses_gas_coin');
    if (a.$kind === 'Input') return args[a.Input as number] ?? refuse('an argument names a missing input', 'bad_argument');
    if (a.$kind === 'Result') return { kind: 'result', command: a.Result as number };
    if (a.$kind === 'NestedResult') {
      const [command, index] = a.NestedResult as [number, number];
      if (index !== 0) refuse('an argument takes a second result of a command', 'bad_argument');
      return { kind: 'result', command };
    }
    return refuse('an argument of an unknown kind', 'bad_argument');
  };

  const pure = <T>(arg: Arg, type: { parse(b: Uint8Array): T }, what: string): T => {
    if (arg.kind !== 'pure') refuse(`${what} must be a plain value`, 'bad_argument');
    try {
      return type.parse(arg.bytes);
    } catch {
      return refuse(`${what} could not be read`, 'bad_argument');
    }
  };
  const object = (arg: Arg, expected: string | undefined, what: string, mutable: boolean) => {
    if (arg.kind !== 'object') refuse(`${what} must be an object`, 'bad_argument');
    if (expected && arg.objectId !== normalizeSuiAddress(expected)) refuse(`${what} is not the expected object`, 'wrong_object');
    if (arg.mutable !== null && arg.mutable !== mutable) refuse(`${what} is passed with the wrong mutability`, 'bad_argument');
  };
  const account = (arg: Arg) => object(arg, expect.accountId, 'the business account', true);
  const clock = (arg: Arg) => object(arg, CLOCK, 'the clock', false);
  const asset = (types: string[]) => {
    if (types.length !== 1) refuse('a payment names one asset', 'bad_type');
    const t = normalizeStructTag(types[0]);
    if (expect.usdcType && t !== normalizeStructTag(expect.usdcType)) refuse('a payment may move USDC only (D6)', 'wrong_asset');
    return t;
  };
  const members = (keys: number[][], weights: number[]) => {
    if (keys.length !== weights.length) refuse('as many weights as keys', 'bad_argument');
    return keys.map((k, i) => ({ address: normalizeSuiAddress(toHex(blake2b(new Uint8Array(k), { dkLen: 32 }))), weight: weights[i] }));
  };
  const derive = (keys: number[][], weights: number[], threshold: number): string => {
    const parts: number[] = [0x03, threshold & 0xff, (threshold >> 8) & 0xff];
    keys.forEach((k, i) => parts.push(...k, weights[i]));
    return normalizeSuiAddress(toHex(blake2b(new Uint8Array(parts), { dkLen: 32 })));
  };

  const actions: WalletAction[] = [];
  const ownedCoin = (arg: Arg, what: string) => {
    if (arg.kind === 'object' && arg.owned) return;
    if (arg.kind === 'result' && actions[arg.command]?.type === 'merge_coins') return;
    refuse(`${what} must be one of the sender's own coins`, 'bad_argument');
  };

  data.commands.forEach((command, index) => {
    if (command.$kind === 'MergeCoins') {
      const dest = resolve(command.MergeCoins.destination);
      const sources = command.MergeCoins.sources.map(resolve);
      [dest, ...sources].forEach((c) => {
        if (c.kind !== 'object' || !c.owned) refuse("only the sender's own coins may be merged", 'bad_argument');
      });
      actions.push({ type: 'merge_coins', coins: sources.length + 1 });
      return;
    }
    if (command.$kind !== 'MoveCall') refuse(`command ${index + 1} is a ${command.$kind}, which a wallet transaction never needs`, 'command_not_allowed');
    const call = command.MoveCall;
    const pkg = normalizeSuiAddress(call.package);
    const target = `${call.module}::${call.function}`;
    const a = call.arguments.map(resolve);
    const need = (n: number) => {
      if (a.length !== n) refuse(`${target} takes ${n} arguments`, 'bad_argument');
    };

    if (pkg === SUI_FRAMEWORK) {
      if (call.module === 'address_alias') refuse('a wallet transaction may never touch address aliases', 'address_alias');
      if (target === 'balance::redeem_funds') {
        need(1);
        const w = a[0];
        if (w.kind !== 'withdrawal') refuse('redeem_funds takes a withdrawal', 'bad_argument');
        const t = asset(call.typeArguments);
        if (w.type !== t) refuse('the withdrawal and the asset differ', 'bad_argument');
        actions.push({ type: 'withdraw', asset: t, amountMinor: w.amount.toString() });
        return;
      }
      if (target === 'coin::into_balance') {
        need(1);
        const t = asset(call.typeArguments);
        ownedCoin(a[0], 'the coin');
        actions.push({ type: 'coin_to_balance', asset: t });
        return;
      }
      const balanceSource = (arg: Arg, what: string) => {
        const source = arg.kind === 'result' ? actions[arg.command] : undefined;
        if (!source || !['withdraw', 'coin_to_balance', 'join_balance'].includes(source.type)) {
          refuse(`${what} must be a balance taken from the sender in this transaction`, 'bad_argument');
        }
        return source as Extract<WalletAction, { type: 'withdraw' | 'coin_to_balance' | 'join_balance' }>;
      };
      if (target === 'balance::join') {
        need(2);
        const t = asset(call.typeArguments);
        balanceSource(a[0], 'the balance joined into');
        balanceSource(a[1], 'the balance joined');
        actions.push({ type: 'join_balance', asset: t });
        return;
      }
      if (target === 'balance::send_funds') {
        need(2);
        const t = asset(call.typeArguments);
        const source = balanceSource(a[0], 'the balance sent');
        const recipient = normalizeSuiAddress(pure(a[1], bcs.Address, 'the recipient'));
        if (recipient === ZERO) refuse('a transfer to the zero address', 'bad_argument');
        // A balance that something was joined into is more than its withdrawal.
        const exact = source.type === 'withdraw' && !actions.some((x) => x.type === 'join_balance');
        actions.push({ type: 'send_funds', asset: t, recipient, amountMinor: exact ? source.amountMinor : null });
        return;
      }
      refuse(`0x2::${target} is not a wallet command`, 'command_not_allowed');
    }

    if (pkg !== core) refuse(`command ${index + 1} calls a package that is not Splash's core`, 'package_not_allowed');

    switch (target) {
      case 'business_account::nominate_wallet': {
        need(3);
        account(a[0]);
        actions.push({ type: 'nominate_wallet', wallet: normalizeSuiAddress(pure(a[1], bcs.Address, 'the wallet')), singleSigner: pure(a[2], bcs.bool(), 'single-signer') });
        return;
      }
      case 'business_account::register_wallet':
      case 'business_account::rotate_wallet': {
        const rotate = target.endsWith('rotate_wallet');
        need(rotate ? 5 : 6);
        account(a[0]);
        let i = 1;
        if (!rotate) object(a[i++], expect.registryId, 'the address registry', true);
        const keys = pure(a[i++], bcs.vector(bcs.vector(bcs.u8())), 'the member keys');
        const weights = pure(a[i++], bcs.vector(bcs.u8()), 'the weights');
        const threshold = pure(a[i++], bcs.u16(), 'the threshold');
        const ack = pure(a[i++], bcs.bool(), 'the single-signer acknowledgement');
        const wallet = derive(keys, weights, threshold);
        const list = members(keys, weights);
        actions.push(
          rotate
            ? { type: 'rotate_wallet', newWallet: wallet, threshold, members: list, singleSignerAck: ack }
            : { type: 'register_wallet', wallet, threshold, members: list, singleSignerAck: ack },
        );
        return;
      }
      case 'business_account::confirm_wallet_rotation': {
        need(2);
        account(a[0]);
        object(a[1], expect.registryId, 'the address registry', true);
        actions.push({ type: 'confirm_wallet_rotation' });
        return;
      }
      case 'business_account::cancel_wallet_rotation': {
        need(1);
        account(a[0]);
        actions.push({ type: 'cancel_wallet_rotation' });
        return;
      }
      case 'business_account::add_owner':
      case 'business_account::remove_owner':
      case 'business_account::set_recovery_party': {
        need(2);
        account(a[0]);
        const address = normalizeSuiAddress(pure(a[1], bcs.Address, 'the address'));
        actions.push({ type: call.function as 'add_owner' | 'remove_owner' | 'set_recovery_party', address });
        return;
      }
      case 'payment_intent::create_for_wallet': {
        need(13);
        const t = asset(call.typeArguments);
        account(a[0]);
        object(a[1], expect.complianceConfigId, 'the compliance config', false);
        const paymentRef = pure(a[2], bcs.vector(bcs.u8()), 'the payment reference');
        if (paymentRef.length !== 32) refuse('the payment reference must be 32 bytes', 'bad_argument');
        const recipient = normalizeSuiAddress(pure(a[3], bcs.Address, 'the recipient'));
        const beneficiaryRef = pure(a[4], bcs.vector(bcs.u8()), 'the beneficiary reference');
        const amount = pure(a[5], bcs.u64(), 'the amount');
        const targetCurrency = pure(a[6], bcs.string(), 'the target currency');
        const fx = pure(a[7], bcs.u64(), 'the rate');
        pure(a[8], bcs.vector(bcs.u8()), 'the commitment');
        const kind = pure(a[9], bcs.u8(), 'the kind');
        pure(a[10], bcs.vector(bcs.u8()), 'the rail commitment');
        const expiresAt = pure(a[11], bcs.u64(), 'the expiry');
        clock(a[12]);
        actions.push({
          type: 'open_intent',
          asset: t,
          recipient,
          amountMinor: String(amount),
          kind,
          targetCurrency,
          fxRateUsdLocal: String(fx),
          beneficiaryRef: toHex(new Uint8Array(beneficiaryRef)),
          expiresAtMs: String(expiresAt),
        });
        return;
      }
      case 'payment_intent::confirm_from_business_wallet_balance': {
        need(9);
        const t = asset(call.typeArguments);
        const intent = a[0];
        let intentFromCommand: number | null = null;
        let existing: OpenIntentExpectation | null = null;
        if (intent.kind === 'result') {
          if (actions[intent.command]?.type !== 'open_intent') refuse('the intent paid must be the one opened in this transaction', 'bad_argument');
          intentFromCommand = intent.command;
        } else if (intent.kind !== 'object' || intent.owned || intent.mutable !== true) {
          refuse('the intent must be a shared object passed mutably', 'bad_argument');
        } else {
          // The bytes name only an object id. Without the intent's own fields,
          // read from the chain and bound to this id, the quorum would sign a
          // withdrawal to a payee nobody showed them.
          const expected = expect.openIntent ?? refuse('an existing intent is paid only once its payee and amount have been read from the chain', 'open_intent_unchecked');
          if (intent.objectId !== normalizeSuiAddress(expected.intentId)) refuse('the intent paid is not the one that was read', 'wrong_object');
          if (normalizeStructTag(expected.asset) !== t) refuse("the intent's asset is not the one paid", 'wrong_asset');
          existing = { ...expected, intentId: normalizeSuiAddress(expected.intentId), recipient: normalizeSuiAddress(expected.recipient), asset: t };
        }
        account(a[1]);
        object(a[2], expect.complianceConfigId, 'the compliance config', false);
        object(a[3], expect.feeConfigId, 'the fee config', false);
        object(a[4], expect.registryId, 'the address registry', false);
        const funds = a[5];
        if (funds.kind !== 'result' || actions[funds.command]?.type !== 'withdraw') {
          refuse("the payment must be redeemed from the wallet's own address balance in this transaction", 'bad_argument');
        }
        const maxFee = pure(a[6], bcs.u64(), 'the maximum fee');
        const settleBy = pure(a[7], bcs.u64(), 'the settle-by time');
        clock(a[8]);
        actions.push({ type: 'pay_intent', asset: t, maxFeeMinor: String(maxFee), settleByMs: String(settleBy), paysFromCommand: funds.command, intentFromCommand, intent: existing });
        return;
      }
      case 'audit_anchor::anchor': {
        need(4);
        const receipt = a[0];
        if (receipt.kind !== 'result' || actions[receipt.command]?.type !== 'pay_intent') refuse('anchor takes the receipt of the payment', 'bad_argument');
        pure(a[1], bcs.vector(bcs.u8()), 'the content hash');
        pure(a[2], bcs.vector(bcs.u8()), 'the blob id');
        clock(a[3]);
        actions.push({ type: 'anchor_receipt' });
        return;
      }
      case 'payment_intent::delete_finalized': {
        need(1);
        const intent = a[0];
        if (intent.kind !== 'result' || actions[intent.command]?.type !== 'open_intent') refuse('only the intent opened here may be deleted here', 'bad_argument');
        actions.push({ type: 'delete_intent' });
        return;
      }
      default:
        refuse(`${target} is not a wallet command`, 'command_not_allowed');
    }
  });

  if (actions.length === 0) refuse('the transaction does nothing', 'empty');

  const expiration = data.expiration;
  const validity =
    expiration && expiration.$kind === 'ValidDuring'
      ? {
          minEpoch: expiration.ValidDuring.minEpoch === null ? null : String(expiration.ValidDuring.minEpoch),
          maxEpoch: expiration.ValidDuring.maxEpoch === null ? null : String(expiration.ValidDuring.maxEpoch),
          nonce: expiration.ValidDuring.nonce,
        }
      : null;

  return {
    ...walletTxDigest(bytes),
    sender,
    gas: {
      owner: gasOwner,
      budget: String(data.gasData.budget ?? '0'),
      price: String(data.gasData.price ?? '0'),
      fromAddressBalance: payment.length === 0,
      sponsored: gasOwner !== sender,
    },
    validity,
    actions,
  };
}
