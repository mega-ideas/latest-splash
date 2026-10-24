/**
 * WS5 — event privacy before the immutable publish.
 *
 * `splash_core` publishes immutable, and an event struct's fields freeze with
 * it. Today six events carry Splash's business metadata in cleartext: who
 * paid whom, how much, in what currency, at what rate, against which
 * beneficiary reference. These tests pin the replacement: every payment
 * lifecycle event carries the intent id, a 32-byte salted commitment, a
 * status and a timestamp, and nothing else. The commitment is computed
 * off-chain as
 *
 *     blake2b256( DOMAIN_TAG || bcs(payload) || salt )
 *
 * with a documented field order, a per-family domain tag and 32 CSPRNG salt
 * bytes per payment that live only inside the Seal bundle. Move asserts the
 * length and stores the bytes; it never sees the payload or the salt.
 *
 * What this does NOT hide is stated in SECURITY.md: the base-layer coin
 * transfer still shows sender, recipient and amount.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
async function source(rel) {
  return readFile(new URL(rel, root), 'utf8');
}
const lib = () => import('../lib/evidence/commitment.ts');

/* ── Helpers over the Move source ─────────────────────────────────────── */

/** Every `public struct X has copy, drop { … }` in a Move file, with its field names. */
function eventStructs(text) {
  const out = [];
  const re = /public struct (\w+) has copy, drop \{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2].replace(/\/\/[^\n]*/g, '');
    const fields = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map((f) => f[1]);
    out.push({ name: m[1], fields });
  }
  return out;
}

/**
 * Field names that are Splash's business metadata. An event carrying one of
 * these would publish it, immutably, on every payment. The list is the
 * union of what the six named events carry today plus the same classes
 * found elsewhere in the package (registration numbers, KYB pointers, risk
 * scores, spend ceilings).
 */
const FORBIDDEN = [
  'sender', 'recipient', 'beneficiary_ref',
  'amount', 'amount_usd', 'amount_paid', 'target_amount', 'overpay_refunded',
  'fx_rate_usd_local', 'target_currency', 'currency', 'corridor',
  'ssm_number', 'kyb_cid', 'risk_score',
  'cap_minor', 'daily_cap', 'daily_spent_after',
  // Amendment A1. A fee is computed from the principal by a public schedule,
  // so a fee on an event says roughly how much was paid, and a principal
  // says it exactly. Neither appears on an event except where ALLOWED says.
  'fee', 'principal',
];

/**
 * The only exceptions, each by package file, event and field, with the reason.
 * Adding one is a deliberate act: what an event carries freezes at publish.
 */
const ALLOWED = {
  // A1 §2.9: FeeCharged carries the fee because the fee is Splash's revenue,
  // Splash's own money, and the Phase 2 revenue and reconciliation listeners
  // read it from the event. The principal is not on it; it follows
  // docs/commitments.md as before.
  'move/splash_core/sources/fee_config.move::FeeCharged.fee':
    'the fee is Splash revenue (A1 §2.9), not a client payment',
  // A1 §2.9: the fee recipient is Splash's own finance multisig, not a
  // client's counterparty. Owners are alerted to a change of it (Phase 2),
  // so the address has to be on the event.
  'move/splash_core/sources/fee_config.move::FeeRecipientProposed.recipient':
    "Splash's own fee address, announced 24 hours ahead (A1 §2.5, §2.9)",
  'move/splash_core/sources/fee_config.move::FeeRecipientApplied.recipient':
    "Splash's own fee address, now in force (A1 §2.5, §2.9)",
  // A1 §2.9: RuleSpend, splash_spend's record of a payment under a spending
  // rule, carries the recipient address and Splash's fee, because Phase 2's
  // near-threshold alerts aggregate what one spender pays one recipient and
  // reconcile the fee from it. The principal is still not on it. What the
  // recipient field adds is little: the base-layer transfer of the same
  // payment already shows the recipient, and the fee its rough size.
  'move/splash_spend/sources/splash_spend.move::RuleSpend.recipient':
    'who a spending rule paid, for the Phase 2 near-threshold alerts (A1 §2.9); the transfer already shows it',
  'move/splash_spend/sources/splash_spend.move::RuleSpend.fee':
    'Splash revenue on a rule payment (A1 §2.9), matching FeeCharged',
};

/* ── 1. The meta-test ─────────────────────────────────────────────────── */

test('no event struct in splash_core, splash_spend or splash_upgrade_delay carries a forbidden field: what is emitted freezes at publish', async () => {
  // v2: splash_spend and splash_upgrade_delay publish immutable, so their
  // events freeze too and are held to the same rule.
  const packages = ['move/splash_core/sources/', 'move/splash_spend/sources/', 'move/splash_upgrade_delay/sources/'];
  const violations = [];
  let events = 0;
  let modules = 0;
  for (const pkg of packages) {
    const dir = new URL(pkg, root);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.move')).sort();
    modules += files.length;
    for (const file of files) {
      const text = await readFile(new URL(file, dir), 'utf8');
      for (const { name, fields } of eventStructs(text)) {
        events += 1;
        for (const field of fields) {
          const where = `${pkg}${file}::${name}.${field}`;
          if (FORBIDDEN.includes(field) && !ALLOWED[where]) violations.push(where);
        }
      }
    }
  }
  assert.ok(modules >= 12, `the scan found every package's modules (${modules})`);
  assert.ok(events >= 40, `the scan found the packages' events (${events})`);
  assert.deepEqual(violations, [], `events carrying business metadata:\n  ${violations.join('\n  ')}`);
});

test('the payment lifecycle events carry the commitment and what an indexer needs, and nothing about the payment', async () => {
  const intent = eventStructs(await source('move/splash_core/sources/payment_intent.move'));
  const byName = Object.fromEntries(intent.map((e) => [e.name, e.fields]));
  // v2 (brief §3.1): the schema freezes at publish, so it carries what an
  // indexer needs once `delete_finalized` has removed the intent: the rail
  // commitment, the settlement asset's type name and the kind. The asset type
  // is the one deliberate exception to WS5's "no currency" rule; the brief
  // requires it, and it is the coin type, which the base-layer transfer
  // already shows. Still no amount, no address, no account.
  const CORE = ['intent_id', 'commitment', 'rail_commitment', 'settlement_asset', 'kind', 'status'];
  assert.deepEqual(byName.IntentCreated, [...CORE, 'expires_at_ms', 'timestamp_ms'], 'IntentCreated');
  assert.deepEqual(byName.IntentConfirmed, [...CORE, 'path', 'timestamp_ms'], 'IntentConfirmed: path is which settlement path released it');
  assert.deepEqual(byName.IntentCanceled, [...CORE, 'timestamp_ms'], 'IntentCanceled: the reason is the status');

  const SHAPE = ['intent_id', 'commitment', 'status', 'timestamp_ms'];
  const anchor = eventStructs(await source('move/splash_core/sources/audit_anchor.move'));
  const anchored = anchor.find((e) => e.name === 'SettlementAnchored');
  assert.deepEqual(
    anchored?.fields,
    [...SHAPE, 'content_hash', 'walrus_blob_id'],
    'SettlementAnchored adds only the evidence pointers, which are a hash and a blob id',
  );

  // The legacy approval events (PayoutApproved, PayoutApprovalConsumed) left
  // core with the legacy path (decision 3; tests/legacy-path-removed.test.mjs).
  // splash_spend's own approval events carry no amount, and the meta-test
  // above holds every event in all three packages to the same rule.

  const receipt = eventStructs(await source('move/splash_core/sources/receipt_v2.move'));
  const issued = receipt.find((e) => e.name === 'ReceiptIssued');
  assert.ok(issued.fields.includes('commitment'), 'ReceiptIssued commits');

  // Move asserts the length, and both abort codes are explained off-chain.
  const paymentIntent = await source('move/splash_core/sources/payment_intent.move');
  assert.match(paymentIntent, /const COMMITMENT_BYTES: u64 = 32;/);
  assert.match(paymentIntent, /const E_BAD_COMMITMENT:\s+u64 = 420;/);
  assert.match(paymentIntent, /assert!\(commitment\.length\(\) == COMMITMENT_BYTES, E_BAD_COMMITMENT\)/);
  const receiptSource = await source('move/splash_core/sources/receipt_v2.move');
  assert.match(receiptSource, /const E_BAD_COMMITMENT:\s+u64 = 804;/);
  const table = await source('lib/server/sui-settlement.ts');
  assert.match(table, /^\s*420: 'E_BAD_COMMITMENT — /m);
  assert.match(table, /^\s*804: 'E_BAD_COMMITMENT — /m);
});

test("the fee events carry Splash's own terms, and FeeCharged the fee and nothing about the payment", async () => {
  const fee = eventStructs(await source('move/splash_core/sources/fee_config.move'));
  const byName = Object.fromEntries(fee.map((e) => [e.name, e.fields]));
  // A1 §2.9. The fee is Splash revenue; the principal is not on the event.
  assert.deepEqual(byName.FeeCharged, ['intent_id', 'business', 'derived_kind', 'fee', 'fee_recipient'], 'FeeCharged');
  assert.deepEqual(byName.FeeScheduleProposed, ['kind', 'tiers', 'min_minor', 'max_minor', 'eta'], 'FeeScheduleProposed');
  assert.deepEqual(byName.FeeScheduleApplied, ['kind'], 'FeeScheduleApplied');
  assert.deepEqual(byName.FeeRecipientProposed, ['recipient', 'eta'], 'FeeRecipientProposed');
  assert.deepEqual(byName.FeeRecipientApplied, ['recipient'], 'FeeRecipientApplied');
  assert.deepEqual(byName.FeeDiscountSet, ['business', 'discount_bps'], 'FeeDiscountSet');
  assert.deepEqual(Object.keys(byName).sort(), Object.keys(byName).filter((n) => n.startsWith('Fee')).sort(), 'fee_config emits only Fee* events');
  // The allowed exceptions are exactly fields these events carry.
  for (const where of Object.keys(ALLOWED)) {
    const [, file, event, field] = /^(.+\.move)::(\w+)\.(\w+)$/.exec(where);
    const fields = Object.fromEntries(eventStructs(await source(file)).map((e) => [e.name, e.fields]));
    assert.ok(fields[event]?.includes(field), `${where} is a real field`);
  }
});

test("RuleSpend carries who paid whom under which rule, the kind core charged and Splash's fee, and not the principal", async () => {
  const spend = eventStructs(await source('move/splash_spend/sources/splash_spend.move'));
  const byName = Object.fromEntries(spend.map((e) => [e.name, e.fields]));
  // A1 §2.9. It replaces PaidUnderPolicy, which carried the first five.
  assert.deepEqual(
    byName.RuleSpend,
    ['policy_id', 'intent_id', 'allowance_id', 'approval_id', 'spender', 'recipient', 'derived_kind', 'fee'],
    'RuleSpend',
  );
  assert.equal(byName.PaidUnderPolicy, undefined, 'PaidUnderPolicy is gone: one event per rule payment');
});

/* ── 2. The commitment ────────────────────────────────────────────────── */

const PAYLOAD = {
  sender: '0x' + 'a1'.repeat(32),
  recipient: '0x' + 'b0'.repeat(32),
  beneficiaryRef: 'counterparty:vendor-001',
  amount: '1000',
  currency: '0x2::sui::SUI',
  corridor: 'MY-PH',
  targetCurrency: 'PHP',
  fxRateUsdLocal: '56000000',
};
const SALT = new Uint8Array(32).fill(0x11);

function concat(...parts) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

test('commitment = blake2b256(tag || bcs(payload) || salt): deterministic, 32 bytes, field order fixed, domains separated', async () => {
  const { paymentCommitment, commitmentBytes, encodePaymentPayload, DOMAIN_TAGS, COMMITMENT_BYTES, PAYMENT_PAYLOAD_FIELDS } = await lib();
  assert.equal(COMMITMENT_BYTES, 32);
  assert.equal(DOMAIN_TAGS.payment, 'splash:payment:v1');
  assert.equal(DOMAIN_TAGS.receipt, 'splash:receipt:v1');
  assert.deepEqual(
    [...PAYMENT_PAYLOAD_FIELDS],
    ['sender', 'recipient', 'beneficiary_ref', 'amount', 'currency', 'corridor', 'target_currency', 'fx_rate_usd_local'],
    'the documented field order',
  );

  const a = paymentCommitment(PAYLOAD, SALT);
  const b = paymentCommitment({ ...PAYLOAD }, new Uint8Array(SALT));
  assert.equal(a.length, 32);
  assert.deepEqual(a, b, 'deterministic');

  // An independent recomputation, with the BCS layout spelled out here rather
  // than imported: this is the definition the verifier and the docs rely on.
  const { bcs } = await import('@mysten/sui/bcs');
  const { blake2b } = await import('@noble/hashes/blake2.js');
  const Layout = bcs.struct('PaymentCommitmentPayload', {
    sender: bcs.Address,
    recipient: bcs.Address,
    beneficiary_ref: bcs.vector(bcs.u8()),
    amount: bcs.u64(),
    currency: bcs.string(),
    corridor: bcs.string(),
    target_currency: bcs.string(),
    fx_rate_usd_local: bcs.u64(),
  });
  const payloadBytes = Layout.serialize({
    sender: PAYLOAD.sender,
    recipient: PAYLOAD.recipient,
    beneficiary_ref: Array.from(Buffer.from(PAYLOAD.beneficiaryRef, 'utf8')),
    amount: 1000n,
    currency: PAYLOAD.currency,
    corridor: PAYLOAD.corridor,
    target_currency: PAYLOAD.targetCurrency,
    fx_rate_usd_local: 56_000_000n,
  }).toBytes();
  assert.deepEqual(encodePaymentPayload(PAYLOAD), payloadBytes, 'the library encodes the documented layout');
  const expected = blake2b(concat(Buffer.from('splash:payment:v1', 'utf8'), payloadBytes, SALT), { dkLen: 32 });
  assert.deepEqual(a, expected);

  // Domain separation: the same bytes under the receipt tag commit to something else.
  assert.notDeepEqual(commitmentBytes(DOMAIN_TAGS.receipt, payloadBytes, SALT), a);
  const tags = Object.values(DOMAIN_TAGS);
  for (const x of tags) for (const y of tags) if (x !== y) assert.ok(!y.startsWith(x), `${x} is not a prefix of ${y}`);

  // The salt matters, and so does every unit of the amount.
  assert.notDeepEqual(paymentCommitment(PAYLOAD, new Uint8Array(32).fill(0x12)), a);
  assert.notDeepEqual(paymentCommitment({ ...PAYLOAD, amount: '1001' }, SALT), a);
});

test('the salt is 32 CSPRNG bytes, unique over 10,000 draws, and a wrong length is refused on both sides', async () => {
  const { newSalt, SALT_BYTES, paymentCommitment, assertCommitmentBytes } = await lib();
  assert.equal(SALT_BYTES, 32);
  const seen = new Set();
  for (let i = 0; i < 10_000; i += 1) {
    const salt = newSalt();
    assert.equal(salt.length, 32);
    seen.add(Buffer.from(salt).toString('hex'));
  }
  assert.equal(seen.size, 10_000, 'no two salts collide');

  assert.throws(() => paymentCommitment(PAYLOAD, new Uint8Array(31)), /32/);
  assert.throws(() => paymentCommitment(PAYLOAD, new Uint8Array(33)), /32/);
  assert.throws(() => assertCommitmentBytes(new Uint8Array(31)), /32/);
  assert.throws(() => assertCommitmentBytes(new Uint8Array(33)), /32/);
  assert.doesNotThrow(() => assertCommitmentBytes(new Uint8Array(32)));
});

/* ── 3. Where the salt lives ──────────────────────────────────────────── */

test('the bundle carries payload and salt, the chain gets only the commitment, and nothing logs the salt', async () => {
  const evidence = await source('lib/evidence/settlement.ts');
  assert.match(evidence, /splash\.settlement-evidence\.v2/, 'the bundle schema is bumped: a v1 reader does not know the salt');
  assert.match(evidence, /saltHex: string/);
  assert.match(evidence, /commitmentHex: string/);

  const composed = await source('lib/server/composed-payment.ts');
  assert.match(composed, /newSalt\(\)/, 'the salt is drawn where the payment starts');
  assert.match(composed, /paymentCommitment\(/);

  const settlement = await source('lib/server/sui-settlement.ts');
  assert.match(settlement, /commitment: Uint8Array;/, 'the create call takes the commitment, so an unchanged caller fails to compile');
  assert.match(settlement, /assertCommitmentBytes\(input\.commitment\)/);
  assert.match(settlement, /tx\.pure\.vector\('u8', Array\.from\(input\.commitment\)\)/);
  assert.doesNotMatch(settlement, /newSalt|saltHex|\bsalt\s*[=:(]/, 'the settlement layer never handles a salt');

  for (const file of ['lib/server/composed-payment.ts', 'lib/evidence/settlement.ts', 'lib/evidence/commitment.ts']) {
    const text = await source(file);
    assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)\([^)]*salt/i, `${file} does not log the salt`);
  }
});

test('Seal round trip: the sealed bundle decrypts to the salt that recomputes the on-chain commitment, and a stranger gets nothing', async () => {
  process.env.SPLASH_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'splash-seal-'));
  const { newSalt, paymentCommitment, toHex, fromHex } = await lib();
  const { createTransferSettlementEvidence } = await import('../lib/evidence/settlement.ts');
  const { mockSealAdapter } = await import('../lib/server/seal.ts');

  const salt = newSalt();
  const commitment = paymentCommitment(PAYLOAD, salt);
  const bundle = createTransferSettlementEvidence({
    transferId: 'tr_1',
    recipient: 'Vendor 001',
    targetCurrency: 'PHP',
    paymentMist: 1000,
    paymentIntentId: '0x' + 'c0'.repeat(32),
    intentCreateDigest: 'digest',
    expectedAnchorId: 'transfer:tr_1',
    commitment: { tag: 'splash:payment:v1', commitmentHex: toHex(commitment), saltHex: toHex(salt), payload: PAYLOAD },
  });
  assert.equal(bundle.schema, 'splash.settlement-evidence.v2');
  assert.equal(bundle.settlement.commitment.saltHex, toHex(salt));

  const plaintext = JSON.stringify(bundle);
  const { ciphertext, policy } = await mockSealAdapter.encrypt(plaintext, ['auditor']);
  assert.doesNotMatch(Buffer.from(ciphertext, 'base64').toString('latin1'), new RegExp(toHex(salt)), 'the salt is not readable in the ciphertext');
  assert.equal(await mockSealAdapter.decrypt(ciphertext, policy.policyId, 'stranger'), null, 'outside the allowlist there is no salt');

  const opened = JSON.parse(await mockSealAdapter.decrypt(ciphertext, policy.policyId, 'auditor'));
  const recomputed = paymentCommitment(opened.settlement.commitment.payload, fromHex(opened.settlement.commitment.saltHex));
  assert.equal(toHex(recomputed), opened.settlement.commitment.commitmentHex);
  assert.deepEqual(recomputed, commitment, 'what the chain holds is what the bundle recomputes');
});

/* ── 4. The verifier and the vectors ──────────────────────────────────── */

test('scripts/verify-commitment.mjs verifies a settlement against its events and fails on a tampered one', async () => {
  const { newSalt, paymentCommitment, toHex } = await lib();
  const salt = newSalt();
  const commitment = paymentCommitment(PAYLOAD, salt);
  const intentId = '0x' + 'c0'.repeat(32);
  const bundle = {
    schema: 'splash.settlement-evidence.v2',
    settlement: {
      paymentIntentId: intentId,
      commitment: { tag: 'splash:payment:v1', commitmentHex: toHex(commitment), saltHex: toHex(salt), payload: PAYLOAD },
    },
  };
  const bytes = Array.from(commitment);
  const events = [
    { type: '0xabc::payment_intent::IntentCreated', parsedJson: { intent_id: intentId, commitment: bytes, status: 0, timestamp_ms: '1' } },
    { type: '0xabc::payment_intent::IntentConfirmed', parsedJson: { intent_id: intentId, commitment: bytes, status: 1, timestamp_ms: '2' } },
    { type: '0xabc::audit_anchor::SettlementAnchored', parsedJson: { intent_id: intentId, commitment: bytes, status: 1, timestamp_ms: '3', content_hash: [1], walrus_blob_id: [2] } },
    { type: '0xabc::audit_anchor::AuditAnchored', parsedJson: { anchor_object: '0x1' } },
  ];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'splash-verify-'));
  const bundlePath = path.join(dir, 'bundle.json');
  const eventsPath = path.join(dir, 'events.json');
  await writeFile(bundlePath, JSON.stringify(bundle));
  await writeFile(eventsPath, JSON.stringify(events));

  const run = (...extra) =>
    spawnSync(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', 'scripts/verify-commitment.mjs', '--bundle', bundlePath, '--events', eventsPath, ...extra],
      { cwd: new URL('.', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'), encoding: 'utf8' },
    );
  const ok = run();
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /IntentCreated/);
  assert.match(ok.stdout, /SettlementAnchored/);
  assert.match(ok.stdout, /3 of 3 events? verified|verified 3 events/i);
  assert.doesNotMatch(ok.stdout, new RegExp(toHex(salt)), 'the verifier prints no salt');

  const tampered = structuredClone(events);
  tampered[1].parsedJson.commitment = [...bytes.slice(0, 31), (bytes[31] + 1) % 256];
  await writeFile(eventsPath, JSON.stringify(tampered));
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(`${bad.stdout}${bad.stderr}`, /IntentConfirmed/);
  assert.match(`${bad.stdout}${bad.stderr}`, /mismatch|does not match/i);
});

test('docs/commitments.md carries the field order and test vectors the library reproduces', async () => {
  const doc = await source('docs/commitments.md');
  assert.match(doc, /splash:payment:v1/);
  assert.match(doc, /splash:receipt:v1/);
  assert.match(doc, /blake2b256/);
  for (const field of ['sender', 'recipient', 'beneficiary_ref', 'amount', 'currency', 'corridor', 'target_currency', 'fx_rate_usd_local']) {
    assert.match(doc, new RegExp(`\\b${field}\\b`), `the doc names ${field}`);
  }
  assert.match(doc, /base-layer|coin transfer/i, 'the doc says what is not hidden');

  const block = doc.match(/```json\s*\n([\s\S]*?"vectors"[\s\S]*?)\n```/);
  assert.ok(block, 'a fenced json block with "vectors"');
  const { vectors } = JSON.parse(block[1]);
  assert.ok(vectors.length >= 3, 'at least three vectors');
  const c = await lib();
  // Every family the library knows has a vector, and every vector's family is
  // one the library knows: a tag nobody can reproduce is not a specification.
  const byTag = {
    'splash:payment:v1': [c.paymentCommitment, c.encodePaymentPayload],
    'splash:receipt:v1': [c.receiptCommitment, c.encodeReceiptPayload],
    'splash:rail:v1': [c.railCommitment, c.encodeRailPayload],
    'splash:beneficiary:v1': [c.beneficiaryCommitment, c.encodeBeneficiaryPayload],
    'splash:payment-ref:v1': [c.paymentRefCommitment, c.encodePaymentRefPayload],
  };
  assert.deepEqual(Object.keys(byTag).sort(), Object.values(c.DOMAIN_TAGS).sort(), 'one reproducer per domain tag');
  const covered = new Set();
  for (const v of vectors) {
    const family = byTag[v.tag];
    assert.ok(family, `${v.name}: unknown tag ${v.tag}`);
    covered.add(v.tag);
    const [commit, encode] = family;
    if (v.payloadBcsHex) assert.equal(c.toHex(encode(v.payload)), v.payloadBcsHex, `${v.name}: field order`);
    assert.equal(c.toHex(commit(v.payload, c.fromHex(v.saltHex))), v.commitmentHex, `${v.name} reproduces`);
  }
  assert.deepEqual([...covered].sort(), Object.keys(byTag).sort(), 'every tag has at least one vector');
  for (const tag of ['splash:rail:v1', 'splash:beneficiary:v1', 'splash:payment-ref:v1']) {
    assert.match(doc, new RegExp(tag.replace(/[-:]/g, (m) => `\\${m}`)), `the doc specifies ${tag}`);
  }
});

test('no domain tag is a prefix of another, so two families can never collide', async () => {
  const { DOMAIN_TAGS } = await lib();
  const tags = Object.values(DOMAIN_TAGS);
  for (const a of tags) for (const b of tags) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b}`);
});

test('the stable v2 commitments are stable: same record and secret, same bytes; another secret, other bytes', async () => {
  const c = await lib();
  const record = { partner: 'pdax', country: 'PH', bankCode: 'BDO', accountNumber: '001234567890', holderName: 'Dela Cruz Trading Corp' };
  const secret = new Uint8Array(32).fill(0x33);
  assert.equal(c.toHex(c.beneficiaryCommitment(record, secret)), c.toHex(c.beneficiaryCommitment({ ...record }, secret)));
  assert.notEqual(c.toHex(c.beneficiaryCommitment(record, secret)), c.toHex(c.beneficiaryCommitment(record, new Uint8Array(32).fill(0x34))));
  assert.notEqual(
    c.toHex(c.beneficiaryCommitment(record, secret)),
    c.toHex(c.beneficiaryCommitment({ ...record, accountNumber: '001234567891' }, secret)),
    'one digit of the account number changes the commitment',
  );
  const ref = { businessAccountId: '0x' + 'c0'.repeat(32), paymentId: 'INV-2026-0042' };
  const bizSecret = new Uint8Array(32).fill(0x44);
  assert.equal(c.toHex(c.paymentRefCommitment(ref, bizSecret)), c.toHex(c.paymentRefCommitment({ ...ref }, bizSecret)), 'a retry derives the same payment_ref');
  assert.throws(() => c.beneficiaryCommitment({ ...record, holderName: '' }, secret), /holderName/);
  assert.throws(() => c.paymentRefCommitment({ ...ref, paymentId: '' }, bizSecret), /payment id/);
});
