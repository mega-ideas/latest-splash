/**
 * The PTBs of subscription billing (A1 §6; behind FEATURE_SUBSCRIPTION_BILLING,
 * off). Offline, like every v2 builder: shared objects by initial version.
 *
 *   subscribeTx          the business wallet signs
 *                        allowance::monthly_rate_limit(price) ->
 *                        option::some<RateLimit> ->
 *                        allowance::new<Balance<USDC>>(name, finance, lifetime?,
 *                        none, some(end of term), rate)
 *                        and, for a plan change, allowance::revoke of the
 *                        current billing allowance first, in the same PTB
 *   cancelSubscriptionTx the business wallet signs allowance::revoke
 *   billingPullTx        the finance multisig signs a withdrawal from the
 *                        business wallet under the allowance ->
 *                        allowance::balance_spend<USDC> ->
 *                        balance::send_funds<USDC>(finance)
 *
 * The wallet's transactions are sponsored (the KMS operator pays the gas,
 * from its address balance). The pull is the finance multisig's own
 * transaction and pays its own gas from its address balance; nothing in it
 * touches a gas coin.
 */
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { BILLING_ALLOWANCE_PREFIX } from '../billing/subscription.ts';
import { applySponsoredGas, V2BuildError, type SharedRef, type SponsoredGas } from './sui-v2-builders.ts';

export type OwnedRef = { objectId: string; version: string | number; digest: string };

const U64_MAX = 18_446_744_073_709_551_615n;
const u64 = (v: bigint, what: string) => {
  if (v < 0n || v > U64_MAX) throw new V2BuildError(`${what} does not fit a u64`, 'bad_amount');
  return v;
};

function shared(tx: Transaction, ref: SharedRef, mutable: boolean) {
  return tx.sharedObjectRef({ objectId: ref.objectId, initialSharedVersion: ref.initialSharedVersion, mutable });
}

export type SubscribeInput = {
  wallet: string;
  usdcType: string;
  name: string;
  finance: string;
  monthlyLimitMinor: bigint;
  expiresAtMs: bigint;
  lifetimeCapMinor: bigint | null;
  /** A plan change: the current billing allowance, revoked first. */
  revoke?: { cap: OwnedRef; allowance: SharedRef };
  gas: SponsoredGas;
};

export function subscribeTx(input: SubscribeInput): Promise<Uint8Array> {
  if (input.monthlyLimitMinor <= 0n) throw new V2BuildError('a plan price is above zero', 'bad_limit');
  if (input.expiresAtMs <= 0n) throw new V2BuildError('a subscription has an end of term', 'bad_expiry');
  if (input.lifetimeCapMinor !== null && input.lifetimeCapMinor <= 0n) throw new V2BuildError('a lifetime cap is above zero', 'bad_limit');
  if (!input.name.startsWith(BILLING_ALLOWANCE_PREFIX) || new TextEncoder().encode(input.name).length > 128) throw new V2BuildError('not a billing allowance name', 'bad_name');
  const finance = normalizeSuiAddress(input.finance);
  if (finance === normalizeSuiAddress(input.wallet)) throw new V2BuildError('the wallet cannot bill itself', 'bad_spender');
  const B = `0x2::balance::Balance<${normalizeStructTag(input.usdcType)}>`;
  const tx = new Transaction();
  if (input.revoke) {
    tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: [B], arguments: [tx.objectRef(input.revoke.cap), shared(tx, input.revoke.allowance, true)] });
  }
  const [rate] = tx.moveCall({ target: '0x2::allowance::monthly_rate_limit', arguments: [tx.pure.u256(input.monthlyLimitMinor)] });
  const [someRate] = tx.moveCall({ target: '0x1::option::some', typeArguments: ['0x2::allowance::RateLimit'], arguments: [rate] });
  tx.moveCall({
    target: '0x2::allowance::new',
    typeArguments: [B],
    arguments: [
      tx.pure.string(input.name),
      tx.pure.address(finance),
      tx.pure.option('u256', input.lifetimeCapMinor),
      tx.pure.option('u64', null),
      tx.pure.option('u64', u64(input.expiresAtMs, 'the end of term')),
      someRate,
    ],
  });
  applySponsoredGas(tx, input.wallet, input.gas);
  return tx.build();
}

export function cancelSubscriptionTx(input: { wallet: string; usdcType: string; cap: OwnedRef; allowance: SharedRef; gas: SponsoredGas }): Promise<Uint8Array> {
  const B = `0x2::balance::Balance<${normalizeStructTag(input.usdcType)}>`;
  const tx = new Transaction();
  tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: [B], arguments: [tx.objectRef(input.cap), shared(tx, input.allowance, true)] });
  applySponsoredGas(tx, input.wallet, input.gas);
  return tx.build();
}

/** The finance multisig's own gas: its address balance, a ValidDuring window. */
export type OwnGas = { price: bigint; budget: bigint; epoch: bigint; chain: string; nonce: number };

export function billingPullTx(input: {
  finance: string;
  wallet: string;
  usdcType: string;
  allowance: SharedRef;
  amountMinor: bigint;
  gas: OwnGas;
}): Promise<Uint8Array> {
  if (input.amountMinor <= 0n) throw new V2BuildError('a pull is above zero', 'bad_amount');
  const T = normalizeStructTag(input.usdcType);
  const finance = normalizeSuiAddress(input.finance);
  const tx = new Transaction();
  const withdrawal = tx.withdrawal({ amount: u64(input.amountMinor, 'the pull'), type: T, from: 'allowance', allowance: normalizeSuiAddress(input.allowance.objectId), funder: normalizeSuiAddress(input.wallet) });
  const [funds] = tx.moveCall({
    target: '0x2::allowance::balance_spend',
    typeArguments: [T],
    arguments: [shared(tx, input.allowance, true), withdrawal, tx.object.clock()],
  });
  tx.moveCall({ target: '0x2::balance::send_funds', typeArguments: [T], arguments: [funds, tx.pure.address(finance)] });
  applySponsoredGas(tx, finance, { owner: finance, ...input.gas });
  return tx.build();
}
