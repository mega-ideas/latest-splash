/**
 * Gas for the Business Splash Wallet (v2 §4.1: "the wallet holds no SUI").
 *
 * Two routes, and every wallet transaction takes one of them:
 *
 *   gasless    a plain USDC transfer (`0x2::balance::send_funds` and nothing
 *              else) goes through Sui's gasless stablecoin lane, the existing
 *              path behind STABLECOIN_GASLESS (lib/payments/stablecoin-lane.ts).
 *              Nobody pays. The member-wallet migration transfers use it.
 *   sponsored  every Move call the wallet signs (register, rotate, membership,
 *              payments) is outside the gasless lane, so Splash sponsors it:
 *              the gas owner is the operator signer (AWS KMS in production,
 *              lib/server/operator-signer.ts), paying from its SUI address
 *              balance. Switched on by WALLET_GAS_SPONSOR=operator.
 *
 * Sponsoring is a signature over the whole transaction, so the sponsor checks
 * what it is paying for before it signs (`assertSponsorable`), on the bytes,
 * every time: the gas owner is itself and pays from its address balance (no
 * gas coin exists in the transaction for a command to take); the budget is
 * within the cap; the sender is the wallet, founder or member the request
 * names; and the transaction is one `describeWalletTransaction` understands,
 * which already refuses any withdrawal from the sponsor's balance, any use of
 * the gas coin, any foreign package and every `0x2::address_alias` call. So
 * the sponsor pays gas, and is never a payer or receiver of client money (D3).
 *
 * No key here: `sign` asks the operator signer. With WALLET_GAS_SPONSOR unset
 * or 'off', `walletSponsorFromEnv` returns a refusal, and no sponsored request
 * is opened; there is no pretend sponsor.
 */
import { randomInt } from 'node:crypto';

import type { Signer } from '@mysten/sui/cryptography';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { WalletTxDescription } from '@/lib/wallet/wallet-tx-describe';
import type { SponsoredGas } from '@/lib/server/sui-v2-builders';

/** At most 0.05 SUI of gas per wallet transaction. A registration or a
 *  payment uses a small fraction; the cap bounds what a bad build could cost. */
export const WALLET_GAS_BUDGET_CAP_MIST = 50_000_000n;

export class SponsorRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SponsorRefused';
    this.code = code;
  }
}

export interface WalletSponsor {
  address: string;
  /** Gas fields for a transaction built now. */
  gasFor(): Promise<SponsoredGas>;
  /** Sign the exact bytes as gas owner. Call only after assertSponsorable. */
  sign(bytes: Uint8Array): Promise<string>;
}

/** What the sponsor will and will not pay for. Throws SponsorRefused. */
export function assertSponsorable(
  description: WalletTxDescription,
  rule: { sponsor: string; senders: readonly string[]; budgetCapMist?: bigint },
): void {
  const sponsor = normalizeSuiAddress(rule.sponsor);
  if (description.gas.owner !== sponsor) throw new SponsorRefused('the gas owner is not the sponsor', 'not_our_gas');
  if (!description.gas.sponsored) throw new SponsorRefused('the sponsor is also the sender', 'self_sponsored');
  if (!description.gas.fromAddressBalance) {
    throw new SponsorRefused('a sponsored wallet transaction pays gas from the sponsor address balance, never a gas coin', 'gas_coin');
  }
  if (BigInt(description.gas.budget) > (rule.budgetCapMist ?? WALLET_GAS_BUDGET_CAP_MIST)) {
    throw new SponsorRefused('the gas budget is above the sponsor cap', 'budget');
  }
  if (!rule.senders.map((s) => normalizeSuiAddress(s)).includes(description.sender)) {
    throw new SponsorRefused('the sender is not the wallet this request is for', 'wrong_sender');
  }
  if (description.validity === null) {
    throw new SponsorRefused('a sponsored transaction must carry a ValidDuring window', 'no_validity');
  }
}

type GasReader = {
  referenceGasPrice(): Promise<bigint>;
  epoch(): Promise<bigint>;
  chainIdentifier(): Promise<string>;
};

/** A sponsor over an operator signer. `chain` reads the network's state. */
export function operatorWalletSponsor(signer: Signer, chain: GasReader, budget = 20_000_000n): WalletSponsor {
  const address = signer.toSuiAddress();
  return {
    address,
    async gasFor() {
      const [price, epoch, chainId] = await Promise.all([chain.referenceGasPrice(), chain.epoch(), chain.chainIdentifier()]);
      return { owner: address, price, budget, epoch, chain: chainId, nonce: randomInt(0, 2 ** 32) };
    },
    async sign(bytes: Uint8Array) {
      const { signature } = await signer.signTransaction(bytes);
      return signature;
    },
  };
}

/** The configured sponsor, or why there is none. */
export async function walletSponsorFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; sponsor: WalletSponsor } | { ok: false; reason: string }> {
  if ((env.WALLET_GAS_SPONSOR ?? '').trim() !== 'operator') {
    return { ok: false, reason: 'business wallet transactions need a gas sponsor, and WALLET_GAS_SPONSOR is not set to operator' };
  }
  const [{ getOperatorSigner }, { suiClient }] = await Promise.all([import('@/lib/server/operator-signer'), import('@/lib/sui')]);
  const signer = await getOperatorSigner();
  if (!signer) return { ok: false, reason: 'WALLET_GAS_SPONSOR=operator, but no operator signer is configured (OPERATOR_KMS_KEY_ID)' };
  const sponsor = operatorWalletSponsor(signer, {
    referenceGasPrice: async () => BigInt((await suiClient.core.getReferenceGasPrice()).referenceGasPrice),
    epoch: async () => BigInt((await suiClient.core.getCurrentSystemState()).systemState.epoch),
    chainIdentifier: async () => (await suiClient.core.getChainIdentifier()).chainIdentifier,
  });
  return { ok: true, sponsor };
}
