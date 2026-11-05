/**
 * Checking where a payment goes, on the page and again on the server (v2
 * brief 5.4 step 4: "Fix invalid Sui address").
 *
 * What went wrong before, and what this module does about it:
 *
 *   - The payee's field was checked against the wrong kind of value. A bank
 *     payout has an account number, a wallet payment a Sui address, a
 *     cross-chain payment an address on its own chain. Each kind is checked
 *     only against its own rule (`checkPayeeField`), and a value of another
 *     kind is named as that ("That is a Sui address, not a bank account").
 *   - An address pasted from a wallet or an explorer carries a trailing
 *     space, a newline, a zero-width character, quotes, or an upper-case
 *     `0X`, and the strict test refused it as "invalid". `cleanPaste` removes
 *     what a paste adds, and nothing else; the address is then held to the
 *     rule, and the long lower-case form is what is sent and stored.
 *   - A person with no Splash Wallet yet sent a blank sender and saw the
 *     recipient's rule ("A Sui address is 0x followed by 64 hexadecimal
 *     characters"). That is not an address problem: the page says the
 *     business has no wallet yet (`lib/transfer/plan.ts`).
 *
 * The rule for a Sui address is `isValidSuiAddress(normalizeSuiAddress(x))`
 * (the SDK's own), with three refusals the SDK does not make because they are
 * about money: the `0x` is required (digits alone are a bank account, and the
 * SDK would pad them into a "valid" address nobody holds), a 40-hex EVM
 * address is never padded into a Sui one (nobody holds its key), and a
 * truncated paste is never padded either. Cross-chain addresses are checked
 * by their own chain's rule (lib/payments/cctp.ts): an EVM address in its
 * EIP-55 form, a Solana token account in base58.
 *
 * Pure and client-safe.
 */
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import { cleanPaste } from './paste.ts';

export { cleanPaste };

import {
  evmMintRecipient,
  FUNDING_CHAINS,
  FundingPlanError,
  solanaTokenAccountMintRecipient,
  type CctpPeerChain,
} from '../payments/cctp.ts';

export type AddressProblem =
  | 'empty'
  | 'evm_address'
  | 'sui_address_for_bank'
  | 'bank_account_for_wallet'
  | 'not_a_sui_address'
  | 'truncated'
  | 'zero_address'
  | 'bad_chain_address'
  | 'bad_bank_account';

export type AddressCheck = { ok: true; address: string } | { ok: false; code: AddressProblem; message: string };

const fail = (code: AddressProblem, message: string): AddressCheck => ({ ok: false, code, message });

/** Digits, with the spaces and dashes banks print between them. */
const BANK_ACCOUNT_LIKE = /^[0-9][0-9-]{5,33}$/;

/** A Sui address: long lower-case form, or why not. */
export function checkSuiAddress(raw: string): AddressCheck {
  const value = cleanPaste(raw);
  if (value === '') return fail('empty', 'Paste the Sui address.');
  if (BANK_ACCOUNT_LIKE.test(value)) {
    return fail('bank_account_for_wallet', 'That looks like a bank account number. Pay a bank account from "A business bank account"; a Sui address starts with 0x.');
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return fail('evm_address', 'That is an Ethereum-style address. Splash pays USDC on Sui: ask for the Sui address, or pay it as USDC on another chain.');
  }
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    return fail('not_a_sui_address', 'A Sui address is 0x followed by 64 letters and digits (0 to 9, a to f). Copy it again from the wallet.');
  }
  if (value.length < 66) {
    return fail('truncated', 'That address is too short, so part of it may have been cut off. Copy the whole address, 0x and 64 characters.');
  }
  if (value.length > 66) return fail('not_a_sui_address', 'That is longer than a Sui address (0x and 64 characters). Copy it again from the wallet.');
  const address = normalizeSuiAddress(value);
  if (!isValidSuiAddress(address)) {
    return fail('not_a_sui_address', 'A Sui address is 0x followed by 64 letters and digits (0 to 9, a to f). Copy it again from the wallet.');
  }
  if (/^0x0{64}$/.test(address)) return fail('zero_address', 'The zero address cannot receive a payment.');
  return { ok: true, address };
}

/** The chains a person can pick for USDC to another chain (the ones Splash screens and pays; lib/recipients/wallet-recipients.ts). */
export const CROSS_CHAIN_PICKS = ['ETHEREUM', 'BASE', 'ARBITRUM', 'OP_MAINNET', 'POLYGON_POS', 'AVALANCHE', 'SOLANA'] as const;
export type CrossChainPick = (typeof CROSS_CHAIN_PICKS)[number];

export function crossChainLabel(chain: string): string {
  return FUNDING_CHAINS[chain as CctpPeerChain]?.label ?? chain;
}

/** An address on another chain, by that chain's own rule. The address is returned as the chain writes it. */
export function checkCrossChainAddress(chain: string, raw: string): AddressCheck {
  const facts = FUNDING_CHAINS[chain as CctpPeerChain];
  if (!facts || !(CROSS_CHAIN_PICKS as readonly string[]).includes(chain)) {
    return fail('bad_chain_address', `Splash pays USDC to ${CROSS_CHAIN_PICKS.map(crossChainLabel).join(', ')}. Choose one of them.`);
  }
  const value = cleanPaste(raw);
  if (value === '') return fail('empty', 'Paste the address on that chain.');
  try {
    if (facts.addressFormat === 'EVM') {
      if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
        return fail('bad_chain_address', `That is a Sui address. ${facts.label} addresses are 0x and 40 characters.`);
      }
      evmMintRecipient(value);
      return { ok: true, address: value };
    }
    if (/^0x/.test(value)) return fail('bad_chain_address', `That is not a ${facts.label} address. ${facts.label} addresses are written in letters and digits without 0x.`);
    solanaTokenAccountMintRecipient(value);
    return { ok: true, address: value };
  } catch (error) {
    if (error instanceof FundingPlanError) return fail('bad_chain_address', error.message);
    throw error;
  }
}

/** A bank account number as a person types it: digits, with spaces or dashes. Returned with only the digits. */
export function checkBankAccountNumber(raw: string): AddressCheck {
  const value = cleanPaste(raw);
  if (value === '') return fail('empty', 'Enter the account number.');
  if (/^0x[0-9a-fA-F]{20,64}$/.test(value)) {
    return fail('sui_address_for_bank', 'That is a wallet address, not a bank account number. To pay a wallet, choose "A Sui wallet address".');
  }
  if (!BANK_ACCOUNT_LIKE.test(value)) return fail('bad_bank_account', 'An account number is digits only (dashes are fine), 6 to 34 characters.');
  const digits = value.replace(/-/g, '');
  if (digits.length < 6 || digits.length > 34) return fail('bad_bank_account', 'An account number is digits only (dashes are fine), 6 to 34 characters.');
  return { ok: true, address: digits };
}

export type PayeeFieldKind = 'bank' | 'sui_wallet' | 'exchange' | 'splash_business' | 'cross_chain';

/**
 * One field checked against the rule of the kind of payee it belongs to, and
 * only that rule. A bank payout is never checked as a Sui address, and a
 * wallet is never checked as an account number.
 */
export function checkPayeeField(kind: PayeeFieldKind, raw: string, options: { chain?: string } = {}): AddressCheck {
  switch (kind) {
    case 'bank':
      return checkBankAccountNumber(raw);
    case 'cross_chain':
      return checkCrossChainAddress(options.chain ?? '', raw);
    default:
      return checkSuiAddress(raw);
  }
}

/** A Sui address in groups of four characters after the 0x, so two addresses can be compared by eye. Anything else comes back unchanged. */
export function groupAddress(address: string): string {
  const m = /^0x([0-9a-fA-F]{64})$/.exec(address);
  return m ? `0x ${m[1].match(/.{4}/g)!.join(' ')}` : address;
}
