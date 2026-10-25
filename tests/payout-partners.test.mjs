/**
 * Payout partners behind one interface (v2 §4.5): pdax (PH), durianpay (ID,
 * with its exchange partner), hata_fiuu (MY, the business's own bank) and
 * cctp_wallet (USDC to another chain, CCTP V2 only), and the ISO 20022
 * mapping every adapter and the evidence export use.
 *
 * No network, no database, nothing signed. What must hold:
 *   - every route has the five verbs: quote, createPayout (keyed by the
 *     intent id), status, handleWebhook (signature first, replay window) and
 *     returnOrReverse; the bank routes also give a fixed deposit address and
 *     a name enquiry;
 *   - outside production each route is a labelled sandbox; in production it
 *     refuses without credentials and, with them, until its API is wired,
 *     whatever USE_MOCK_APIS says, and no sandbox answer is reachable;
 *   - the partner's fees are its own lines, never Splash's; Circle's fee is
 *     its own line on the cross-chain route;
 *   - an instruction whose ISO 20022 data names another intent, amount,
 *     account, holder or deposit is refused before anything is sent;
 *   - the v1 sweep and the quote engine no longer reach a mock in
 *     production, and no `DEMO_` payout reference is made.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { signWebhook } from '../lib/funding/providers.ts';
import * as ISO from '../lib/payments/iso20022.ts';
import { evmMintRecipient } from '../lib/payments/cctp.ts';
import * as PARTNER from '../lib/payouts/partner.ts';
import { PAYOUT_PARTNER_IDS, PayoutPartnerUnavailable, WebhookRejected } from '../lib/payouts/partner.ts';
import { payoutPartner } from '../lib/payouts/registry.ts';

const INTENT = `0x${'ab'.repeat(32)}`;
const OTHER_INTENT = `0x${'cd'.repeat(32)}`;
const WALLET = `0x${'11'.repeat(32)}`;
const DEPOSIT = `0x${'22'.repeat(32)}`;
const REF = 'ef'.repeat(32);
const NOW = new Date('2026-10-25T08:00:00Z');
const SECRET = randomBytes(32).toString('hex');
const SANDBOX = { NODE_ENV: 'test', PAYOUT_SANDBOX_WEBHOOKS_ENABLED: 'true', PAYOUT_SANDBOX_WEBHOOK_SECRET: SECRET };

const SUPPLIER = {
  PH: { country: 'PH', bankCode: 'BNORPHMM', accountNumber: '001234567890', holderName: 'Dela Cruz Trading Corp' },
  ID: { country: 'ID', bankCode: '014', accountNumber: '8830123456', holderName: 'PT Sumber Makmur' },
  MY: { country: 'MY', bankCode: 'MBBEMYKL', accountNumber: '514012345678', holderName: 'Acme Trading Sdn Bhd' },
};
const ADDRESS = {
  PH: { streetName: 'Ayala Avenue', buildingNumber: '6750', postCode: '1226', townName: 'Makati', country: 'PH' },
  ID: { streetName: 'Jalan Sudirman', buildingNumber: '52', postCode: '12190', townName: 'Jakarta', countrySubDivision: 'DKI Jakarta', country: 'ID' },
  MY: { streetName: 'Jalan Ampang', postCode: '50450', townName: 'Kuala Lumpur', country: 'MY' },
};
const DEBTOR = { name: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', address: { streetName: 'Jalan Ampang', townName: 'Kuala Lumpur', postCode: '50450', country: 'MY' } };

function bankInstruction(country, over = {}) {
  const beneficiary = SUPPLIER[country];
  const currency = country === 'PH' ? 'PHP' : country === 'ID' ? 'IDR' : 'MYR';
  const base = {
    route: 'bank',
    intentId: INTENT,
    expectedUsdcMinor: 1_000_000_000n,
    quoteRef: 'sbq_test_000000000000',
    currency,
    receiveMinor: 5_000_000n,
    minReceiveMinor: 4_900_000n,
    settleByMs: BigInt(NOW.getTime() + 86_400_000),
    beneficiary,
    beneficiaryRef: REF,
    beneficiarySalt: '00'.repeat(32),
    sourceWallet: WALLET,
    depositAddress: DEPOSIT,
    returnAddress: WALLET,
    purposeCode: 'SUPP',
    rateMicro: 56_500_000n,
    debtor: DEBTOR,
    charges: [],
    now: NOW,
    ...over,
  };
  base.iso20022 =
    over.iso20022 ??
    ISO.pacs008ForInstruction({
      intentId: INTENT,
      quoteRef: base.quoteRef,
      expectedUsdcMinor: 1_000_000_000n,
      currency,
      receiveMinor: 5_000_000n,
      rateMicro: 56_500_000n,
      beneficiary,
      beneficiaryRef: REF,
      sourceWallet: WALLET,
      depositAddress: DEPOSIT,
      debtor: DEBTOR,
      creditor: { name: beneficiary.holderName, address: ADDRESS[country] },
      declaration: { purposeCode: 'SUPP', relationship: 'supplier', sourceOfFunds: 'business_revenue', remittanceInfo: 'INV-2026-0042' },
    });
  return base;
}

function cctpInstruction(over = {}) {
  const recipient = '0x52908400098527886E0F7030069857D2E4169EE7';
  return {
    route: 'cctp',
    intentId: INTENT,
    expectedUsdcMinor: 250_000_000n,
    quoteRef: 'sbq_cctp_000000000000',
    currency: 'USDC',
    receiveMinor: 250_000_000n,
    minReceiveMinor: 250_000_000n,
    settleByMs: BigInt(NOW.getTime() + 86_400_000),
    sourceWallet: WALLET,
    returnAddress: WALLET,
    purposeCode: 'SUPP',
    destination: { chain: 'BASE', domain: 6, recipient, mintRecipient: evmMintRecipient(recipient) },
    maxBridgeFeeMinor: 0n,
    minFinalityThreshold: 2000,
    now: NOW,
    ...over,
  };
}

/* ── ISO 20022 ────────────────────────────────────────────────────────── */

test('the recipient form maps to pacs.008-style fields: structured address, purpose, relationship, source of funds, registration, holder name', () => {
  const msg = bankInstruction('PH').iso20022;
  const t = msg.CdtTrfTxInf;
  assert.equal(msg.MsgDefIdr, 'pacs.008.001.08');
  assert.equal(t.Cdtr.Nm, 'Dela Cruz Trading Corp');
  assert.equal(t.CdtrAcct.Nm, 'Dela Cruz Trading Corp', 'the account holder name');
  assert.deepEqual(t.Cdtr.PstlAdr, { StrtNm: 'Ayala Avenue', BldgNb: '6750', PstCd: '1226', TwnNm: 'Makati', Ctry: 'PH' }, 'structured, no address lines');
  assert.equal('AdrLine' in t.Cdtr.PstlAdr, false);
  assert.deepEqual(t.Dbtr.Id, { OrgId: { Othr: [{ Id: '202001012345', SchmeNm: { Cd: 'CINC' }, Issr: 'MY' }] } }, 'the registration number');
  assert.deepEqual(t.Purp, { Cd: 'SUPP' });
  assert.deepEqual(t.RgltryRptg[0].Dtls.map((d) => [d.Tp, d.Cd]), [['RELATIONSHIP', 'supplier'], ['SOURCE_OF_FUNDS', 'business_revenue']]);
  assert.deepEqual(t.RmtInf, { Ustrd: ['INV-2026-0042'] });
  assert.deepEqual(t.CdtrAgt, { FinInstnId: { BICFI: 'BNORPHMM' } }, 'a BIC is a BICFI');
  assert.equal(t.CdtrAcct.Id.Othr.Id, '001234567890');
  assert.deepEqual(t.InstdAmt, { Amt: '1000.000000', Ccy: 'USD' });
  assert.deepEqual(t.IntrBkSttlmAmt, { Amt: '50000.00', Ccy: 'PHP' });
  assert.equal(t.XchgRate, '56.500000');
  assert.equal(t.ChrgBr, 'SHAR');
  assert.equal(t.PmtId.EndToEndId.length, 35, 'EndToEndId fits its 35 characters');
  assert.equal(t.PmtId.EndToEndId, ISO.endToEndIdFor(INTENT));
  assert.match(t.PmtId.UETR, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(ISO.uetrFor(INTENT), t.PmtId.UETR, 'the same UETR on every retry');
  assert.notEqual(ISO.uetrFor(OTHER_INTENT), t.PmtId.UETR);
  assert.deepEqual(t.SplmtryData, { intentId: INTENT, settlementAsset: { symbol: 'USDC', decimals: 6, network: 'sui' }, sourceWallet: WALLET, depositAddress: DEPOSIT, beneficiaryRef: REF });
  // A local clearing code is a clearing-system member id; IDR is whole rupiah.
  const id = bankInstruction('ID').iso20022.CdtTrfTxInf;
  assert.deepEqual(id.CdtrAgt, { FinInstnId: { ClrSysMmbId: { MmbId: '014' }, PstlAdr: { Ctry: 'ID' } } });
  assert.deepEqual(id.IntrBkSttlmAmt, { Amt: '5000000', Ccy: 'IDR' });
});

test('the form is refused, field by field, rather than sent half-filled or in a script a bank cannot check', () => {
  const field = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof ISO.Iso20022Error, String(e));
      return e.field;
    }
    assert.fail('expected a refusal');
  };
  assert.equal(field(() => ISO.normalizeAddress({ country: 'PH' })), 'address.townName');
  assert.equal(field(() => ISO.normalizeAddress({ townName: 'Makati' })), 'address.country');
  assert.equal(field(() => ISO.normalizeAddress({ addressLine: '6750 Ayala Ave, Makati', townName: 'Makati', country: 'PH' })), 'address', 'no free address lines');
  assert.equal(field(() => ISO.normalizeAddress({ townName: 'x'.repeat(36), country: 'PH' })), 'address.townName');
  assert.equal(field(() => ISO.normalizeParty({ name: 'サプライヤー株式会社' })), 'party.name', 'Latin characters only');
  assert.equal(field(() => ISO.normalizeParty({ name: 'Acme', registrationNumber: 'x y z !' })), 'party.registrationNumber');
  assert.equal(field(() => ISO.normalizeParty({ name: 'Acme' }, { requireAddress: true })), 'party.address');
  assert.equal(field(() => ISO.normalizeDeclaration({ relationship: 'supplier', sourceOfFunds: 'business_revenue' }, { thirdParty: true })), 'purposeCode');
  assert.equal(field(() => ISO.normalizeDeclaration({ purposeCode: 'SUPP', sourceOfFunds: 'business_revenue' }, { thirdParty: true })), 'relationship');
  assert.equal(field(() => ISO.normalizeDeclaration({ purposeCode: 'SUPP', relationship: 'supplier' }, { thirdParty: true })), 'sourceOfFunds', 'a payment to another business declares its source of funds');
  assert.equal(field(() => ISO.normalizeDeclaration({ purposeCode: 'SUPP', relationship: 'self', sourceOfFunds: 'business_revenue' }, { thirdParty: true })), 'relationship', 'paying yourself is a withdrawal');
  assert.equal(field(() => ISO.normalizeDeclaration({ purposeCode: 'XXXX', relationship: 'supplier', sourceOfFunds: 'business_revenue' }, { thirdParty: true })), 'purposeCode');
  // The creditor must be the account holder.
  assert.equal(field(() => bankInstruction('PH', { iso20022: ISO.pacs008ForInstruction({ ...isoInput('PH'), creditor: { name: 'Someone Else Inc', address: ADDRESS.PH } }) })), 'creditor.name');
  // A withdrawal is the business itself: no third-party address or source of funds is demanded.
  const own = ISO.pacs008ForInstruction({ ...isoInput('PH'), creditor: { name: SUPPLIER.PH.holderName }, declaration: { purposeCode: 'INTC', relationship: 'self' } });
  assert.equal(own.CdtTrfTxInf.RgltryRptg[0].Dtls.length, 1);
});

function isoInput(country) {
  const b = SUPPLIER[country];
  return {
    intentId: INTENT,
    quoteRef: 'q',
    expectedUsdcMinor: 1_000_000_000n,
    currency: country === 'PH' ? 'PHP' : 'IDR',
    receiveMinor: 5_000_000n,
    rateMicro: 56_500_000n,
    beneficiary: b,
    beneficiaryRef: REF,
    sourceWallet: WALLET,
    depositAddress: DEPOSIT,
    debtor: DEBTOR,
    creditor: { name: b.holderName, address: ADDRESS[country] },
    declaration: { purposeCode: 'SUPP', relationship: 'supplier', sourceOfFunds: 'business_revenue' },
  };
}

test('the evidence export takes the same message, masked: last four digits, town and country only', () => {
  const e = ISO.pacs008Evidence(bankInstruction('PH').iso20022);
  assert.equal(e.creditorAccountLast4, '7890');
  assert.equal(e.creditor.name, 'Dela Cruz Trading Corp');
  assert.equal(e.creditor.town, 'Makati');
  assert.equal(e.creditor.country, 'PH');
  assert.equal(e.debtor.registration, 'CINC ****2345', 'a registration number is masked like the account');
  assert.equal(e.purposeCode, 'SUPP');
  assert.equal(e.relationship, 'supplier');
  assert.equal(e.sourceOfFunds, 'business_revenue');
  assert.equal(e.remittanceInfo, 'INV-2026-0042');
  assert.equal(e.endToEndId, ISO.endToEndIdFor(INTENT));
  const json = JSON.stringify(e);
  assert.ok(!json.includes('001234567890'), 'never the full account number');
  assert.ok(!json.includes('Ayala'), 'never the street');
});

test("the paying business's KYB profile becomes the debtor, or says what is missing", () => {
  const full = ISO.debtorFromProfile({ legalName: 'Acme Trading Sdn Bhd', registrationNumber: '202001012345', addressLine1: 'Jalan Ampang', addressCity: 'Kuala Lumpur', addressState: 'WP Kuala Lumpur', addressPostalCode: '50450', addressCountry: 'MY' });
  assert.deepEqual(full.missing, []);
  assert.equal(full.party.address.townName, 'Kuala Lumpur');
  assert.equal(full.party.registrationScheme, 'CINC');
  const empty = ISO.debtorFromProfile({ legalName: null, registrationNumber: null, addressLine1: null, addressCity: null, addressState: null, addressPostalCode: null, addressCountry: null });
  assert.equal(empty.party, null);
  assert.deepEqual(empty.missing, ['legalName', 'registrationNumber', 'addressCity', 'addressCountry']);
});

/* ── One interface, four routes ───────────────────────────────────────── */

test('every route the brief names has an adapter with the five verbs, and none is a stub outside production', async () => {
  assert.deepEqual([...PAYOUT_PARTNER_IDS].sort(), ['cctp_wallet', 'durianpay', 'hata_fiuu', 'pdax']);
  for (const id of PAYOUT_PARTNER_IDS) {
    const p = payoutPartner(id, SANDBOX);
    assert.equal(p.mode, 'sandbox', id);
    for (const verb of ['quote', 'createPayout', 'status', 'handleWebhook', 'returnOrReverse', 'postSettlement', 'depositAddress', 'checkAccount']) {
      assert.equal(typeof p[verb], 'function', `${id}.${verb}`);
    }
    assert.equal(p.rail, id === 'cctp_wallet' ? 'cctp' : 'bank');
  }
  const { pdaxAdapter } = await import('../lib/server/pdax.ts');
  assert.equal(pdaxAdapter(SANDBOX).id, 'pdax', 'lib/server/pdax.ts serves the interface');
});

test('pdax: PHP to a Philippine bank, a fixed deposit address per business, its own fee lines, and an instruction keyed by the intent id', async () => {
  const p = payoutPartner('pdax', SANDBOX);
  assert.deepEqual([...p.countries], ['PH']);
  assert.deepEqual([...p.currencies], ['PHP']);
  const a = await p.depositAddress({ businessId: WALLET, now: NOW });
  assert.match(a.address, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await p.depositAddress({ businessId: WALLET, now: NOW }), a, 'fixed per business');
  assert.notEqual((await p.depositAddress({ businessId: DEPOSIT, now: NOW })).address, a.address, 'another business, another address');
  assert.notEqual(a.address, (await payoutPartner('durianpay', SANDBOX).depositAddress({ businessId: WALLET, now: NOW })).address, 'one address per partner');
  const q = await p.quote({ currency: 'PHP', sendMinor: 1_000_000_000n, now: NOW });
  assert.equal(q.sandbox, true);
  assert.equal(q.rateMicro, 56_500_000n);
  assert.equal(q.lines.length, 2, 'conversion and bank transfer, separately');
  assert.ok(q.lines.every((l) => l.partner === 'pdax' && l.currency === 'PHP' && /sandbox/.test(l.label)));
  const gross = 5_650_000n; // 1,000 USDC at 56.50, in centavos
  assert.equal(q.receiveMinor, gross - q.lines.reduce((s, l) => s + l.amountMinor, 0n), 'the partner fees come out of what it pays');
  assert.equal(q.expiresAt.getTime(), NOW.getTime() + 5 * 60_000);
  await assert.rejects(p.quote({ currency: 'IDR', sendMinor: 1n, now: NOW }), (e) => e.code === 'currency_not_offered');

  const first = await p.createPayout(bankInstruction('PH'));
  const retry = await p.createPayout(bankInstruction('PH'));
  assert.equal(first.partnerRef, retry.partnerRef, 'a retry names the same order');
  assert.equal(first.sandbox, true);
  assert.doesNotMatch(first.partnerRef, /DEMO/);
  const other = await p.createPayout(bankInstruction('PH', { intentId: OTHER_INTENT, iso20022: ISO.pacs008ForInstruction({ ...isoInput('PH'), intentId: OTHER_INTENT }) }));
  assert.notEqual(other.partnerRef, first.partnerRef, 'another intent, another order');
  assert.deepEqual(await p.status({ intentId: INTENT, partnerRef: first.partnerRef, now: NOW }), { status: 'instructed', sandbox: true });
  assert.equal((await p.returnOrReverse({ intentId: INTENT, partnerRef: first.partnerRef, returnAddress: WALLET, reason: 'not_sent', now: NOW })).accepted, true);
});

test('durianpay: IDR in whole rupiah, the exchange partner’s fee and the disbursement fee as two lines', async () => {
  const p = payoutPartner('durianpay', SANDBOX);
  assert.deepEqual([...p.countries], ['ID']);
  const q = await p.quote({ currency: 'IDR', sendMinor: 100_000_000n, now: NOW });
  assert.equal(q.currency, 'IDR');
  assert.equal(q.rateMicro, 16_250_000_000n);
  assert.equal(q.lines.length, 2);
  assert.match(q.lines[0].label, /exchange partner/i);
  assert.match(q.lines[1].label, /disbursement/i);
  assert.equal(q.receiveMinor + q.lines[0].amountMinor + q.lines[1].amountMinor, 1_625_000n, '100 USDC at 16,250 is Rp 1,625,000, no decimals');
  const order = await p.createPayout(bankInstruction('ID'));
  assert.match(order.partnerRef, /^sb_dp_/);
  await assert.rejects(p.createPayout(bankInstruction('PH')), (e) => e instanceof PayoutPartnerUnavailable, 'a Philippine account is not this route');
});

test('an instruction whose ISO 20022 data is not this payout is refused before the partner hears of it', async () => {
  const p = payoutPartner('pdax', SANDBOX);
  const good = bankInstruction('PH');
  const cases = {
    'another intent': { ...good, intentId: OTHER_INTENT },
    'another amount': { ...good, expectedUsdcMinor: 999_000_000n },
    'another account': { ...good, beneficiary: { ...good.beneficiary, accountNumber: '009999999999' } },
    'another holder': { ...good, beneficiary: { ...good.beneficiary, holderName: 'Someone Else Corp' } },
    'another deposit': { ...good, depositAddress: `0x${'33'.repeat(32)}` },
    'another commitment': { ...good, beneficiaryRef: 'aa'.repeat(32) },
    'another purpose': { ...good, purposeCode: 'GDDS' },
    'no message': { ...good, iso20022: undefined },
    'a cross-chain instruction': cctpInstruction(),
  };
  for (const [why, input] of Object.entries(cases)) {
    await assert.rejects(p.createPayout(input), (e) => e instanceof PayoutPartnerUnavailable && ['bad_instruction', 'not_on_this_route'].includes(e.code), why);
  }
  // Edited after it was built: a changed account inside the message.
  const edited = structuredClone(good.iso20022);
  edited.CdtTrfTxInf.CdtrAcct.Id.Othr.Id = '009999999999';
  await assert.rejects(p.createPayout({ ...good, iso20022: edited }), (e) => e.code === 'bad_instruction');
  const noAddress = structuredClone(good.iso20022);
  delete noAddress.CdtTrfTxInf.Cdtr.PstlAdr;
  await assert.rejects(p.createPayout({ ...good, iso20022: noAddress }), (e) => e.code === 'bad_instruction', "a supplier's structured address is required");
});

test('cctp_wallet: USDC only, CCTP V2 standard from Sui, Circle’s fee its own line, the mint recipient re-derived, and a burn is never reversed', async () => {
  const p = payoutPartner('cctp_wallet', SANDBOX);
  await assert.rejects(p.depositAddress({ businessId: WALLET, now: NOW }), (e) => e.code === 'not_on_this_route', 'no partner deposit address: the burn is in the owners’ transaction');
  await assert.rejects(p.checkAccount({ beneficiary: SUPPLIER.PH, now: NOW }), (e) => e.code === 'not_on_this_route');
  const q = await p.quote({ currency: 'USDC', sendMinor: 250_000_000n, now: NOW, destinationChain: 'BASE' });
  assert.equal(q.lines.length, 1);
  assert.equal(q.lines[0].partner, 'circle', "Circle's fee, never Splash's");
  assert.equal(q.lines[0].amountMinor, 0n, 'Circle lists 0 bps for a standard transfer from Sui');
  assert.equal(q.receiveMinor, 250_000_000n);
  await assert.rejects(p.quote({ currency: 'USDT', sendMinor: 1n, now: NOW, destinationChain: 'BASE' }), (e) => e.code === 'currency_not_offered', 'USDC only');
  await assert.rejects(p.quote({ currency: 'USDC', sendMinor: 1n, now: NOW, destinationChain: 'STELLAR' }), (e) => e.code === 'currency_not_offered', 'not planned where Circle needs a forwarder');
  await assert.rejects(p.quote({ currency: 'USDC', sendMinor: 1n, now: NOW, destinationChain: 'NOBLE' }), (e) => e.code === 'currency_not_offered', 'the legacy-only chain is not CCTP V2');

  const order = await p.createPayout(cctpInstruction());
  assert.equal((await p.createPayout(cctpInstruction())).partnerRef, order.partnerRef, 'keyed by the intent id');
  for (const [why, over] of Object.entries({
    'another mint recipient': { destination: { ...cctpInstruction().destination, mintRecipient: evmMintRecipient('0x000000000000000000000000000000000000dEaD') } },
    'another domain': { destination: { ...cctpInstruction().destination, domain: 0 } },
    'a fast transfer': { minFinalityThreshold: 1000 },
    'a least received above what arrives': { maxBridgeFeeMinor: 10n },
    'not USDC': { currency: 'PHP' },
  })) {
    await assert.rejects(p.createPayout(cctpInstruction(over)), (e) => e instanceof PayoutPartnerUnavailable, why);
  }
  await assert.rejects(p.createPayout(bankInstruction('PH')), (e) => e.code === 'not_on_this_route');
  assert.equal((await p.returnOrReverse({ intentId: INTENT, partnerRef: order.partnerRef, returnAddress: WALLET, reason: 'not_sent', now: NOW })).accepted, true, 'before the burn nothing is at Circle');
  assert.equal((await p.returnOrReverse({ intentId: INTENT, partnerRef: order.partnerRef, returnAddress: WALLET, reason: 'payout_failed', now: NOW })).accepted, false, 'a burn cannot be undone');
});

test("the CBPR+ extended set: '&' and '#' are kept, a bank-checked name with an accent is refused, the business's own text is transliterated", () => {
  assert.equal(ISO.transliterate('Café Ñandú Straße'), 'Cafe Nandu Strasse');
  assert.equal(ISO.transliterate('株式会社'), '', 'another script comes out empty');
  assert.equal(ISO.escapeXmlText('Maju & Jaya <Sdn>'), 'Maju &amp; Jaya &lt;Sdn&gt;');
  assert.equal(ISO.normalizeParty({ name: 'Maju & Jaya Sdn Bhd', address: { streetName: '#12-03, Jalan Ampang', townName: 'Kuala Lumpur', country: 'MY' } }).name, 'Maju & Jaya Sdn Bhd');
  assert.throws(() => ISO.normalizeParty({ name: 'Café Nusantara Sdn Bhd' }, { field: 'supplier' }), (e) => e.field === 'supplier.name' && /without accents/.test(e.message), 'a supplier name is the one its bank checks: refused, with the reason');
  const changed = [];
  assert.equal(ISO.normalizeParty({ name: 'Café Nusantara Sdn Bhd', registrationNumber: '§§' }, { field: 'debtor', lenient: { changed } }).name, 'Cafe Nusantara Sdn Bhd');
  assert.deepEqual(changed, ['debtor.name', 'debtor.registrationNumber'], 'what was changed or left out is listed');
  const d = ISO.debtorFromProfile({ legalName: 'Café Nusantara Sdn Bhd', registrationNumber: '202001012345', addressLine1: 'Jalan Ampang', addressLine2: null, addressCity: 'Kuala Lumpur', addressState: null, addressPostalCode: null, addressCountry: 'MY' });
  assert.equal(d.party.name, 'Cafe Nusantara Sdn Bhd');
  assert.deepEqual(d.transliterated, ['debtor.name']);
});

test('the legacy sweep quotes through the route that pays its currency, and refuses one no route pays', async () => {
  const registry = await import('../lib/payouts/registry.ts');
  assert.equal(typeof registry.bankPartnerForCurrency, 'function');
  assert.deepEqual(['PHP', 'IDR', 'MYR', 'php'].map((c) => registry.bankPartnerForCurrency(c)), ['pdax', 'durianpay', 'hata_fiuu', 'pdax']);
  assert.equal(registry.bankPartnerForCurrency('USD'), null);
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/server/sweep.ts', import.meta.url), 'utf8');
  assert.match(source, /bankPartnerForCurrency\(/, 'the sweep picks the adapter by currency');
  assert.doesNotMatch(source, /pdaxAdapter\(\)\.quote/);
});

test('webhooks: the signature first, inside the replay window, the sandbox secret only outside production', () => {
  const body = JSON.stringify({ type: 'payout.status', eventId: 'evt_pp_0001', partnerRef: 'sb_pdax_x00000', intentId: INTENT, status: 'paid_out', bankRef: 'INSTAPAY-778899' });
  for (const id of PAYOUT_PARTNER_IDS) {
    const p = payoutPartner(id, SANDBOX);
    // Each route has its own sandbox secret, derived from the one configured.
    const SECRET = PARTNER.sandboxWebhookSecretFor ? PARTNER.sandboxWebhookSecretFor(SANDBOX, id) : SANDBOX.PAYOUT_SANDBOX_WEBHOOK_SECRET;
    const ev = p.handleWebhook({ rawBody: body, signature: signWebhook(body, SECRET, NOW), now: NOW });
    assert.equal(ev.kind, 'payout', id);
    assert.equal(ev.intentId, INTENT);
    assert.throws(() => p.handleWebhook({ rawBody: body, signature: signWebhook(body, randomBytes(32).toString('hex'), NOW), now: NOW }), WebhookRejected, `${id}: a forged signature`);
    assert.throws(() => p.handleWebhook({ rawBody: body, signature: signWebhook(body, SECRET, new Date(NOW.getTime() - 10 * 60_000)), now: NOW }), (e) => e instanceof WebhookRejected && e.code === 'stale', `${id}: a replay outside the window`);
    assert.throws(() => p.handleWebhook({ rawBody: body.replace('paid_out', 'failed'), signature: signWebhook(body, SECRET, NOW), now: NOW }), WebhookRejected, `${id}: a body changed after signing`);
    assert.throws(() => payoutPartner(id, { NODE_ENV: 'test' }).handleWebhook({ rawBody: body, signature: signWebhook(body, SECRET, NOW), now: NOW }), WebhookRejected, `${id}: no sandbox secret, no webhook`);
  }
});

/* ── Production fails closed ──────────────────────────────────────────── */

const CREDS = {
  pdax: { PDAX_API_KEY: 'k', PDAX_API_SECRET: 's', PDAX_WEBHOOK_SECRET: 'w' },
  durianpay: { DURIANPAY_API_KEY: 'k', DURIANPAY_WEBHOOK_SECRET: 'w', DURIANPAY_EXCHANGE_API_KEY: 'x' },
  hata_fiuu: { HATA_API_KEY: 'k', HATA_WEBHOOK_SECRET: 's', FIUU_MERCHANT_ID: 'm', FIUU_VERIFY_KEY: 'v' },
  cctp_wallet: { CCTP_IRIS_API_URL: 'https://iris-api.circle.com', CCTP_BRIDGE_ADAPTER_TYPE: '0x1::adapter::W' },
};

test('production fails closed for every route: without credentials, with them, and with USE_MOCK_APIS and the sandbox secret set', async () => {
  for (const id of PAYOUT_PARTNER_IDS) {
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', USE_MOCK_APIS: 'true', NEXT_PUBLIC_DEMO_MODE: 'true', PAYOUT_SANDBOX_WEBHOOKS_ENABLED: 'true', PAYOUT_SANDBOX_WEBHOOK_SECRET: SECRET },
    ]) {
      const p = payoutPartner(id, env);
      assert.equal(p.mode, 'live', id);
      const instruction = id === 'cctp_wallet' ? cctpInstruction() : bankInstruction({ durianpay: 'ID', hata_fiuu: 'MY' }[id] ?? 'PH');
      for (const call of [
        () => p.depositAddress({ businessId: WALLET, now: NOW }),
        () => p.checkAccount({ beneficiary: SUPPLIER.PH, now: NOW }),
        () => p.quote({ currency: p.currencies[0], sendMinor: 1n, now: NOW, destinationChain: 'BASE' }),
        () => p.createPayout(instruction),
        () => p.postSettlement({ intentId: INTENT, partnerRef: 'x', suiDigest: 'y', now: NOW }),
        () => p.status({ intentId: INTENT, partnerRef: 'x', now: NOW }),
        () => p.returnOrReverse({ intentId: INTENT, partnerRef: 'x', returnAddress: WALLET, reason: 'r', now: NOW }),
      ]) {
        await assert.rejects(call(), (e) => e instanceof PayoutPartnerUnavailable && e.code === 'partner_not_configured', id);
      }
      const body = JSON.stringify({ type: 'payout.status', eventId: 'evt_prod_0001', partnerRef: 'sb_x_000000', intentId: INTENT, status: 'paid_out' });
      assert.throws(() => p.handleWebhook({ rawBody: body, signature: signWebhook(body, SECRET, NOW), now: NOW }), (e) => e instanceof WebhookRejected && e.code === 'partner_not_configured', `${id}: the sandbox secret signs nothing in production`);
    }
    const configured = payoutPartner(id, { NODE_ENV: 'production', ...CREDS[id] });
    await assert.rejects(configured.quote({ currency: configured.currencies[0], sendMinor: 1n, now: NOW, destinationChain: 'BASE' }), (e) => e.code === 'partner_not_connected', `${id}: credentials alone do not make a quote`);
    await assert.rejects(configured.createPayout(id === 'cctp_wallet' ? cctpInstruction() : bankInstruction({ durianpay: 'ID', hata_fiuu: 'MY' }[id] ?? 'PH')), (e) => e.code === 'partner_not_connected' || e.code === 'bad_instruction', `${id}: nor a payout reference`);
  }
  // A route switched off refuses everywhere.
  assert.throws(() => payoutPartner('pdax', { NODE_ENV: 'test', PAYOUT_PARTNER_PDAX_ENABLED: 'false' }), (e) => e.code === 'partner_disabled');
  // A sandbox never runs against mainnet.
  assert.throws(() => payoutPartner('durianpay', { NODE_ENV: 'test', SUI_NETWORK: 'mainnet' }), (e) => e.code === 'partner_not_configured');
});

test('the v1 sweep and the quote engine reach no mock in production, and no DEMO_ reference is made anywhere', async () => {
  const { legacySweepPayout, pdaxAdapter } = await import('../lib/server/pdax.ts');
  const job = { id: 'swp_test_1' };
  await assert.rejects(legacySweepPayout(job, { NODE_ENV: 'production', USE_MOCK_APIS: 'true' }), (e) => e instanceof PayoutPartnerUnavailable, 'production: no sweep payout reference');
  await assert.rejects(legacySweepPayout(job, { NODE_ENV: 'production', PDAX_API_KEY: '' }), PayoutPartnerUnavailable, 'and not because the key is missing');
  const sandbox = await legacySweepPayout(job, { NODE_ENV: 'test' });
  assert.equal(sandbox.partnerPayoutRef, 'sandbox_pdax_swp_test_1');
  assert.equal(pdaxAdapter({ NODE_ENV: 'production', USE_MOCK_APIS: 'true' }).mode, 'live', 'USE_MOCK_APIS never brings the sandbox into production');
  const { readFile } = await import('node:fs/promises');
  for (const f of ['lib/server/pdax.ts', 'lib/server/sweep.ts', 'lib/server/quote.ts', 'lib/payouts/pdax.ts', 'lib/payouts/durianpay.ts', 'lib/payouts/cctp-wallet.ts', 'lib/payouts/bank-adapter.ts']) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /DEMO_|mockPdaxAdapter|USE_MOCK_APIS/, `${f}: no mock payout path`);
  }
});
