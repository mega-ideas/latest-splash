import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { differsFromApprovedBatch } from '../lib/transfer/approved.ts';

/**
 * v2 Phase 3, brief 5.6: what the Batch payouts page is made of. The stepper
 * (Upload, Review rows, Approve, Send, Receipts), the How it works pop-up, the
 * claims that are gone, and the one currency. The behaviour behind each step is
 * tested where it lives (wallet-batches: review, approval, idempotency,
 * tenants, production; the shape the owners sign; the receipts).
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = readdirSync(new URL('../components/batch/', import.meta.url)).filter((f) => /\.tsx?$/.test(f));
const source = files.map((f) => read(`components/batch/${f}`)).join('\n');
const page = read('app/dashboard/batch/page.tsx');
const everything = `${source}\n${page}`;

test('the page is the five-step stepper, with the old desk and the settlement-engine container gone', () => {
  assert.match(page, /<BatchFlow \/>/);
  const flow = read('components/batch/BatchFlow.tsx');
  for (const label of ['Upload', 'Review rows', 'Approve', 'Send', 'Receipts']) assert.match(flow, new RegExp(`'${label}'`), label);
  assert.match(flow, /aria-current=\{active \? 'step' : undefined\}/);
  assert.match(flow, /Step \{step\} of 5/, 'the phone shows which step it is on');
  assert.doesNotMatch(everything, /SettlementEngineFlow/);
  assert.doesNotMatch(code(everything), /totp|TOTP|authenticator|ApprovalFlow|WhatsApp style/i, 'the owners’ passkeys approve a batch, not a code typed in');
  assert.doesNotMatch(code(everything), /\/api\/batches\/authorize/, 'the old custody batch route is not used');
});

test('the claims nobody can back are gone, and there is one currency', () => {
  for (const claim of [/15.30 bps/i, /cheaper FX/i, /merkle/i, /off-peak/i, /window pricing/i, /netted/i, /Tier 1/i, /immutable approver/i, /atomic compliance/i]) {
    assert.doesNotMatch(everything, claim, String(claim));
  }
  assert.doesNotMatch(everything, /\bRM\b|\bMYR\b|\bPHP\b|\bIDR\b/, 'no second currency beside USDC');
  assert.doesNotMatch(code(everything), /['"`>]\$\s?[0-9]|\$\s?\{(?:usd|amount|total)\b|toFixed\(2\)/i, 'no dollar sign is written beside an amount');
  assert.match(source, /USDC/);
  assert.match(read('lib/batch/sheet.ts'), /currency_marker/);
});

test('the upload step takes a file, pasted rows or a blank row, and says who may be in a batch', () => {
  const upload = read('components/batch/StepUpload.tsx');
  assert.match(upload, /accept="\.csv,\.xlsx"/);
  assert.match(upload, /Or paste rows from a spreadsheet/);
  assert.match(upload, /Start with one blank row/);
  assert.match(upload, /Download a sample sheet/);
  assert.match(upload, /Up to \{BATCH_MAX_PAYMENTS\} payments/);
  assert.match(upload, /A recipient you saved and Splash has screened/);
  assert.match(upload, /one at a time from/);
  assert.doesNotMatch(upload, /name,address,country/, 'the old sheet with a country and a bank reference is gone');
  assert.match(read('lib/batch/file.ts'), /rowsFromRecords\(records\)/);
  assert.doesNotMatch(read('lib/batch/file.ts'), /replace\(\/\[\^0-9\.\\-\]/, 'a currency sign is never stripped from an amount');
});

test('the review step shows each row on its own, with its screening, its recipient and its error, and goes on only when every row is cleared', () => {
  const review = read('components/batch/StepReview.tsx');
  assert.match(review, /Review the rows/);
  assert.match(review, /screened clear/);
  assert.match(review, /Cleared/);
  assert.match(review, /role="alert"/);
  assert.match(review, /Remove the rows that need attention/);
  assert.match(review, /disabled=\{!ready \|\| shortBy > 0n\}/);
  assert.match(review, /aria-label=\{`Remove row \$\{i \+ 1\}`\}/);
  assert.match(review, /Check the rows/);
  assert.match(review, /FEES_OFF_NOTICE/);
  // Fees are the server's, from the schedule: the page types no rate.
  assert.doesNotMatch(code(review), /\b\d+(\.\d+)?\s?(%|bps)/i);
  assert.doesNotMatch(code(review), /buildFeeQuote|usePublishedFees|parseFloat/, 'the page prices nothing itself');
});

test('the approve step: owners sign once on their own devices, a team member prepares, the key is the batch’s intent id, and a scheduled batch is said not to be switched on', () => {
  const approve = read('components/batch/StepApprove.tsx');
  assert.match(approve, /key: intentKey/, 'the intent id is the idempotency key');
  assert.match(approve, /maxFeeMinor: review\.maxFeeMinor/, 'the fee shown is the fee bound sent');
  assert.match(approve, /expectedBatch=\{made\.approved \?\? approvedFromBatch\(batch\)\}/, 'each owner’s device checks the bytes against the batch that was approved');
  assert.match(approve, /Start the signatures/);
  assert.match(approve, /Prepare for the owners/);
  assert.match(approve, /not switched on for your business yet/);
  assert.match(approve, /Splash holds no key to your wallet/);
  const sign = read('components/transfer/SignPanel.tsx');
  assert.match(sign, /differsFromApprovedBatch/);
  assert.match(sign, /payments in one transaction/);
  assert.match(sign, /reviewOnDevice\(/);
  const flow = read('components/batch/BatchFlow.tsx');
  assert.match(flow, /setIntentKey\(newBatchKey\(\)\)/, 'a changed sheet is a new batch with a new intent id');
});

test('the send and receipts steps: the batch is sent once the owners have signed, and each payment has a receipt', () => {
  const send = read('components/batch/StepSend.tsx');
  assert.match(send, /Sending the batch/);
  assert.match(send, /made together or not at all/);
  const receipts = read('components/batch/StepReceipts.tsx');
  assert.match(receipts, /Download for your accountant/);
  assert.match(receipts, /format=csv/);
  assert.match(receipts, /Check the transaction on Sui/);
  assert.match(receipts, /rel="noopener noreferrer"/);
  assert.match(receipts, /not final yet/);
});

test('How it works is a button that opens the same pop-up as Transfer: blurred backdrop, a close X, the steps and the receipts', () => {
  const flow = read('components/batch/BatchFlow.tsx');
  assert.match(flow, /How it works/);
  assert.match(flow, /<HowItWorks open=\{how\} onClose=/);
  const how = read('components/batch/HowItWorks.tsx');
  assert.match(how, /from '\.\.\/transfer\/ui'/, 'the same Modal');
  assert.match(how, /Many payments, one approval/);
  assert.equal([...how.matchAll(/\{ title: '/g)].length, 5, 'five steps');
  assert.match(how, /The receipts/);
  const ui = read('components/transfer/ui.tsx');
  assert.match(ui, /backdrop-blur/);
  assert.match(ui, /aria-label="Close"/);
});

test('the copy rules hold on every batch file: no Demo, no testnet, no coral, no licence or custody claims, no partner named, no rate typed in, nothing under 12px', () => {
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = read(`components/batch/${f}`);
    assert.deepEqual(copyViolations(`components/batch/${f}`, text), [], f);
    assert.doesNotMatch(code(text), /\bDemo\b|\bDEMO\b/, f);
    assert.doesNotMatch(text, /testnet/i, f);
    assert.doesNotMatch(text, /coral|E39774/i, f);
    assert.doesNotMatch(text, /non-custodial|\blicensed\b/i, f);
    assert.doesNotMatch(text, /Coming soon/i, f);
    assert.doesNotMatch(text, /\bPDAX\b|\bDurianPay\b|\bHata\b|\bFiuu\b|\bHalliday\b|\bTransFi\b/, `${f} names a partner`);
    assert.doesNotMatch(text, /\b\d+(\.\d+)?\s?(%|bps)/i, `${f} types a rate`);
    assert.doesNotMatch(text, /text-\[1[01]px\]/, `${f} sets text under 12px`);
  }
  assert.deepEqual(copyViolations('app/dashboard/batch/page.tsx', page), []);
});

test('every batch route takes the business and the role from the session, and nothing takes a client’s bundle or fee', () => {
  const routes = ['route.ts', 'review/route.ts', '[id]/route.ts', '[id]/start/route.ts', '[id]/receipts/route.ts'];
  for (const r of routes) {
    const text = read(`app/api/wallet/batches/${r}`);
    assert.match(text, /batchRoute\(request\)/, `${r} goes through the wallet route's gate`);
    assert.doesNotMatch(text, /body\.orgId|body\.accountId|body\.role|searchParams\.get\('org/, `${r} reads no org or role from the request`);
    assert.doesNotMatch(code(text), /contentHash: body\.|walrusBlobId: body\.|feeMinor: body\./, `${r} lets a client name no bundle and no fee`);
  }
  const create = read('app/api/wallet/batches/route.ts');
  assert.match(create, /sheetRowsFromBody\(body\.rows\)/, 'a row carries three fields and nothing else');
  assert.match(create, /gate\.route\.authority\.role/);
  assert.match(read('app/api/wallet/batches/[id]/start/route.ts'), /schedule: body\.schedule === true/);
  assert.match(read('lib/server/wallet-transfers-deps.ts'), /batchDepsFor/);
  assert.ok(existsSync(new URL('../drizzle/0065_batch_payouts.sql', import.meta.url)));
});

test('a device checks a batch against what was approved: each payment, in order, no more and no fewer', () => {
  const A = `0x${'71'.repeat(32)}`;
  const B = `0x${'72'.repeat(32)}`;
  const expected = [
    { recipient: A, amountMinor: '100', maxFeeMinor: '1' },
    { recipient: B, amountMinor: '200', maxFeeMinor: '2' },
  ];
  const tx = (...pairs) => ({
    actions: pairs.flatMap(([recipient, amountMinor, maxFeeMinor], i) => [
      { type: 'withdraw', amountMinor: String(BigInt(amountMinor) + BigInt(maxFeeMinor)) },
      { type: 'open_intent', recipient, amountMinor, kind: 1 },
      { type: 'pay_intent', maxFeeMinor, paysFromCommand: i * 5, intentFromCommand: i * 5 + 1 },
      { type: 'anchor_receipt' },
      { type: 'delete_intent' },
    ]),
  });
  assert.equal(differsFromApprovedBatch(tx([A, '100', '1'], [B, '200', '2']), expected), null);
  assert.match(differsFromApprovedBatch(tx([A, '100', '1']), expected), /1 payments, and the batch you approved has 2/);
  assert.match(differsFromApprovedBatch(tx([A, '100', '1'], [B, '200', '2'], [A, '1', '0']), expected), /3 payments/);
  assert.match(differsFromApprovedBatch(tx([B, '100', '1'], [A, '200', '2']), expected), /Payment 1 goes to a different address/);
  assert.match(differsFromApprovedBatch(tx([A, '100', '1'], [B, '201', '2']), expected), /Payment 2 is a different amount/);
  assert.match(differsFromApprovedBatch(tx([A, '100', '1'], [B, '200', '9']), expected), /Payment 2 allows a different Splash fee/);
  assert.match(differsFromApprovedBatch(tx(['not an address', '100', '1'], [B, '200', '2']), expected), /different address/);
  assert.match(differsFromApprovedBatch({ actions: [] }, expected), /0 payments/);
});

test('a device refuses a batch that is not exactly five commands per payment, each tied to its own withdrawal and intent', () => {
  const A = `0x${'71'.repeat(32)}`;
  const B = `0x${'72'.repeat(32)}`;
  const expected = [
    { recipient: A, amountMinor: '100', maxFeeMinor: '1' },
    { recipient: B, amountMinor: '200', maxFeeMinor: '2' },
  ];
  const group = (at, recipient, amount, fee, over = {}) => [
    { type: 'withdraw', amountMinor: String(BigInt(amount) + BigInt(fee)) },
    { type: 'open_intent', recipient, amountMinor: amount, kind: 1 },
    { type: 'pay_intent', maxFeeMinor: fee, paysFromCommand: at, intentFromCommand: at + 1, ...over },
    { type: 'anchor_receipt' },
    { type: 'delete_intent' },
  ];
  const good = () => ({ actions: [...group(0, A, '100', '1'), ...group(5, B, '200', '2')] });
  assert.equal(differsFromApprovedBatch(good(), expected), null);

  const extra = good();
  extra.actions.push({ type: 'withdraw', amountMinor: '999' }, { type: 'send_funds', recipient: A, amountMinor: '999' });
  assert.match(differsFromApprovedBatch(extra, expected) ?? '', /commands the batch you approved does not have/, 'a withdrawal and a send tacked on the end');

  const reordered = good();
  [reordered.actions[3], reordered.actions[4]] = [reordered.actions[4], reordered.actions[3]];
  assert.ok(differsFromApprovedBatch(reordered, expected), 'commands out of their order');

  const repaired = { actions: [...group(0, A, '100', '1'), ...group(5, B, '200', '2', { paysFromCommand: 0 })] };
  assert.match(differsFromApprovedBatch(repaired, expected) ?? '', /Payment 2.*own withdrawal/i, 'a payment paid from another payment’s withdrawal');
  const swappedIntent = { actions: [...group(0, A, '100', '1', { intentFromCommand: 6 }), ...group(5, B, '200', '2')] };
  assert.match(differsFromApprovedBatch(swappedIntent, expected) ?? '', /Payment 1.*own/i);

  const fat = good();
  fat.actions[0].amountMinor = '5000';
  assert.match(differsFromApprovedBatch(fat, expected) ?? '', /Payment 1.*withdraws/i, 'a withdrawal larger than the amount plus the fee bound');

  const bank = good();
  bank.actions[6].kind = 4;
  assert.match(differsFromApprovedBatch(bank, expected) ?? '', /Payment 2/, 'a bank payout is not paid in a batch');
});

test('a changed or late review cannot be taken for the rows on the screen, and the review shows its column labels', () => {
  const flow = read('components/batch/BatchFlow.tsx');
  assert.match(flow, /reviewSeq/, 'each review carries a sequence number and a late one is dropped');
  const review = read('components/batch/StepReview.tsx');
  assert.doesNotMatch(code(review), /font-semibold text-\[#1F4452\] md:sr-only/, 'the column labels are visible at desktop widths too');
  assert.match(review, /hidden [^"]*md:grid/, 'a header row of labels above the rows at desktop widths');
  assert.match(code(flow), /takeBatchDraft[\s\S]{0,400}BATCH_MAX_PAYMENTS/, 'a draft from Zeke is capped like a file');
  const sign = read('components/transfer/SignPanel.tsx');
  assert.match(sign, /differsFromApprovedBatch/);
  const stepApprove = read('components/batch/StepApprove.tsx');
  assert.match(stepApprove, /confirmDuplicates/);
  assert.match(stepApprove, /confirmNewPayees/);
});
