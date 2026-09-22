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
];

/* ── 1. The meta-test ─────────────────────────────────────────────────── */

test('no event struct in splash_core carries a forbidden field: what is emitted freezes at the immutable publish', async () => {
  const dir = new URL('move/splash_core/sources/', root);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.move')).sort();
  assert.ok(files.length >= 8, 'the package has its modules');

  const violations = [];
  let events = 0;
  for (const file of files) {
    const text = await readFile(new URL(file, dir), 'utf8');
    for (const { name, fields } of eventStructs(text)) {
      events += 1;
      for (const field of fields) {
        if (FORBIDDEN.includes(field)) violations.push(`${file}::${name}.${field}`);
      }
    }
  }
  assert.ok(events >= 20, `the scan found the package's events (${events})`);
  assert.deepEqual(violations, [], `events carrying business metadata:\n  ${violations.join('\n  ')}`);
});

test('the payment lifecycle events carry intent_id, commitment, status and timestamp_ms, and nothing else', async () => {
  const intent = eventStructs(await source('move/splash_core/sources/payment_intent.move'));
  const byName = Object.fromEntries(intent.map((e) => [e.name, e.fields]));
  const SHAPE = ['intent_id', 'commitment', 'status', 'timestamp_ms'];
  assert.deepEqual(byName.IntentCreated, SHAPE, 'IntentCreated');
  assert.deepEqual(byName.IntentConfirmed, SHAPE, 'IntentConfirmed');
  assert.deepEqual(byName.IntentCanceled, SHAPE, 'IntentCanceled: the reason is the status');

  const anchor = eventStructs(await source('move/splash_core/sources/audit_anchor.move'));
  const anchored = anchor.find((e) => e.name === 'SettlementAnchored');
  assert.deepEqual(
    anchored?.fields,
    [...SHAPE, 'content_hash', 'walrus_blob_id'],
    'SettlementAnchored adds only the evidence pointers, which are a hash and a blob id',
  );

  const account = eventStructs(await source('move/splash_core/sources/business_account.move'));
  const approved = account.find((e) => e.name === 'PayoutApproved');
  const consumed = account.find((e) => e.name === 'PayoutApprovalConsumed');
  assert.ok(approved.fields.includes('commitment') && !approved.fields.includes('amount'), 'PayoutApproved commits, never amounts');
  assert.ok(consumed.fields.includes('commitment'), 'PayoutApprovalConsumed commits');
  for (const f of ['amount', 'daily_spent_after', 'daily_cap']) assert.ok(!consumed.fields.includes(f), `PayoutApprovalConsumed drops ${f}`);

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
  const { paymentCommitment, receiptCommitment, fromHex, toHex } = await lib();
  for (const v of vectors) {
    const salt = fromHex(v.saltHex);
    const got = v.tag === 'splash:receipt:v1' ? receiptCommitment(v.payload, salt) : paymentCommitment(v.payload, salt);
    assert.equal(toHex(got), v.commitmentHex, `${v.name} reproduces`);
  }
});
