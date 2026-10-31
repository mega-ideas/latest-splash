import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { PURPOSE_CODES, RELATIONSHIPS, SOURCES_OF_FUNDS } from '../lib/payments/iso20022.ts';
import { PURPOSE_OPTIONS, RELATIONSHIP_OPTIONS, SOURCE_OPTIONS } from '../lib/transfer/payee.ts';

/**
 * v2 Phase 3, brief 5.4: what the Transfer page is made of. The boards are
 * Transfer step 1, step 3 and the How it works pop-up; what they require is
 * checked here in the source, and the behaviour behind each step is tested
 * where it lives (transfer-plan, transfer-addresses, transfer-receipt,
 * wallet-transfers, transfer-receipts-server).
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flowFiles = readdirSync(new URL('../components/transfer/', import.meta.url)).filter((f) => /\.tsx?$/.test(f));
const flowSource = flowFiles.map((f) => read(`components/transfer/${f}`)).join('\n');

test('Transfer and Send USDC are one flow: the page is the five steps, and the old steps and the settlement-engine container are gone', () => {
  const page = read('app/dashboard/transfer/page.tsx');
  assert.match(page, /<TransferFlow \/>/);
  assert.doesNotMatch(page + read('components/transfer/TransferFlow.tsx'), /SettlementEngineFlow/, 'the settlement-engine container is deleted from Transfer');
  for (const old of ['StepBeneficiary', 'StepDelivery', 'StepQuote', 'StepStatus']) {
    assert.equal(existsSync(new URL(`../components/transfer/${old}.tsx`, import.meta.url)), false, `${old} is replaced`);
  }
  const labels = ['Who you\\u2019re paying', 'Recipient details', 'Amount and pay from', 'Review and approve', 'Receipt'];
  for (const label of labels) assert.match(read('components/transfer/TransferFlow.tsx'), new RegExp(label.replace(/[()]/g, '\\$&')), label);
  assert.match(read('components/transfer/TransferFlow.tsx'), /Send a payment/);
});

test('step 1 has the three cards of the board, and the corridors that are not live are under Pilot access', () => {
  const who = read('components/transfer/StepWho.tsx') + read('lib/transfer/payee.ts');
  for (const title of ['A business bank account', 'A business on Splash', 'A Sui wallet address']) assert.match(who, new RegExp(title), title);
  assert.match(who, /role="radiogroup"/);
  assert.match(who, /aria-checked=\{on\}/);
  const bank = read('components/transfer/DetailsBank.tsx');
  assert.match(bank, /Pilot access/);
  assert.match(bank, /Request access/);
  assert.doesNotMatch(flowSource, /Coming soon/i);
});

test('step 2 for a bank: one set of fields, one input height, one icon gutter, one selected state, and a sheet for what is needed', () => {
  const bank = read('components/transfer/DetailsBank.tsx');
  const ui = read('components/transfer/ui.tsx');
  // No second name field and no second account field.
  assert.match(bank, /Registered name on the account/);
  assert.doesNotMatch(bank, /Registered legal name|Business name/, 'the business name and the registered legal name are one field');
  assert.match(bank, /label="Account number"/);
  assert.doesNotMatch(bank, /label="Bank account"/, 'bank account and account number are one field');
  // One height: every input and select is built from CONTROL (h-11), and none sets its own.
  assert.match(ui, /export const CONTROL = 'h-11 /);
  assert.doesNotMatch(bank, /<input\b|<select\b/, 'no hand-made control with its own height');
  assert.match(ui, /Icon \? 'pl-10' : ''/, 'one icon gutter');
  // The business or person toggle shows exactly one selected state.
  assert.match(bank, /<Segmented label="Business or person"/);
  assert.match(ui, /role="radio"[\s\S]*?aria-checked=\{on\}/);
  // The long "Still needed" list is a button that opens a sheet.
  assert.doesNotMatch(code(flowSource), /Still needed/);
  assert.match(bank, /What&rsquo;s needed for \{form\.country\}/);
  assert.match(bank, /<RequirementsSheet country=\{form\.country\}/);
  assert.match(read('components/transfer/RequirementsSheet.tsx'), /<Modal[^>]*side/);
});

test('a bank payout is never checked against a Sui address field, and no copy says "invalid Sui address"', () => {
  const bank = read('components/transfer/DetailsBank.tsx');
  assert.match(bank, /checkPayeeField\('bank', form\.accountNumber\)/);
  assert.doesNotMatch(bank, /checkSuiAddress|isValidSuiAddress/);
  const wallet = read('components/transfer/DetailsWallet.tsx');
  assert.match(wallet, /checkPayeeField\(kind === 'CROSS_CHAIN' \? 'cross_chain' : kind === 'EXCHANGE' \? 'exchange' : 'sui_wallet'/);
  assert.match(wallet, /field\.address/, 'the normalised long address is what is sent');
  assert.doesNotMatch(code(flowSource + read("lib/transfer/addresses.ts")), /invalid Sui address/i);
});

test('step 2 for a business on Splash searches by registered name, and a wallet is an exchange, a wallet they hold or another chain', () => {
  const business = read('components/transfer/DetailsBusiness.tsx');
  assert.match(business, /Their registered business name/);
  assert.match(business, /\/api\/wallet\/transfers\/businesses\?q=/);
  const wallet = read('components/transfer/DetailsWallet.tsx');
  for (const title of ['An exchange account', 'A wallet they hold', 'USDC on another chain']) assert.match(wallet, new RegExp(title), title);
  assert.match(wallet, /A payment on Sui is final once it is sent/);
});

test('step 3 shows the wallet balance, the shortfall, and "Top up and continue" from verified sources; the draft is kept and the rate is quoted after funds arrive', () => {
  const amount = read('components/transfer/StepAmount.tsx');
  assert.match(amount, /Splash Wallet · USDC/);
  assert.match(amount, /Short by \{formatUsdc\(funds\.shortByMinor\)\} USDC/);
  assert.match(amount, /<TopUpPanel/);
  assert.match(amount, /The rate is quoted once your funds are in/);
  const top = read('components/transfer/TopUpPanel.tsx');
  assert.match(top, /Top up and continue/);
  assert.match(top, /purpose: 'transfer_top_up', transferRef: intentKey/);
  assert.match(top, /acceptedArrivesMinMinor: quote\.arrivesMinMinor/, 'a top-up is made only at a quote the person was shown');
  assert.match(top, /s\.status === 'verified'/, 'only verified sources are offered');
  assert.match(top, /next\.status === 'arrived'/, 'the page goes on only when the server says the funds arrived');
  assert.match(top, /We keep this draft/);
  const flow = read('components/transfer/TransferFlow.tsx');
  assert.match(flow, /draftStorageKey\(ctx\.orgId\)/);
  assert.match(flow, /try \{[\s\S]*?localStorage/, 'storage is wrapped: the page works without it');
  // The rate comes from the review, after the funds are in: step 3 asks for no quote.
  assert.doesNotMatch(amount, /payouts\/quotes|transfers\/quote/);
});

test('step 4 sends the fee it showed as max_fee, plans who approves, and collects signatures on each owner’s own device', () => {
  const review = read('components/transfer/StepReview.tsx');
  assert.match(review, /maxFeeToSend\(\{ feeMinor: quote\.maxFeeMinor \}\)/);
  assert.match(review, /maxFeeMinor: maxFee/);
  assert.match(review, /executableRoute\(\s*approvalPlan\(/);
  assert.match(review, /key: flow\.intentKey/, 'the intent id is the idempotency key');
  assert.match(review, /Approve and collect signatures/);
  assert.match(review, /Ask the owners to approve/);
  assert.match(review, /code === 'fee_changed'/, 'a changed fee is shown again, not sent');
  const sign = read('components/transfer/SignPanel.tsx');
  assert.match(sign, /reviewOnDevice\(/, 'the device decodes the bytes itself');
  assert.match(sign, /signWithPasskey\(/);
  assert.match(sign, /Transaction code/);
  assert.match(sign, /\/signatures`/);
});

test('step 5 is the receipt: share by link, WhatsApp, email and PDF, to the accountant, and the self-billed e-invoice with the MyInvois portal', () => {
  const receipt = read('components/transfer/StepReceipt.tsx');
  for (const text of ['Verified on Sui', 'WhatsApp', 'Email', 'Copy link', 'PDF', 'Send to accountant', 'Self-billed e-invoice (MyInvois)', 'Open MyInvois', 'Check this payment on Sui']) {
    assert.match(receipt, new RegExp(text.replace(/[()]/g, '\\$&')), text);
  }
  assert.match(receipt, /EINVOICE_GUIDELINE\.portal/);
  assert.match(receipt, /rel="noopener noreferrer"/);
  assert.match(receipt, /Splash fills in none of these for you/);
});

test('How it works is a button that opens a pop-up: blurred backdrop, a close X, five steps and the on-chain receipt', () => {
  const flow = read('components/transfer/TransferFlow.tsx');
  assert.match(flow, /How it works/);
  assert.match(flow, /<HowItWorks open=\{how\} onClose=/);
  const how = read('components/transfer/HowItWorks.tsx');
  assert.match(how, /One payment, start to finish/);
  const steps = [...how.matchAll(/\{ title: '/g)];
  assert.equal(steps.length, 5, 'five steps');
  assert.match(how, /The receipt/);
  assert.match(how, /One Sui transaction pays and records it/);
  const ui = read('components/transfer/ui.tsx');
  assert.match(ui, /backdrop-blur/);
  assert.match(ui, /aria-label="Close"/);
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /event\.key === 'Escape'/);
});

test('the copy rules hold on every Transfer file: no Demo, no testnet, no coral, no licence or custody claims, no partner named, and no fee rate typed in', () => {
  for (const f of flowFiles) {
    const text = read(`components/transfer/${f}`);
    assert.deepEqual(copyViolations(`components/transfer/${f}`, text), [], f);
    assert.doesNotMatch(code(text), /\bDemo\b|\bDEMO\b/, f);
    assert.doesNotMatch(text, /testnet/i, f);
    assert.doesNotMatch(text, /coral|E39774/i, f);
    assert.doesNotMatch(text, /non-custodial|\blicensed\b/i, f);
    assert.doesNotMatch(text, /\bPDAX\b|\bDurianPay\b|\bHata\b|\bFiuu\b|\bHalliday\b|\bTransFi\b/, `${f} names a partner`);
    assert.doesNotMatch(text, /\b\d+(\.\d+)?\s?(%|bps)/i, `${f} types a rate`);
    assert.doesNotMatch(text, /text-\[1[01]px\]/, `${f} sets text under 12px`);
  }
});

test('every Transfer route takes the business from the session, and nothing money-moving takes a client’s bundle', () => {
  const routes = ['route.ts', 'quote/route.ts', 'businesses/route.ts', '[ref]/route.ts', '[ref]/receipt/route.ts', '[ref]/share/route.ts', '[ref]/e-invoice/route.ts'];
  for (const r of routes) {
    const text = read(`app/api/wallet/transfers/${r}`);
    assert.match(text, /transferRoute\(request\)/, `${r} goes through the wallet route's gate`);
    assert.doesNotMatch(text, /body\.orgId|body\.accountId|searchParams\.get\('org/, `${r} reads no org from the request`);
  }
  const context = read('app/api/wallet/transfers/context/route.ts');
  assert.match(context, /requireSessionAccount\(auth\.session\)/);
  const payouts = read('app/api/wallet/payouts/route.ts');
  assert.doesNotMatch(code(payouts), /contentHash: body\.|walrusBlobId: body\./, 'a client cannot name the audit bundle');
  assert.match(payouts, /makePaymentRecorder/);
});

test('the words a bank payout is declared with are the same keys the server checks', () => {
  for (const o of PURPOSE_OPTIONS) assert.ok(Object.hasOwn(PURPOSE_CODES, o.code), o.code);
  for (const o of RELATIONSHIP_OPTIONS) assert.ok(Object.hasOwn(RELATIONSHIPS, o.code) && o.code !== 'self', o.code);
  for (const o of SOURCE_OPTIONS) assert.ok(Object.hasOwn(SOURCES_OF_FUNDS, o.code), o.code);
});
