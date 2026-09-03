import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

// The ring-buffer path is the one under test: make sure no ambient
// DATABASE_URL (a developer's shell) routes writes at a real cluster.
delete process.env.DATABASE_URL;

const {
  CLIENT_EVENT_NAMES,
  EVENT_NAMES,
  RING_BUFFER_CAP,
  clearEventBuffer,
  emitEvent,
  listEvents,
  sanitizeProps,
  toProductEvent,
} = await import('../lib/server/events.ts');

/**
 * D8 — retention instrumentation contract:
 *   - ids are hashed before storage, never raw;
 *   - PII-looking prop keys are stripped;
 *   - the ring buffer works without DATABASE_URL and is capped;
 *   - the client allow-list is exactly the six UI names.
 */

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const EPOCH = new Date(0);

test.beforeEach(() => clearEventBuffer());

test('hashing: raw org/actor/subject ids never reach the stored event', async () => {
  const orgId = 'org_acme_7f3a';
  const actorId = 'ceo@acme.example';
  const subjectId = 'ti_0123456789abcdef';

  await emitEvent({
    name: 'intent_created',
    orgId,
    actorId,
    subjectId,
    corridor: 'USD_PHP',
    amountMinor: 2_500_000_000,
    currency: 'USD_MICRO',
  });

  const [event] = await listEvents({ since: EPOCH });
  assert.ok(event, 'event recorded in the ring buffer');
  assert.equal(event.orgHash, sha256(orgId));
  assert.equal(event.actorHash, sha256(actorId));
  assert.equal(event.subjectHash, sha256(subjectId));
  assert.equal(event.amountMinor, 2_500_000_000n, 'amount stored as bigint minor units');
  assert.equal(event.currency, 'USD_MICRO');

  const serialized = JSON.stringify(event, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  for (const raw of [orgId, actorId, subjectId]) {
    assert.ok(!serialized.includes(raw), `raw id "${raw}" must not appear anywhere in the stored event`);
  }
  assert.ok(!('orgId' in event) && !('actorId' in event) && !('subjectId' in event));
});

test('hashing: empty actor/subject become null, missing org is refused', () => {
  const event = toProductEvent({ name: 'session_started', orgId: 'org_x', actorId: '  ', subjectId: null });
  assert.equal(event.actorHash, null);
  assert.equal(event.subjectHash, null);
  assert.throws(() => toProductEvent({ name: 'session_started', orgId: '' }), /orgId is required/);
});

test('PII prop keys are stripped; safe scalar props survive', async () => {
  await emitEvent({
    name: 'recipient_added',
    orgId: 'org_x',
    props: {
      email: 'someone@example.com',
      recipientName: 'Jane Doe',
      accountNumber: '1234567890',
      iban: 'DE89370400440532013000',
      shippingAddress: '1 Main St',
      phone: '+63 900 000 0000',
      country: 'PH',
      tier: 'PAYOUT_ONLY',
      rows: 12,
      demo: true,
      note: null,
    },
  });

  const [event] = await listEvents({ since: EPOCH });
  assert.deepEqual(event.props, { country: 'PH', tier: 'PAYOUT_ONLY', rows: 12, demo: true, note: null });
  for (const key of Object.keys(event.props)) {
    assert.ok(!/email|name|account|iban|address|phone/i.test(key), `PII-looking key "${key}" leaked`);
  }
});

test('sanitizeProps drops nested values and truncates oversize strings', () => {
  const props = sanitizeProps({ nested: { a: 1 }, list: [1, 2], long: 'x'.repeat(500), nan: Number.NaN, big: 42n });
  assert.deepEqual(Object.keys(props).sort(), ['big', 'long']);
  assert.equal(props.long.length, 160);
  assert.equal(props.big, '42');
});

test('ring buffer works without DATABASE_URL: filters by since/name and is capped', async () => {
  assert.equal(process.env.DATABASE_URL, undefined);

  const old = new Date(Date.now() - 48 * 3600 * 1000);
  await emitEvent({ name: 'account_created', orgId: 'org_a', occurredAt: old });
  await emitEvent({ name: 'account_created', orgId: 'org_b' });
  await emitEvent({ name: 'intent_settled', orgId: 'org_b', corridor: 'USD_PHP' });

  const all = await listEvents({ since: EPOCH });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.name), ['account_created', 'account_created', 'intent_settled'], 'ascending by occurred_at');

  const recent = await listEvents({ since: new Date(Date.now() - 3600 * 1000) });
  assert.equal(recent.length, 2);

  const settled = await listEvents({ since: EPOCH, name: 'intent_settled' });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].corridor, 'USD_PHP');

  clearEventBuffer();
  for (let index = 0; index < RING_BUFFER_CAP + 25; index += 1) {
    await emitEvent({ name: 'message', orgId: 'org_cap', props: { index } });
  }
  const capped = await listEvents({ since: EPOCH });
  assert.equal(capped.length, RING_BUFFER_CAP, 'buffer never exceeds the cap');
  assert.equal(capped[0].props.index, 25, 'oldest entries are evicted first');
  assert.equal(capped.at(-1).props.index, RING_BUFFER_CAP + 24);
});

test('emitEvent never throws to the caller — an unknown name is warned and dropped', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await assert.doesNotReject(emitEvent({ name: 'not_a_real_event', orgId: 'org_x' }));
    await assert.doesNotReject(emitEvent({ name: 'message', orgId: '' }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((line) => line.startsWith('[events]')));
  assert.equal((await listEvents({ since: EPOCH })).length, 0);
});

test('CLIENT_EVENT_NAMES is exactly the six UI-originated names', () => {
  assert.deepEqual(
    [...CLIENT_EVENT_NAMES].sort(),
    ['explorer_link_clicked', 'export_downloaded', 'message', 'proof_drawer_opened', 'receipt_viewed', 'stream_reconnect'],
  );
  assert.equal(CLIENT_EVENT_NAMES.length, 6);
  for (const name of CLIENT_EVENT_NAMES) assert.ok(EVENT_NAMES.includes(name), `${name} must be in the taxonomy`);
  // Money-moving names must never be client-reportable.
  for (const forbidden of ['intent_created', 'intent_settled', 'batch_settled', 'approval_granted', 'sweep_approved', 'account_created']) {
    assert.ok(!CLIENT_EVENT_NAMES.includes(forbidden), `${forbidden} must not be client-reportable`);
  }
});

test('taxonomy carries every documented event name exactly once', () => {
  assert.equal(new Set(EVENT_NAMES).size, EVENT_NAMES.length);
  assert.equal(EVENT_NAMES.length, 37);
});
