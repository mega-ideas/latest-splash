import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { attachDb, migratedDb } from './helpers/store-db.mjs';
import { deriveNearThresholdAlerts, MIN_REPEAT_PAYMENTS } from '../lib/server/near-threshold.ts';

/* v2 Phase 2 carried item (Phase 1 R5, A1 §6): near-threshold alerts read
   from the spending-rule index (the SpendPolicy's running totals per payer
   and recipient, and RuleSpend). Detective only and owner-facing: an owner
   is told when one spender keeps paying one recipient just under the
   second-approval threshold, and when several spenders pay the same
   recipient so that together they reach it with no approval. Nothing is
   blocked. */

const USDC = 1_000_000n;
const T = 10_000n * USDC;
const POLICY = '0x' + '70'.repeat(32);
const STAFF_A = '0x' + 'a1'.repeat(32);
const STAFF_B = '0x' + 'b2'.repeat(32);
const OPERATOR = '0x' + '0e'.repeat(32);
const SUPPLIER = '0x' + '5a'.repeat(32);
const OTHER = '0x' + '5b'.repeat(32);
const DEPOSIT = '0x' + 'de'.repeat(32);
const BENEFICIARY = 'ab'.repeat(32);
const W0 = 1_792_800_000_000n;
const DAY = 86_400_000n;

function total({ recipient = SUPPLIER, beneficiary = null, counted, windowStartMs = W0 } = {}) {
  return {
    recipient: beneficiary ? null : recipient,
    beneficiary,
    windowStartMs: String(windowStartMs),
    windowEndMs: String(windowStartMs + DAY),
    totalMinor: String(counted),
    countedMinor: String(counted),
    countsUntilMs: String(windowStartMs + DAY + 3_600_000n),
    beforeApprovalMinor: String(counted >= T ? 0n : T - counted),
    nearThreshold: counted * 100n >= T * 80n,
  };
}

const spend = (recipient, i = 0) => ({ intentId: '0x' + String(i).padStart(64, '0'), allowanceId: '0x' + 'ac'.repeat(32), approvalId: null, recipient, derivedKind: 1, feeMinor: '0' });

function rule(spender, { totals = [], spends = [], role = 'staff' } = {}) {
  return { spender, role, standing: 'member', perPaymentMaxMinor: String(T), status: 'active', allowances: [], runningTotals: totals, recentSpends: spends };
}

function view(rules, { threshold = T } = {}) {
  return {
    walletEpoch: '1',
    wallet: '0x' + 'aa'.repeat(32),
    policy: {
      id: POLICY,
      perPaymentMaxMinor: String(20_000n * USDC),
      secondApprovalThresholdMinor: String(threshold),
      runningWindowMs: String(DAY),
      generation: '1',
      recipients: [{ address: SUPPLIER, tag: 'wallet' }],
      beneficiaries: [{ commitment: BENEFICIARY, partnerDeposit: DEPOSIT }],
    },
    rules,
    unattached: [],
    stale: [],
    reissueNeeded: false,
    orphaned: [],
  };
}

// ─── 1. The decision ─────────────────────────────────────────────────────────

test('one spender paying one recipient several times, at 80% or more of the threshold but under it, is one repeat alert', () => {
  const v = view([rule(STAFF_A, { totals: [total({ counted: 8_500n * USDC })], spends: [spend(SUPPLIER, 1), spend(SUPPLIER, 2), spend(OTHER, 3)] })]);
  const alerts = deriveNearThresholdAlerts(v, { nameOf: (a) => (a === STAFF_A ? 'Aisha' : null) });
  assert.equal(alerts.length, 1);
  const [a] = alerts;
  assert.equal(a.kind, 'near_threshold_repeat');
  assert.equal(a.severity, 'near_threshold');
  assert.deepEqual(a.spenders, [STAFF_A]);
  assert.equal(a.recipient, SUPPLIER);
  assert.equal(a.payments, 2, 'only the payments to this recipient');
  assert.equal(a.countedMinor, String(8_500n * USDC));
  assert.equal(a.thresholdMinor, String(T));
  assert.equal(a.key, `near_threshold_repeat|${POLICY}|${STAFF_A}|${SUPPLIER}|${W0}`);
  assert.equal(a.summary, 'Aisha has paid 0x5a5a…5a5a 2 times, 8,500 USDC in all, close to the 10,000 USDC that needs a second approval.');
  assert.match(a.detail, new RegExp(`Recipient: ${SUPPLIER}\\.`));
  assert.match(a.detail, /Splash blocks nothing on this alert/);
  assert.equal(a.activeUntilMs, String(W0 + DAY + 3_600_000n));
  assert.doesNotMatch(a.summary + a.detail, /[—–]/);
});

test('no repeat alert for one payment, under 80%, or at the threshold (where the chain already asks for an approval)', () => {
  const at = (counted, spends) => deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [total({ counted })], spends })]));
  assert.equal(MIN_REPEAT_PAYMENTS, 2);
  assert.deepEqual(at(9_000n * USDC, [spend(SUPPLIER)]), [], 'one payment is not a pattern');
  assert.deepEqual(at(7_999n * USDC, [spend(SUPPLIER, 1), spend(SUPPLIER, 2)]), [], 'under 80%');
  assert.equal(at(8_000n * USDC, [spend(SUPPLIER, 1), spend(SUPPLIER, 2)]).length, 1, 'exactly 80% is near');
  assert.deepEqual(at(T, [spend(SUPPLIER, 1), spend(SUPPLIER, 2)]), [], 'at the threshold the chain requires an approval itself');
  assert.deepEqual(deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [total({ counted: 9_000n * USDC })], spends: [spend(SUPPLIER, 1), spend(SUPPLIER, 2)] })], { threshold: 0n })), [], 'no threshold, nothing to be near');
  const noPolicy = { ...view([]), policy: null };
  assert.deepEqual(deriveNearThresholdAlerts(noPolicy), []);
});

test('several spenders paying one recipient: near at 80% together, over when together they pass the threshold with no approval', () => {
  const over = deriveNearThresholdAlerts(view([
    rule(STAFF_B, { totals: [total({ counted: 5_000n * USDC })], spends: [spend(SUPPLIER, 1)] }),
    rule(STAFF_A, { totals: [total({ counted: 6_000n * USDC })], spends: [spend(SUPPLIER, 2)] }),
  ]));
  assert.equal(over.length, 1);
  const [o] = over;
  assert.equal(o.kind, 'same_recipient_many_spenders');
  assert.equal(o.severity, 'over_threshold');
  assert.deepEqual(o.spenders, [STAFF_A, STAFF_B], 'sorted, so the key is the same whatever order the index gives');
  assert.equal(o.countedMinor, String(11_000n * USDC));
  assert.equal(o.payments, 2);
  assert.equal(o.key, `same_recipient_many_spenders|${POLICY}|${SUPPLIER}|${STAFF_A}@${W0},${STAFF_B}@${W0}`);
  assert.match(o.summary, /have together paid 0x5a5a…5a5a 11,000 USDC, above the 10,000 USDC that needs a second approval for one person\. Each stayed under it alone, so no approval was asked for\./);
  assert.match(o.detail, /0xa1a1…a1a1: 6,000 USDC; 0xb2b2…b2b2: 5,000 USDC/);

  const nearAlerts = deriveNearThresholdAlerts(view([
    rule(STAFF_A, { totals: [total({ counted: 4_500n * USDC })] }),
    rule(STAFF_B, { totals: [total({ counted: 3_600n * USDC })] }),
  ]));
  assert.deepEqual(nearAlerts.map((a) => [a.kind, a.severity]), [['same_recipient_many_spenders', 'near_threshold']]);
  assert.deepEqual(deriveNearThresholdAlerts(view([
    rule(STAFF_A, { totals: [total({ counted: 4_000n * USDC })] }),
    rule(STAFF_B, { totals: [total({ counted: 3_000n * USDC, recipient: OTHER })] }),
  ])), [], 'different recipients are not added up');
});

test('the operator executing scheduled payments counts as a spender, and is named as such', () => {
  const [a] = deriveNearThresholdAlerts(view([
    rule(STAFF_A, { totals: [total({ counted: 5_000n * USDC })] }),
    rule(OPERATOR, { role: 'executor', totals: [total({ counted: 5_000n * USDC })] }),
  ]), { nameOf: (x) => (x === STAFF_A ? 'Aisha' : null) });
  assert.match(a.summary, /^Splash's scheduled-payment operator and Aisha have together paid/);
});

test('a bank beneficiary is grouped by its commitment, and its RuleSpend payments by the partner deposit address', () => {
  const alerts = deriveNearThresholdAlerts(view([
    rule(STAFF_A, { totals: [total({ beneficiary: BENEFICIARY, counted: 9_000n * USDC })], spends: [spend(DEPOSIT, 1), spend(DEPOSIT, 2)] }),
  ]));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].recipient, null);
  assert.equal(alerts[0].beneficiary, BENEFICIARY);
  assert.equal(alerts[0].payments, 2);
  assert.match(alerts[0].key, new RegExp(`\\|b:${BENEFICIARY}\\|`));
  assert.match(alerts[0].summary, /has paid the bank account 0xabab…abab 2 times/);
});

test('keys are stable across runs, and a new window is a new alert', () => {
  const make = (start) => deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [total({ counted: 8_500n * USDC, windowStartMs: start })], spends: [spend(SUPPLIER, 1), spend(SUPPLIER, 2)] })]))[0].key;
  assert.equal(make(W0), make(W0));
  assert.notEqual(make(W0), make(W0 + DAY));
});

// ─── 2. The monitor: per org, owners only, once ─────────────────────────────

async function withDb(run) {
  const { client, db } = await migratedDb();
  const undo = attachDb(db);
  try {
    await run({ client, db });
  } finally {
    undo();
    await client.close();
  }
}

async function seed(client) {
  await client.exec(`
    UPDATE organizations SET sui_business_account_id = '0x${'a0'.repeat(32)}' WHERE id = 'acme';
    UPDATE organizations SET sui_business_account_id = '0x${'b0'.repeat(32)}' WHERE id = 'northwind';
    INSERT INTO users (id, email, name, email_verified_at) VALUES
      ('u_alice', 'alice@acme.example', 'Alice Tan', now()),
      ('u_sam', 'sam@acme.example', 'Sam Lee', now()),
      ('u_dave', 'dave@northwind.example', 'Dave Ng', now());
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m_alice', 'u_alice', 'acme', 'admin'),
      ('m_sam', 'u_sam', 'acme', 'maker'),
      ('m_dave', 'u_dave', 'northwind', 'admin');
  `);
}

const NOW = Number(W0 + 3_600_000n);
const acmeView = () => view([rule(STAFF_A, { totals: [total({ counted: 8_500n * USDC })], spends: [spend(SUPPLIER, 1), spend(SUPPLIER, 2)] })]);

function monitorDeps(db, sink, over = {}) {
  return {
    db,
    now: NOW,
    appUrl: 'https://v1.splashz.xyz',
    readView: async (orgId) => (orgId === 'acme' ? { ok: true, view: acmeView() } : { ok: true, view: view([]) }),
    sendEmail: async (m) => { sink.push(m); return { providerRef: `em_${sink.length}` }; },
    ...over,
  };
}

test('an alert is recorded once for its own business and emailed to that business\'s owners only, once', async () => {
  await withDb(async ({ client, db }) => {
    await seed(client);
    const { runNearThresholdMonitor } = await import('../lib/server/near-threshold-monitor.ts');
    const { listSpendRuleAlertsForOrg } = await import('../lib/server/near-threshold-store.ts');
    const sent = [];
    const first = await runNearThresholdMonitor(monitorDeps(db, sent));
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.recorded, 1);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(sent.map((m) => m.to), ['alice@acme.example'], 'owners of acme only: not a maker, not another business');
    assert.equal(sent[0].subject, 'A spending pattern to check in your Splash spending rules');
    assert.match(sent[0].text, /has paid 0x5a5a…5a5a 2 times/);
    assert.equal(sent[0].link, 'https://v1.splashz.xyz/dashboard/settings/spending-rules');

    const again = await runNearThresholdMonitor(monitorDeps(db, sent, { now: NOW + 15 * 60_000 }));
    assert.equal(again.recorded, 0);
    assert.equal(sent.length, 1, 'never sent twice');

    const acme = await listSpendRuleAlertsForOrg(db, 'acme', NOW);
    assert.equal(acme.length, 1);
    assert.equal(acme[0].kind, 'near_threshold_repeat');
    assert.deepEqual(acme[0].spenders, [STAFF_A]);
    assert.deepEqual(await listSpendRuleAlertsForOrg(db, 'northwind', NOW), [], "another business's alert is not visible");
    assert.deepEqual(await listSpendRuleAlertsForOrg(db, 'acme', Number(W0 + DAY + 3_600_000n)), [], 'gone once the totals stop counting');
  });
});

test('the same alert content in two businesses is two alerts, each to its own owners', async () => {
  await withDb(async ({ client, db }) => {
    await seed(client);
    const { runNearThresholdMonitor } = await import('../lib/server/near-threshold-monitor.ts');
    const sent = [];
    const r = await runNearThresholdMonitor(monitorDeps(db, sent, { readView: async () => ({ ok: true, view: acmeView() }) }));
    assert.equal(r.recorded, 2);
    assert.deepEqual(sent.map((m) => m.to).sort(), ['alice@acme.example', 'dave@northwind.example']);
    const rows = (await client.query(`SELECT org_id, content_key FROM spend_rule_alerts ORDER BY org_id`)).rows;
    assert.deepEqual(rows.map((x) => x.org_id), ['acme', 'northwind']);
    assert.equal(rows[0].content_key, rows[1].content_key);
  });
});

test('a failed email is recorded and retried a bounded number of times; a business whose rules cannot be read is an error, the others still run', async () => {
  await withDb(async ({ client, db }) => {
    await seed(client);
    const { runNearThresholdMonitor } = await import('../lib/server/near-threshold-monitor.ts');
    const { MAX_ALERT_EMAIL_ATTEMPTS } = await import('../lib/server/near-threshold-store.ts');
    let calls = 0;
    const failing = async () => { calls += 1; throw new Error('resend returned HTTP 503'); };
    const readView = async (orgId) => (orgId === 'acme' ? { ok: true, view: acmeView() } : { ok: false, error: 'the spending rules could not be read from the chain' });
    const first = await runNearThresholdMonitor(monitorDeps(db, [], { readView, sendEmail: failing }));
    assert.equal(first.ok, true);
    assert.deepEqual(first.errors, [{ orgId: 'northwind', error: 'the spending rules could not be read from the chain' }]);
    assert.deepEqual(first.deliveries, { sent: 0, failed: 1, skipped: 0 });
    for (let i = 1; i <= MAX_ALERT_EMAIL_ATTEMPTS + 2; i += 1) await runNearThresholdMonitor(monitorDeps(db, [], { readView, sendEmail: failing, now: NOW + i * 60_000 }));
    assert.equal(calls, MAX_ALERT_EMAIL_ATTEMPTS);
    const row = (await client.query(`SELECT status, attempts, error FROM spend_rule_alert_deliveries`)).rows[0];
    assert.deepEqual([row.status, row.attempts], ['failed', MAX_ALERT_EMAIL_ATTEMPTS]);
    assert.match(row.error, /HTTP 503/);

    // A business with no wallet yet is skipped, not an error.
    const skipped = await runNearThresholdMonitor(monitorDeps(db, [], { readView: async () => ({ ok: false, skip: true, error: 'register the business wallet first' }) }));
    assert.deepEqual(skipped.errors, []);
  });
});

test('without a database the monitor does not run', async () => {
  const { runNearThresholdMonitor } = await import('../lib/server/near-threshold-monitor.ts');
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const r = await runNearThresholdMonitor({ readView: async () => ({ ok: true, view: acmeView() }) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /DATABASE_URL/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

// ─── 3. The routes ────────────────────────────────────────────────────────────

async function code(relative) {
  const text = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('the owners\' alerts route reads the caller\'s org from the session, owners only, and never an org from the request', async () => {
  const src = await code('app/api/wallet/spending-rules/alerts/route.ts');
  assert.match(src, /requireSessionAccount\(/);
  assert.match(src, /role\s*!==\s*'OWNER'/);
  assert.match(src, /listSpendRuleAlertsForOrg\(\s*db,\s*accountCheck\.account\.orgId/);
  assert.doesNotMatch(src, /searchParams|request\.json|orgId\s*=\s*body/, 'no org from the request');
});

test('the spending-rules view gives owners the live near-threshold flags, and nobody else', async () => {
  const src = await code('app/api/wallet/spending-rules/route.ts');
  assert.match(src, /deriveNearThresholdAlerts\(/);
  assert.match(src, /route\.authority\.role === 'OWNER'\s*\?\s*\{\s*nearThreshold:/);
});

// ─── 4. Review fixes ─────────────────────────────────────────────────────────

const spendAt = (recipient, i, timestampMs) => ({ ...spend(recipient, i), timestampMs: String(timestampMs) });

test('a repeat counts only the payments inside what the threshold check counts now', () => {
  const t = { ...total({ counted: 8_500n * USDC }), countsFromMs: String(W0) };
  const old = spendAt(SUPPLIER, 1, W0 - 7n * DAY);
  const current = spendAt(SUPPLIER, 2, W0 + 60_000n);
  assert.deepEqual(deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [t], spends: [old, current] })])), [], "last week's payment plus today's is not a repeat");
  const [a] = deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [t], spends: [current, spendAt(SUPPLIER, 3, W0 + 120_000n), old] })]));
  assert.equal(a.payments, 2);
});

test('several spenders going from near the threshold to over it is a new alert, keyed by severity', () => {
  const near = deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [total({ counted: 4_000n * USDC })] }), rule(STAFF_B, { totals: [total({ counted: 4_500n * USDC })] })]));
  const over = deriveNearThresholdAlerts(view([rule(STAFF_A, { totals: [total({ counted: 6_000n * USDC })] }), rule(STAFF_B, { totals: [total({ counted: 6_000n * USDC })] })]));
  assert.equal(near[0].severity, 'near_threshold');
  assert.equal(over[0].severity, 'over_threshold');
  assert.notEqual(near[0].key, over[0].key);
});

test('near then over in the same windows: the owners are emailed again, and only the over alert is still shown', async () => {
  await withDb(async ({ client, db }) => {
    await seed(client);
    const { runNearThresholdMonitor } = await import('../lib/server/near-threshold-monitor.ts');
    const { listSpendRuleAlertsForOrg } = await import('../lib/server/near-threshold-store.ts');
    const group = (a, b) => view([rule(STAFF_A, { totals: [total({ counted: a })] }), rule(STAFF_B, { totals: [total({ counted: b })] })]);
    const sent = [];
    const readView = (v) => async (orgId) => ({ ok: true, view: orgId === 'acme' ? v : view([]) });
    await runNearThresholdMonitor(monitorDeps(db, sent, { readView: readView(group(4_000n * USDC, 4_500n * USDC)) }));
    assert.equal(sent.length, 1);
    const second = await runNearThresholdMonitor(monitorDeps(db, sent, { now: NOW + 3_600_000, readView: readView(group(6_000n * USDC, 6_000n * USDC)) }));
    assert.equal(second.recorded, 1, 'the escalation is recorded');
    assert.equal(sent.length, 2, 'and emailed');
    assert.match(sent[1].text, /above the 10,000 USDC/);
    const shown = await listSpendRuleAlertsForOrg(db, 'acme', NOW + 3_600_000);
    assert.deepEqual(shown.map((a) => [a.severity, a.countedMinor]), [['over_threshold', String(12_000n * USDC)]]);
  });
});

test('a repeat whose payment count rises keeps one alert, updated, and is not emailed again', async () => {
  await withDb(async ({ client, db }) => {
    await seed(client);
    const { runNearThresholdMonitor } = await import('../lib/server/near-threshold-monitor.ts');
    const { listSpendRuleAlertsForOrg } = await import('../lib/server/near-threshold-store.ts');
    const sent = [];
    const v = (counted, n) => view([rule(STAFF_A, { totals: [total({ counted })], spends: Array.from({ length: n }, (_, i) => spend(SUPPLIER, i + 1)) })]);
    await runNearThresholdMonitor(monitorDeps(db, sent, { readView: async (o) => ({ ok: true, view: o === 'acme' ? v(8_500n * USDC, 2) : view([]) }) }));
    await runNearThresholdMonitor(monitorDeps(db, sent, { now: NOW + 3_600_000, readView: async (o) => ({ ok: true, view: o === 'acme' ? v(9_500n * USDC, 3) : view([]) }) }));
    assert.equal(sent.length, 1);
    const [a] = await listSpendRuleAlertsForOrg(db, 'acme', NOW + 3_600_000);
    assert.deepEqual([a.payments, a.countedMinor], [3, String(9_500n * USDC)], 'the in-app alert shows what is counted now');
  });
});

test('the cron route refuses without CRON_SECRET', async () => {
  const src = await code('app/api/cron/spend-rule-alerts/route.ts');
  assert.match(src, /CRON_SECRET/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /runNearThresholdMonitor\(/);
  assert.match(src, /status: 502/);
});
