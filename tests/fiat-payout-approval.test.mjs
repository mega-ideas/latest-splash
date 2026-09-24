import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { subjectDigest } from '../lib/server/step-up.ts';
import { fiatPaymentSubstance, fiatTransferSubject } from '../lib/server/step-up-subjects.ts';

/**
 * A single payout in WhatsApp style: what the approval covers, and how the
 * authorize route spends it.
 */

const CTX = { orgId: 'org_1', userId: 'usr_maker' };

/** The authorize body the transfer wizard sends for a Splash-balance payout. */
function wizardBody(overrides = {}) {
  return {
    step: 4,
    recipient: {
      name: 'Manila Parts Supply',
      country: 'PH',
      rail: 'bank',
      bank: { swift: 'BOPIPHMM', account: '001234567890' },
      travelRule: { address: '12 Rizal Ave, Manila' },
    },
    travelRulePayment: { purpose: 'GOODS' },
    amount: { value: '2500', sourceCurrency: 'USD', targetCurrency: 'PHP' },
    deliveryTier: 'PAYOUT_ONLY',
    funding: { selection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' } },
    fundingSelection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' },
    paymentRail: 'SPLASH_BALANCE',
    quote: { fxRate: 56.42, fee: '12.50', netReceived: '140345.00' },
    ...overrides,
  };
}

const digest = (body) => subjectDigest(fiatTransferSubject(CTX, body).subject);

test('the approval covers the payment, not the wizard state around it', () => {
  const approved = digest(wizardBody());
  // Everything the wizard adds or refreshes between approving and sending.
  assert.equal(digest(wizardBody({
    quote: { fxRate: 56.5, fee: '12.40', netReceived: '140500.00' },
    fundingSessionId: 'fs_123',
    funding: { selection: { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' }, sessionId: 'fs_123', sessionStatus: 'CREDITED', qrDataUrl: 'data:image/png;base64,AAAA' },
    step: 5,
    txStatus: 'pending',
    totp: '123456',
    rateHold: { id: 'rh_1', state: 'ACTIVE' },
  })), approved);
  // The approval body the wizard posts to /api/step-up — only the substance.
  const b = wizardBody();
  assert.equal(digest({
    recipient: b.recipient,
    travelRulePayment: b.travelRulePayment,
    amount: { value: b.amount.value, targetCurrency: b.amount.targetCurrency },
    deliveryTier: b.deliveryTier,
    fundingSelection: b.fundingSelection,
  }), approved);
});

test('changing who, where, how much, what currency or which source voids it', () => {
  const approved = digest(wizardBody());
  const base = wizardBody();
  const variants = {
    recipient: { recipient: { ...base.recipient, name: 'Someone Else Trading' } },
    account: { recipient: { ...base.recipient, bank: { ...base.recipient.bank, account: '009999999999' } } },
    swift: { recipient: { ...base.recipient, bank: { ...base.recipient.bank, swift: 'MBTCPHMM' } } },
    amount: { amount: { ...base.amount, value: '25000' } },
    currency: { amount: { ...base.amount, targetCurrency: 'MYR' } },
    source: { fundingSelection: { source: 'BANK_USD', type: 'fiat', provider: 'STRIPE', feeTier: 'STANDARD' } },
    tier: { deliveryTier: 'SWEEP_ACCOUNT' },
    invoice: { invoiceId: 'inv_42' },
    travelRule: { recipient: { ...base.recipient, travelRule: { address: 'elsewhere' } } },
  };
  for (const [name, overrides] of Object.entries(variants)) {
    assert.notEqual(digest(wizardBody(overrides)), approved, `${name} must void the approval`);
  }
});

test('the approval is per requester and per org, and says what it approves', () => {
  const body = wizardBody();
  const mine = fiatTransferSubject(CTX, body);
  assert.equal(mine.subjectId, 'fiat:org_1:usr_maker');
  assert.notEqual(fiatTransferSubject({ ...CTX, userId: 'usr_other' }, body).subjectId, mine.subjectId);
  assert.notEqual(
    subjectDigest(fiatTransferSubject({ ...CTX, orgId: 'org_2' }, body).subject),
    subjectDigest(mine.subject),
  );
  assert.match(mine.summary, /\$2500 payout|payout of \$2500/);
  assert.match(mine.summary, /Manila Parts Supply/);
  assert.match(mine.summary, /PHP/);
});

test('whitespace and letter case in the same payment do not split the digest', () => {
  const base = wizardBody();
  assert.equal(
    subjectDigest(fiatPaymentSubstance(wizardBody({
      recipient: { ...base.recipient, name: '  Manila Parts Supply ', country: 'ph' },
      amount: { ...base.amount, targetCurrency: 'php' },
    }))),
    subjectDigest(fiatPaymentSubstance(base)),
  );
});

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('authorize: WhatsApp style needs an approval for EVERY payout, spent once and given back on refusal', async () => {
  const route = code(await readFile(new URL('../app/api/transfers/authorize/route.ts', import.meta.url), 'utf8'));
  // Not only on the authenticator-code rails: any payout, when the style is on.
  assert.match(route, /if \(settings\.whatsappEnabled && !approvalClaim\.approved\) \{/);
  assert.match(route, /if \(!whatsappApproved\) return approvalRequiredResponse\('FIAT_TRANSFER'\)/);
  // Given back unless the transfer (or a queue proposal) now carries it.
  assert.match(route, /finally \{\s*if \(spent\.release && !spent\.kept\) await spent\.release\(\)/);
  assert.match(route, /await persistTransfer\(intent\);\s*spent\.kept = true;/);
  assert.match(route, /if \(proposal\) spent\.kept = true;/);
});

test('authorize: an approved-proposal claim only counts for the payment it approved', async () => {
  const route = code(await readFile(new URL('../app/api/transfers/authorize/route.ts', import.meta.url), 'utf8'));
  assert.match(
    route,
    /subjectDigest\(fiatPaymentSubstance\(claim\.payload\)\) === subjectDigest\(fiatPaymentSubstance\(rawBody as Record<string, unknown>\)\)/,
  );
  // One resolution, used for both the second-approver lift and the WhatsApp skip.
  assert.equal(route.match(/resolveApprovalClaim\(/g).length, 1);
});

test('the wizard waits for the approval before Send, and asks again when it lapses', async () => {
  const wizard = code(await readFile(new URL('../components/transfer/StepQuote.tsx', import.meta.url), 'utf8'));
  assert.match(wizard, /<ApprovalFlow[\s\S]*?purpose="FIAT_TRANSFER"/);
  assert.match(wizard, /disabled=\{!agree \|\| awaitingApproval/);
  assert.match(wizard, /body\.code === 'approval_required'/);
});
