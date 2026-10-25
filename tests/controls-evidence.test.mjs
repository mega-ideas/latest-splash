/**
 * The per-payment controls evidence (v2 §4.6, D12), the sender-declaration
 * pack, and the Travel Rule step of a payment to an exchange recipient.
 *
 * What must hold:
 *   - one payment's evidence names the KYB case and its provider reference,
 *     the KYT screening of the address paid (provider, reference, result),
 *     the signing request with its threshold and signers, the spending rule
 *     and second approval, the quote, the partner's references, the masked
 *     ISO 20022 copy, and from the chain the Sui digest, the intent created,
 *     the Walrus blob, the content hash and the receipt;
 *   - it holds no secret, signature, sealed value, salt or account number;
 *   - what is missing is said in `gaps`, and a chain that cannot be read
 *     fills nothing in;
 *   - another business's intent id or request id reads as absent;
 *   - the JSON and the PDF say the same, and the PDF is a well-formed file;
 *   - the sender declaration and the Travel Rule message are built from
 *     what the server holds, the Travel Rule message only for a recipient
 *     whose newest screening is CLEAR, once per payment.
 *
 * PGlite with every migration; rows written directly. Nothing reaches a
 * network, nothing is signed.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import * as schema from '../lib/db/schema.ts';
import { assertEvidenceClean, evidenceJson, evidencePdf, evidenceSha256, EvidenceLeak, maskTail } from '../lib/compliance/controls-evidence.ts';
import { pdfSafeText, renderTextPdf, wrapText } from '../lib/compliance/pdf-text.ts';
import { senderDeclaration } from '../lib/compliance/sender-declaration.ts';
import { travelRuleProviderFromEnv } from '../lib/compliance/sumsub.ts';
import { bytesHex, chainFacts, controlsEvidenceFor } from '../lib/server/controls-evidence.ts';
import { senderDeclarationFor, travelRuleForPayment } from '../lib/server/exchange-payment-compliance.ts';
import { recordScreening } from '../lib/server/kyt-screenings.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const CORE = `0x${'c0'.repeat(32)}`;
const WALLET = `0x${'b2'.repeat(32)}`;
const DEPOSIT = `0x${'c3'.repeat(32)}`;
const INTENT = `0x${'a1'.repeat(32)}`;
const DIGEST = 'Fq3nXdigest1111111111111111111111111111111';
const ACCOUNT_NUMBER = '0012-3456-7890';
const SEALED = 'sealed:v1:SEALEDACCOUNTBYTES';
const SALT = 'sealed:v1:SALTBYTES';

const ISO = {
  messageDefinition: 'pacs.008.001.08',
  endToEndId: 'SPL-A1A1A1A1',
  uetr: '6f1c7e0a-1b2c-4d3e-8f90-a1a1a1a1a1a1',
  instructedAmount: { Ccy: 'USDC', value: '1000.000000' },
  settlementAmount: { Ccy: 'PHP', value: '56000.00' },
  exchangeRate: '56.000000',
  chargeBearer: 'SHAR',
  charges: [],
  debtor: { name: 'Acme Trading Sdn Bhd', registration: 'CINC ****2345', country: 'MY', wallet: WALLET },
  creditor: { name: 'Dela Cruz Trading Corp', registration: 'CINC ****2345', town: 'Makati', country: 'PH' },
  creditorAgent: 'BNORPHMM',
  creditorAccountLast4: '7890',
  purposeCode: 'GDDS',
  relationship: 'SUPPLIER',
  sourceOfFunds: 'BUSINESS_REVENUE',
  remittanceInfo: 'INV-1',
  depositAddress: DEPOSIT,
  beneficiaryRef: 'ab'.repeat(32),
};

async function world() {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'owner@acme.test', 'Owner'), ('u-owner2', 'owner2@acme.test', 'Owner Two'), ('u-nw', 'owner@northwind.test', 'NW')`);
  await client.exec(`UPDATE organizations SET legal_name = 'Acme Trading Sdn Bhd', registration_number = '202001012345', address_line1 = 'Jalan Ampang', address_city = 'Kuala Lumpur', address_postal_code = '50450', address_country = 'MY', kyb_lifecycle = 'ACTIVE' WHERE id = 'acme'`);
  await db.insert(schema.kybCases).values({ id: 'kyb_acme_1', orgId: 'acme', businessName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', state: 'APPROVED', sumsubApplicantId: 'applicant-001' });
  return { db, client };
}

async function signingRequest(db, { orgId = 'acme', purpose, summary, status = 'executed', executedDigest = DIGEST }) {
  const id = `wsr_${randomUUID()}`;
  await db.insert(schema.walletSigningRequests).values({
    id, orgId, purpose, dedupeKey: id, senderAddress: WALLET, signerKind: 'multisig', multisigPublicKey: 'msig-pk', threshold: 2, gasMode: 'sponsored',
    txBytes: 'AAAA', txDigest: `digest-${id}`, bytesHash: 'h'.repeat(64), summary, status, requestedBy: orgId === 'acme' ? 'u-owner' : 'u-nw',
    expiresAt: new Date(T0.getTime() + 3_600_000), executedDigest, createdAt: T0,
  });
  const signers = orgId === 'acme'
    ? [{ userId: 'u-owner', address: `0x${'01'.repeat(32)}`, signedAt: T0, signatureSha256: 's'.repeat(64) }, { userId: 'u-owner2', address: `0x${'02'.repeat(32)}`, signedAt: T0, signatureSha256: 't'.repeat(64) }]
    : [{ userId: 'u-nw', address: `0x${'03'.repeat(32)}`, signedAt: T0, signatureSha256: 'u'.repeat(64) }];
  await db.insert(schema.walletSigningSigners).values(signers.map((s) => ({ requestId: id, orgId, publicKey: `pk-${s.userId}`, weight: 1, ...s })));
  return id;
}

async function supplierPayout(db) {
  await db.insert(schema.withdrawalDestinations).values({
    id: 'wdd_1', orgId: 'acme', partner: 'pdax', country: 'PH', currency: 'PHP', bankCode: 'BNORPHMM', holderName: 'Dela Cruz Trading Corp', bankHolderName: 'DELA CRUZ TRADING CORP',
    nameCheckRef: 'nc-1', fingerprint: 'fp-1', last4: '7890', accountSealed: SEALED, beneficiarySaltSealed: SALT, beneficiaryRef: 'ab'.repeat(32), label: 'Dela Cruz', kind: 'supplier', partySealed: 'sealed:v1:PARTY', relationship: 'supplier',
    status: 'verified', verifiedAt: T0, verifiedBy: 'u-owner', createdBy: 'u-owner',
  });
  await db.insert(schema.partnerDepositAddresses).values({ id: 'pda_1', orgId: 'acme', partner: 'pdax', address: DEPOSIT, accountRef: 'acct-1', status: 'verified', testAmountMinor: 1_000_000n, createdBy: 'u-owner' });
  const requestId = await signingRequest(db, {
    purpose: 'partner_payout',
    summary: {
      description: { digest: 'd', bytesHash: 'h', sender: WALLET, gas: {}, validity: null, actions: [{ type: 'open_intent', asset: 'USDC', recipient: DEPOSIT, amountMinor: '1000000000', kind: 4, targetCurrency: 'PHP', fxRateUsdLocal: '56000000', beneficiaryRef: 'ab'.repeat(32), expiresAtMs: '1' }, { type: 'pay_intent', asset: 'USDC', maxFeeMinor: '2500000', settleByMs: '2', paysFromCommand: 0, intentFromCommand: 0, intent: null }] },
      withdrawal: { last4: '7890' },
    },
  });
  await db.insert(schema.withdrawals).values({
    id: 'wdr_00000000-0000-4000-8000-000000000001', orgId: 'acme', clientKey: 'ck-1', requestHash: 'rh', partner: 'pdax', destinationId: 'wdd_1', depositAddressId: 'pda_1', depositAddress: DEPOSIT, walletAddress: WALLET,
    paymentRef: 'ef'.repeat(32), intentId: INTENT, beneficiaryRef: 'ab'.repeat(32), commitmentSaltSealed: SALT, amountMinor: 1_000_000_000n, maxFeeMinor: 2_500_000n, currency: 'PHP', rateMicro: 56_000_000n,
    receiveMinor: 5_590_000n, quote: { partnerFees: [{ partner: 'our Philippines payout partner', label: 'Payout fee', currency: 'PHP', amountMinor: '10000' }], sandbox: true, splashFeeMinor: '2500000', feesOn: true },
    quoteRef: 'q-ref-1', quoteExpiresAt: T0, partnerRef: 'pdax-order-1', signingRequestId: requestId, suiDigest: DIGEST, bankRef: 'BANKREF001', kind: 'supplier_payout', purposeCode: 'GDDS', iso20022: ISO,
    status: 'paid_out', createdBy: 'u-owner',
  });
  return requestId;
}

const chainTx = (overrides = {}) => ({
  digest: DIGEST,
  success: true,
  sender: WALLET,
  balanceChanges: [],
  events: [
    { packageId: CORE, eventType: `${CORE}::payment_intent::IntentCreated`, json: { intent_id: INTENT } },
    { packageId: CORE, eventType: `${CORE}::payment_intent::IntentConfirmed`, json: { intent_id: INTENT } },
    { packageId: CORE, eventType: `${CORE}::audit_anchor::SettlementAnchored`, json: { intent_id: INTENT, walrus_blob_id: [0xde, 0xad, 0xbe, 0xef], content_hash: Buffer.from('ab'.repeat(32), 'hex').toString('base64') } },
  ],
  ...overrides,
});

const deps = (db, orgId = 'acme', readTransaction = async () => chainTx()) => ({ db, orgId, now: () => T0, readTransaction, corePackageOriginalId: CORE });

/* 1 ── A supplier payout's evidence ─────────────────────────────────────── */

test("a supplier payout's evidence names every control, from the stores and the chain", async () => {
  const w = await world();
  const requestId = await supplierPayout(w.db);
  await recordScreening(w.db, { orgId: 'acme', kind: 'exchange_recipient', chain: 'SUI', address: DEPOSIT, screening: { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:analysis-100', detail: 'ok', screenedAt: T0.toISOString(), riskScore: 0.4 }, requestedBy: 'u-owner' });
  const r = await controlsEvidenceFor(deps(w.db), INTENT, 'u-owner');
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = r.evidence;
  assert.deepEqual([e.schema, e.payment.kind, e.payment.status, e.payment.intentId, e.payment.amountMinor, e.payment.paidTo, e.payment.fromWallet], ['splash.controls-evidence.v1', 'supplier_payout', 'paid_out', INTENT, '1000000000', DEPOSIT, WALLET]);
  assert.deepEqual(e.kyb, { caseId: 'kyb_acme_1', state: 'APPROVED', provider: 'sumsub', providerApplicantRef: 'applicant-001', lifecycle: 'ACTIVE', updatedAt: e.kyb.updatedAt });
  assert.deepEqual(e.screenings.map((s) => [s.provider, s.reference, s.verdict]), [['elliptic', 'elliptic:analysis-100', 'CLEAR']]);
  assert.equal(e.approval.signingRequestId, requestId);
  assert.equal(e.approval.threshold, 2);
  assert.deepEqual(e.approval.signers.map((s) => [s.userId, s.signedAt]), [['u-owner', T0.toISOString()], ['u-owner2', T0.toISOString()]]);
  assert.deepEqual([e.quote.reference, e.quote.rateMicro, e.quote.receiveMinor, e.quote.splashFeeMinor, e.quote.sandbox], ['q-ref-1', '56000000', '5590000', '2500000', true]);
  assert.deepEqual(e.partner, { route: 'pdax', reference: 'pdax-order-1', bankRef: 'BANKREF001', creditorAccountLast4: '****7890' });
  assert.equal(e.iso20022.endToEndId, 'SPL-A1A1A1A1');
  assert.deepEqual(e.chain, { suiDigest: DIGEST, intentIdOnChain: INTENT, walrusBlobId: 'deadbeef', contentHash: 'ab'.repeat(32), receiptId: `${DIGEST}#2` });
  assert.deepEqual(e.gaps, []);
  // The same payment by its payout id and by its signing request.
  assert.equal((await controlsEvidenceFor(deps(w.db), 'wdr_00000000-0000-4000-8000-000000000001', 'u')).evidence.payment.intentId, INTENT);
  assert.equal((await controlsEvidenceFor(deps(w.db), requestId, 'u')).evidence.payment.kind, 'supplier_payout');
});

test('the evidence holds no secret, signature, sealed value, salt or account number', async () => {
  const w = await world();
  await supplierPayout(w.db);
  const r = await controlsEvidenceFor(deps(w.db), INTENT, 'u-owner');
  const json = evidenceJson(r.evidence);
  for (const needle of [ACCOUNT_NUMBER, '34567890', SEALED, SALT, 'sealed:v1:PARTY', 'SEALEDACCOUNTBYTES', 's'.repeat(64), 'AAAA', 'msig-pk']) {
    assert.ok(!json.includes(needle), needle);
  }
  const pdf = Buffer.from(evidencePdf(r.evidence)).toString('latin1');
  for (const needle of [ACCOUNT_NUMBER, SEALED, SALT]) assert.ok(!pdf.includes(needle), needle);
  // A field added later that would leak is refused.
  for (const leak of [{ accountNumber: '1' }, { a: { commitmentSaltSealed: 'x' } }, { signature: 'x' }, { list: [{ apiSecret: 'x' }] }, { note: 'suiprivkey1qq...' }, { txBytes: 'x' }]) {
    assert.throws(() => assertEvidenceClean({ ...r.evidence, extra: leak }), EvidenceLeak, JSON.stringify(leak));
  }
  assert.equal(maskTail('0012-3456-7890'), '****7890');
  assert.equal(maskTail('12'), '****12');
  assert.equal(maskTail(null), null);
});

test("another business's intent, payout or request reads as absent", async () => {
  const w = await world();
  const requestId = await supplierPayout(w.db);
  for (const ref of [INTENT, 'wdr_00000000-0000-4000-8000-000000000001', requestId, 'kyb_acme_1', '../acme', '']) {
    const r = await controlsEvidenceFor(deps(w.db, 'northwind'), ref, 'u-nw');
    assert.deepEqual([r.ok, r.status], [false, 404], ref);
  }
  // A northwind request is not acme's either.
  const nwRequest = await signingRequest(w.db, { orgId: 'northwind', purpose: 'wallet_payment', summary: { description: { actions: [{ type: 'send_funds', asset: 'USDC', recipient: DEPOSIT, amountMinor: '5' }] } } });
  assert.equal((await controlsEvidenceFor(deps(w.db, 'acme'), nwRequest, 'u-owner')).ok, false);
  // A request that is not a payment is not evidence.
  const membership = await signingRequest(w.db, { purpose: 'wallet_membership', summary: {} });
  assert.equal((await controlsEvidenceFor(deps(w.db), membership, 'u-owner')).status, 404);
});

test('a chain that cannot be read fills nothing in and says so; a failed transaction says so', async () => {
  const w = await world();
  await supplierPayout(w.db);
  const down = await controlsEvidenceFor(deps(w.db, 'acme', async () => { throw new Error('rpc down'); }), INTENT, 'u');
  assert.deepEqual(down.evidence.chain, { suiDigest: DIGEST, intentIdOnChain: null, walrusBlobId: null, contentHash: null, receiptId: null });
  assert.ok(down.evidence.gaps.some((g) => /could not be read from the chain/.test(g)));
  const failed = await controlsEvidenceFor(deps(w.db, 'acme', async () => chainTx({ success: false })), INTENT, 'u');
  assert.equal(failed.evidence.chain.intentIdOnChain, null);
  assert.ok(failed.evidence.gaps.some((g) => /failed on chain/.test(g)));
  // An anchor for another intent, or from another package, is not this payment's receipt.
  const other = chainTx({ events: [
    { eventType: `${CORE}::payment_intent::IntentCreated`, json: { intent_id: INTENT } },
    { eventType: `${CORE}::audit_anchor::SettlementAnchored`, json: { intent_id: `0x${'99'.repeat(32)}`, walrus_blob_id: [1], content_hash: [2] } },
    { eventType: `0x${'66'.repeat(32)}::audit_anchor::SettlementAnchored`, json: { intent_id: INTENT, walrus_blob_id: [1], content_hash: [2] } },
  ] });
  const f = chainFacts(other, CORE, INTENT);
  assert.deepEqual([f.intentIdOnChain, f.receiptId, f.walrusBlobId], [INTENT, null, null]);
  // No package id known: the chain is not read.
  let read = 0;
  const noPkg = await controlsEvidenceFor({ ...deps(w.db, 'acme', async () => { read += 1; return chainTx(); }), corePackageOriginalId: null }, INTENT, 'u');
  assert.equal(read, 0);
  assert.ok(noPkg.evidence.gaps.some((g) => /package id/.test(g)));
  assert.equal(bytesHex('0xABcd'), 'abcd');
  assert.equal(bytesHex([1, 255]), '01ff');
  assert.equal(bytesHex(Buffer.from([7]).toString('base64')), '07');
  assert.equal(bytesHex({}), null);
});

test('gaps are named: no KYB case, no screening, nothing sent', async () => {
  const { db, client } = await migratedDb();
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u-owner', 'o@acme.test', 'O'), ('u-owner2', 'o2@acme.test', 'O2')`);
  const requestId = await signingRequest(db, { purpose: 'wallet_payment', status: 'collecting', executedDigest: null, summary: { description: { actions: [{ type: 'send_funds', asset: 'USDC', recipient: DEPOSIT, amountMinor: '5000000' }] } } });
  const r = await controlsEvidenceFor(deps(db), requestId, 'u-owner');
  assert.equal(r.ok, true);
  assert.equal(r.evidence.kyb, null);
  assert.deepEqual([r.evidence.payment.kind, r.evidence.payment.amountMinor, r.evidence.quote, r.evidence.partner], ['wallet_payment', '5000000', null, null]);
  for (const re of [/no KYB case/, /No KYT screening of the recipient/, /not been sent to the chain/]) assert.ok(r.evidence.gaps.some((g) => re.test(g)), String(re));
});

test('a payment under a spending rule names its allowance and policy, and a second approval its policy', async () => {
  const w = await world();
  const intent = { intentId: INTENT, recipient: DEPOSIT, amountMinor: '12000000000', kind: 1, targetCurrency: 'USD', fxRateUsdLocal: '1000000', expiresAtMs: '9', asset: 'USDC' };
  const requestId = await signingRequest(w.db, {
    purpose: 'wallet_payment',
    summary: {
      description: { actions: [{ type: 'pay_intent', asset: 'USDC', maxFeeMinor: '100', settleByMs: '5', paysFromCommand: 0, intentFromCommand: null, intent }, { type: 'approve_payout', policy: `0x${'70'.repeat(32)}`, intent, payer: `0x${'71'.repeat(32)}`, maxTotalMinor: '1', settleByMs: '5' }] },
      spend: { policyIds: [`0x${'70'.repeat(32)}`], allowanceIds: [`0x${'72'.repeat(32)}`] },
    },
  });
  const r = await controlsEvidenceFor(deps(w.db), requestId, 'u-owner');
  assert.deepEqual(r.evidence.approval.spendingRule, { policyIds: [`0x${'70'.repeat(32)}`], allowanceIds: [`0x${'72'.repeat(32)}`] });
  assert.equal(r.evidence.approval.secondApproval.payer, `0x${'71'.repeat(32)}`);
  assert.equal(r.evidence.payment.intentId, INTENT);
  assert.equal(r.evidence.payment.maxFeeMinor, '100');
});

/* 2 ── The documents ─────────────────────────────────────────────────────── */

function assertWellFormedPdf(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  // Every object offset in the table points at its object.
  const count = Number(/xref\n0 (\d+)\n/.exec(text)[1]);
  const rows = text.slice(startxref).split('\n').slice(3, 3 + count - 1);
  rows.forEach((row, i) => assert.equal(text.slice(Number(row.slice(0, 10)), Number(row.slice(0, 10)) + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  // Each stream's declared length is its length.
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream');
  }
  return text;
}

test('the PDF is well formed, says what the JSON says, and carries its hash', async () => {
  const w = await world();
  await supplierPayout(w.db);
  const r = await controlsEvidenceFor(deps(w.db), INTENT, 'u-owner');
  const text = assertWellFormedPdf(evidencePdf(r.evidence));
  for (const needle of ['kyb_acme_1', 'applicant-001', 'pdax-order-1', 'q-ref-1', 'deadbeef', `${DIGEST}#2`, '****7890', evidenceSha256(r.evidence)]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.equal(evidencePdf(r.evidence).length, evidencePdf(r.evidence).length, 'deterministic');
  // Long and non-ASCII text stays inside the page and inside the font.
  assert.equal(pdfSafeText('Café “x” – PT Sūmber (1)'), 'Cafe "x" - PT Sumber (1)');
  assert.equal(pdfSafeText('漢字'), '??');
  assert.ok(wrapText('word '.repeat(60)).every((l) => l.length <= 88));
  const many = renderTextPdf(Array.from({ length: 200 }, (_, i) => ({ kind: 'text', text: `line ${i} (with a paren) \\ and a backslash` })));
  const t = assertWellFormedPdf(many);
  assert.match(t, /\/Count 4 /);
  assert.ok(t.includes('\\(with a paren\\) \\\\ and a backslash'));
});

test('the sender declaration names the exchange only when signed, and hashes its JSON', () => {
  const input = {
    payer: { legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', country: 'MY', address: 'Jalan Ampang, Kuala Lumpur' },
    walletAddress: WALLET,
    supplier: { name: 'Dela Cruz Trading Corp', exchange: 'pdax', depositAddress: DEPOSIT },
    amountMinor: 1_250_500_000n,
    invoice: { number: 'INV-1\n<script>', date: '2026-10-20' },
    paymentRef: INTENT,
    suiDigest: null,
    generatedAt: T0,
    signedPartners: new Set(),
  };
  const unsigned = senderDeclaration(input);
  assert.equal(unsigned.json.recipient.exchange, 'our Philippines payout partner');
  assert.ok(!JSON.stringify(unsigned.json).includes('PDAX'));
  assert.ok(!Buffer.from(unsigned.pdf).toString('latin1').includes('PDAX'));
  assert.equal(unsigned.json.amount, '1250.500000');
  assert.equal(unsigned.json.invoice.number, 'INV-1 <script>');
  assert.equal(unsigned.json.invoice.declaredByPayer, true);
  assert.equal(unsigned.sha256, createHash('sha256').update(JSON.stringify(unsigned.json)).digest('hex'));
  const text = assertWellFormedPdf(unsigned.pdf);
  assert.ok(text.includes(unsigned.sha256));
  assert.ok(text.includes(WALLET) && text.includes(DEPOSIT));
  const signed = senderDeclaration({ ...input, signedPartners: new Set(['pdax']) });
  assert.equal(signed.json.recipient.exchange, 'PDAX');
  // Copy rules: no claims the product may not make.
  for (const doc of [unsigned, signed]) {
    const all = JSON.stringify(doc.json) + Buffer.from(doc.pdf).toString('latin1');
    assert.doesNotMatch(all, /non-custodial|licen[cs]ed|regulated|testnet|\bdemo\b/i);
  }
  assert.throws(() => senderDeclaration({ ...input, amountMinor: 0n }));
});

/* 3 ── The exchange payment's compliance steps ──────────────────────────── */

async function exchangePayment(db, orgId = 'acme', amountMinor = '1250500000') {
  return signingRequest(db, { orgId, purpose: 'wallet_payment', status: 'collecting', executedDigest: null, summary: { description: { actions: [{ type: 'open_intent', asset: 'USDC', recipient: DEPOSIT, amountMinor, kind: 1, targetCurrency: 'USD', fxRateUsdLocal: '1000000', beneficiaryRef: '00', expiresAtMs: '9' }, { type: 'pay_intent', asset: 'USDC', maxFeeMinor: '1', settleByMs: '9', paysFromCommand: 0, intentFromCommand: 0, intent: null }] } } });
}

const recipients = (map) => async (orgId, address) => map[`${orgId}:${address}`] ?? null;
const SUPPLIER = { name: 'Dela Cruz', country: 'PH', legalName: 'Dela Cruz Trading Corp', registrationNumber: 'CS201912345', town: 'Makati', street: 'Ayala Avenue', postCode: '1226' };

test('the sender declaration is built from what the server holds, for this business only', async () => {
  const w = await world();
  const requestId = await exchangePayment(w.db);
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: recipients({ [`acme:${DEPOSIT}`]: SUPPLIER }), signedPartners: new Set() };
  const r = await senderDeclarationFor(d, { requestId, exchange: 'pdax', invoiceNumber: 'INV-1', invoiceDate: '2026-10-20' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.pack.json.payer.legalName, r.pack.json.payer.registrationNumber, r.pack.json.sendingWallet.address, r.pack.json.recipient.depositAddress, r.pack.json.recipient.supplierName, r.pack.json.amount, r.pack.json.paymentRef], ['Acme Trading Sdn Bhd', '202001012345', WALLET, DEPOSIT, 'Dela Cruz Trading Corp', '1250.500000', requestId]);
  // Another business, an unsaved supplier, a closed payment, a bad exchange: refused.
  assert.equal((await senderDeclarationFor({ ...d, orgId: 'northwind' }, { requestId, exchange: 'pdax' })).status, 404);
  assert.equal((await senderDeclarationFor({ ...d, recipientAt: recipients({ [`northwind:${DEPOSIT}`]: SUPPLIER }) }, { requestId, exchange: 'pdax' })).code, 'recipient_not_saved');
  assert.equal((await senderDeclarationFor(d, { requestId, exchange: 'binance' })).code, 'bad_exchange');
  assert.equal((await senderDeclarationFor(d, { requestId: 'wsr_nope', exchange: 'pdax' })).code, 'bad_payment');
  const cancelled = await signingRequest(w.db, { purpose: 'wallet_payment', status: 'cancelled', executedDigest: null, summary: {} });
  assert.equal((await senderDeclarationFor(d, { requestId: cancelled, exchange: 'pdax' })).code, 'payment_closed');
});

test('the Travel Rule message goes only to a CLEAR recipient, once, with the business as the applicant', async () => {
  const w = await world();
  const requestId = await exchangePayment(w.db);
  const calls = [];
  const provider = {
    id: 'sumsub', sandbox: false,
    async submitOutbound(input) { calls.push(input); return { provider: 'sumsub', sandbox: false, reference: 'txn-sumsub-7', status: 'submitted' }; },
  };
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: recipients({ [`acme:${DEPOSIT}`]: SUPPLIER }), provider };
  const ask = (o = {}) => travelRuleForPayment({ ...d, ...o }, { requestId, exchange: 'pdax', purpose: 'Invoice INV-1', createdBy: 'u-owner' });
  assert.equal((await ask()).code, 'not_screened');
  const keep = (verdict, n) => recordScreening(w.db, { orgId: 'acme', kind: 'exchange_recipient', chain: 'SUI', address: DEPOSIT, screening: { provider: 'elliptic', verdict, reference: verdict ? `elliptic:a-${n}` : null, detail: 'x', screenedAt: verdict ? new Date(T0.getTime() + n).toISOString() : null }, requestedBy: 'u' });
  await keep('REVIEW', 1);
  assert.equal((await ask()).code, 'screening_review');
  // A CLEAR at another business does not count here.
  await recordScreening(w.db, { orgId: 'northwind', kind: 'exchange_recipient', chain: 'SUI', address: DEPOSIT, screening: { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:nw', detail: 'x', screenedAt: T0.toISOString() }, requestedBy: 'u' });
  assert.equal((await ask()).code, 'screening_review');
  await new Promise((r) => setTimeout(r, 5));
  await keep('BLOCK', 2);
  assert.deepEqual([(await ask()).status, (await ask()).code], [403, 'screening_blocked']);
  await new Promise((r) => setTimeout(r, 5));
  await keep('CLEAR', 3);
  const sent = await ask();
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.deepEqual([sent.created, sent.transfer.reference, sent.transfer.paymentRef], [true, 'txn-sumsub-7', requestId]);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].applicantId, calls[0].originator.walletAddress, calls[0].originator.legalName, calls[0].beneficiary.legalName, calls[0].beneficiary.depositAddress, calls[0].amountMinor], ['applicant-001', WALLET, 'Acme Trading Sdn Bhd', 'Dela Cruz Trading Corp', DEPOSIT, 1_250_500_000n]);
  const again = await ask();
  assert.deepEqual([again.ok, again.created], [true, false]);
  assert.equal(calls.length, 1, 'once per payment');
  // Another business cannot send it.
  assert.equal((await travelRuleForPayment({ ...d, orgId: 'northwind' }, { requestId, exchange: 'pdax', createdBy: 'u-nw' })).status, 404);
  // The evidence now names the Travel Rule message.
  const ev = await controlsEvidenceFor({ db: w.db, orgId: 'acme', now: () => T0, readTransaction: async () => null, corePackageOriginalId: CORE }, requestId, 'u');
  assert.deepEqual([ev.evidence.travelRule.reference, ev.evidence.travelRule.status, ev.evidence.screenings[0].verdict], ['txn-sumsub-7', 'submitted', 'CLEAR']);
});

test('without a provider applicant or a registered address the Travel Rule message is refused', async () => {
  const w = await world();
  const requestId = await exchangePayment(w.db);
  await recordScreening(w.db, { orgId: 'acme', kind: 'exchange_recipient', chain: 'SUI', address: DEPOSIT, screening: { provider: 'elliptic', verdict: 'CLEAR', reference: 'elliptic:a-9', detail: 'x', screenedAt: T0.toISOString() }, requestedBy: 'u' });
  const d = { db: w.db, orgId: 'acme', now: () => T0, recipientAt: recipients({ [`acme:${DEPOSIT}`]: SUPPLIER }), provider: travelRuleProviderFromEnv({ NODE_ENV: 'test' }) };
  await w.client.exec(`UPDATE kyb_cases SET sumsub_applicant_id = NULL`);
  assert.equal((await travelRuleForPayment(d, { requestId, exchange: 'pdax', createdBy: 'u' })).code, 'kyb_applicant_missing');
  await w.client.exec(`UPDATE kyb_cases SET sumsub_applicant_id = 'applicant-001'; UPDATE organizations SET address_country = NULL WHERE id = 'acme'`);
  assert.equal((await travelRuleForPayment(d, { requestId, exchange: 'pdax', createdBy: 'u' })).code, 'originator_incomplete');
  await w.client.exec(`UPDATE organizations SET address_country = 'MY' WHERE id = 'acme'`);
  const sandboxed = await travelRuleForPayment(d, { requestId, exchange: 'pdax', createdBy: 'u' });
  assert.deepEqual([sandboxed.ok, sandboxed.transfer.sandbox, sandboxed.transfer.provider], [true, true, 'sandbox']);
});
