import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidSuiAddress, normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';

import {
  checkBankAccountNumber,
  checkCrossChainAddress,
  checkPayeeField,
  checkSuiAddress,
  cleanPaste,
} from '../lib/transfer/addresses.ts';
import { suiRecipientAddress } from '../lib/recipients/wallet-recipients.ts';
import { normaliseSuiAddress } from '../lib/payments/stablecoin-lane.ts';

/**
 * v2 Phase 3, brief 5.4 step 4: "Fix invalid Sui address".
 *
 * Reproduced for the three seeded accounts (demo@, live@, fresh@acme.test:
 * scripts/dev-db.mjs) and each recipient type. None of the three seeded
 * businesses has a Splash Wallet, a passkey address or a saved recipient, so
 * what a person on any of them could hit was:
 *
 *   1. a Sui address pasted from a wallet or an explorer with its trailing
 *      space or newline, a zero-width character, quotes, or an upper-case 0X,
 *      refused as "invalid" by the strict 64-hex tests;
 *   2. a bank account number given to a field that tested it as a Sui address
 *      (and the reverse: digits that `normalizeSuiAddress` pads into an
 *      address nobody holds);
 *   3. a blank sender (no Splash Wallet yet) answered with the RECIPIENT's
 *      rule, "A Sui address is 0x followed by 64 hexadecimal characters".
 *
 * The rule now: `isValidSuiAddress(normalizeSuiAddress(x))` for Sui, per-chain
 * validators for CCTP destinations, and a bank payout is never checked against
 * a Sui address field.
 */

const FULL = `0x${'9c'.repeat(32)}`;
const UPPER = `0x${'9C'.repeat(32)}`;

// The three seeded accounts have no wallet of their own to take an address
// from, so each recipient type gets the same set of realistic pastes.
const SEEDED = ['demo@acme.test', 'live@acme.test', 'fresh@acme.test'];
const PASTES = [
  FULL,
  `${FULL}\n`,
  `  ${FULL}  `,
  `\t${FULL}\r\n`,
  `​${FULL}​`,
  `﻿${FULL}`,
  `"${FULL}"`,
  `<${FULL}>`,
  `0X${'9c'.repeat(32)}`,
  UPPER,
  `0x${'9c'.repeat(16)} ${'9c'.repeat(16)}`,
];

test('every way a Sui address is pasted gives the one long lower-case address, for every seeded account and wallet recipient type', () => {
  for (const account of SEEDED) {
    for (const kind of ['sui_wallet', 'exchange', 'splash_business']) {
      for (const paste of PASTES) {
        const checked = checkPayeeField(kind, paste);
        assert.equal(checked.ok, true, `${account} ${kind}: ${JSON.stringify(paste)} -> ${JSON.stringify(checked)}`);
        assert.equal(checked.address, FULL);
        assert.equal(isValidSuiAddress(normalizeSuiAddress(checked.address)), true);
      }
    }
  }
});

test('the strict tests the old paths used refuse the same pastes, which is the defect', () => {
  // The Sui address on the Send desk and in x402 (lib/payments/stablecoin-lane.ts).
  assert.throws(() => normaliseSuiAddress(`${FULL}\n`));
  assert.throws(() => normaliseSuiAddress(`0X${'9c'.repeat(32)}`));
  // The wallet recipient form (lib/recipients/wallet-recipients.ts), once fixed, takes what a paste carries.
  assert.equal(suiRecipientAddress(`${FULL}\n`), FULL);
  assert.equal(suiRecipientAddress(`​${FULL}`), FULL);
  assert.equal(suiRecipientAddress(`0X${'9c'.repeat(32)}`), FULL);
});

test('an address is held to what money needs: 0x is required, an EVM address is never padded, a short paste is never padded', () => {
  const bare = checkSuiAddress('9c'.repeat(32));
  assert.equal(bare.ok, false, 'digits and letters without 0x are not an address (the SDK would pad them)');
  const evm = checkSuiAddress(`0x${'ab'.repeat(20)}`);
  assert.equal(evm.ok, false);
  assert.equal(evm.code, 'evm_address');
  assert.match(evm.message, /Sui/);
  const cut = checkSuiAddress(FULL.slice(0, 40));
  assert.equal(cut.code, 'truncated');
  const tooLong = checkSuiAddress(`${FULL}ab`);
  assert.equal(tooLong.ok, false);
  const zero = checkSuiAddress(`0x${'0'.repeat(64)}`);
  assert.equal(zero.code, 'zero_address');
  assert.equal(checkSuiAddress('').code, 'empty');
  assert.equal(checkSuiAddress('   ').code, 'empty');
  const typo = checkSuiAddress(`0x${'9c'.repeat(31)}9z`);
  assert.equal(typo.ok, false);
  assert.equal(typo.code, 'not_a_sui_address');
});

test('a bank account number is never checked as a Sui address, and a wallet is never checked as an account number', () => {
  for (const account of ['0012-3456-7890', '8830123456', '001234567890123']) {
    const bank = checkPayeeField('bank', account);
    assert.equal(bank.ok, true, account);
    assert.equal(bank.address, account.replace(/-/g, ''));
    // The same digits in a wallet field are named for what they are.
    const asWallet = checkPayeeField('sui_wallet', account);
    assert.equal(asWallet.ok, false);
    assert.equal(asWallet.code, 'bank_account_for_wallet');
  }
  const walletInBank = checkPayeeField('bank', FULL);
  assert.equal(walletInBank.ok, false);
  assert.equal(walletInBank.code, 'sui_address_for_bank');
  assert.match(walletInBank.message, /wallet/i);
  assert.equal(checkBankAccountNumber('12').ok, false);
  assert.equal(checkBankAccountNumber('12ab34567').ok, false);
  assert.equal(checkBankAccountNumber(`${'1'.repeat(35)}`).ok, false);
});

test('USDC to another chain is checked by that chain’s own rule', () => {
  const evm = '0x52908400098527886E0F7030069857D2E4169EE7'; // EIP-55 form
  assert.equal(checkCrossChainAddress('ETHEREUM', evm).ok, true);
  assert.equal(checkCrossChainAddress('BASE', ` ${evm}\n`).ok, true);
  assert.equal(checkCrossChainAddress('ARBITRUM', evm.toLowerCase()).ok, true, 'all lower case carries no checksum to fail');
  const wrongCase = '0x52908400098527886e0F7030069857D2E4169EE7';
  assert.equal(checkCrossChainAddress('ETHEREUM', wrongCase).ok, false, 'a mixed-case address that fails EIP-55 is refused');
  assert.equal(checkCrossChainAddress('ETHEREUM', FULL).ok, false, 'a Sui address is not an Ethereum address');
  assert.equal(checkCrossChainAddress('ETHEREUM', '').code, 'empty');
  // Solana: base58, no 0x.
  const solana = toBase58(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  assert.equal(checkCrossChainAddress('SOLANA', solana).ok, true);
  assert.equal(checkCrossChainAddress('SOLANA', evm).ok, false);
  assert.equal(checkCrossChainAddress('SOLANA', 'not base58 !!').ok, false);
  // A chain Splash does not pay.
  assert.equal(checkCrossChainAddress('STELLAR', 'G'.padEnd(56, 'A')).ok, false);
  assert.equal(checkCrossChainAddress('', evm).ok, false);
  // The routing function sends a cross-chain field to the chain's rule, not to the Sui rule.
  assert.equal(checkPayeeField('cross_chain', evm, { chain: 'ETHEREUM' }).ok, true);
  assert.equal(checkPayeeField('cross_chain', FULL, { chain: 'ETHEREUM' }).ok, false);
});

test('cleanPaste removes what a paste adds and nothing else', () => {
  assert.equal(cleanPaste(` ​0X${'ab'.repeat(32)}\n`), `0x${'ab'.repeat(32)}`);
  assert.equal(cleanPaste('"quoted"'), 'quoted');
  assert.equal(cleanPaste('a b'), 'ab', 'an address has no spaces inside');
  assert.equal(cleanPaste('0x12-34'), '0x12-34', 'a wrong character stays wrong');
});
