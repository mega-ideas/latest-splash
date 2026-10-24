import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Plain Node cannot resolve the extensionless `next/server`; point it at the
// file, as tests/launch-scope-routes.test.mjs does, so the real route loads.
registerHooks({
  resolve: (specifier, context, nextResolve) => nextResolve(specifier === 'next/server' ? 'next/server.js' : specifier, context),
});

import { attachDb, migratedDb } from './helpers/store-db.mjs';
import {
  REVIEW_PATH,
  classifyGovernanceEvents,
  configurationDrift,
  formatUtc,
  watchedEventTypes,
} from '../lib/server/governance-events.ts';

/* v2 brief 3.5, review checklist A.7: "check the listener, not just the event".

   The Move side emits UpgradeProposed and friends; this file tests what the
   backend does with them. `wrap` is public, so anyone can emit a well-formed
   UpgradeProposed from a wrapper of their own, or publish a look-alike
   `upgrade_delay` module. The classifier must alert on the canonical events
   and nothing else; the monitor must record each once and tell every owner
   once per channel, however often it runs. Nothing here reaches a network:
   the events, the email transport and WhatsApp are injected, and the database
   is PGlite with every migration applied. */

const UD = '0x' + 'd1'.repeat(32);
const WRAP = '0x' + 'a1'.repeat(32);
const CORE = '0x' + 'c0'.repeat(32);
const CORE_V2 = '0x' + 'c2'.repeat(32);
const CONFIG = '0x' + 'cf'.repeat(32);
const ATTACKER = '0x' + '99'.repeat(32);

const POLICY = { upgradeDelayPackageId: UD, wrapperId: WRAP, corePackageId: CORE, complianceConfigId: CONFIG };
const ENV = {
  NODE_ENV: 'test',
  SPLASH_UPGRADE_DELAY_PACKAGE_ID: UD,
  SPLASH_UPGRADE_WRAPPER_ID: WRAP,
  SPLASH_CORE_PACKAGE_ID: CORE,
  SPLASH_COMPLIANCE_CONFIG_ID: CONFIG,
};

const NOW = Date.UTC(2026, 9, 24, 9, 0);
const PROPOSED = NOW - 60 * 60 * 1000;
const ETA = PROPOSED + 86_400_000;
const BYTECODE = Buffer.alloc(32, 7);

function upgradeProposed(over = {}) {
  return {
    digest: over.digest ?? 'TxUpgradeProposed1',
    eventSeq: over.eventSeq ?? 0,
    type: `${over.typePackage ?? UD}::upgrade_delay::UpgradeProposed`,
    timestampMs: PROPOSED,
    json: {
      wrapper_id: over.wrapper ?? WRAP,
      package: over.package ?? CORE,
      digest: BYTECODE.toString('base64'),
      proposed_at_ms: String(PROPOSED),
      eta_ms: String(ETA),
      policy: 128,
    },
  };
}

function registryEvent(name, over = {}) {
  const json = { config_id: over.config ?? CONFIG, registry: over.registry ?? 2, type_name: over.typeName ?? `${'ab'.repeat(32)}::payroll_app::PAYROLL_APP` };
  if (name === 'RegistryAdditionProposed') Object.assign(json, { proposed_at_ms: String(PROPOSED), eta_ms: String(ETA) });
  return {
    digest: over.digest ?? `Tx${name}`,
    eventSeq: over.eventSeq ?? 0,
    type: `${over.typePackage ?? CORE}::compliance_config::${name}`,
    timestampMs: PROPOSED,
    json,
  };
}

// ─── 1. The classifier: canonical events in, alerts out ────────────────────

test('a genuine UpgradeProposed produces exactly one alert, with its eta, the review link and the diff summary', () => {
  const report = classifyGovernanceEvents([upgradeProposed(), upgradeProposed()], POLICY);
  assert.equal(report.alerts.length, 1, 'the same event twice is one alert');
  const [alert] = report.alerts;
  assert.equal(alert.kind, 'upgrade_proposed');
  assert.equal(alert.digest, 'TxUpgradeProposed1');
  assert.equal(alert.eventSeq, 0);
  assert.equal(alert.etaMs, ETA);
  assert.equal(alert.proposedAtMs, PROPOSED);
  assert.equal(alert.reviewPath, '/dashboard/settings/spending-rules');
  assert.equal(REVIEW_PATH, '/dashboard/settings/spending-rules');
  assert.equal(
    alert.summary,
    `Splash has announced an update to its payment contract. It can take effect from ${formatUtc(ETA)}. ` +
      'Review your spending rules and revoke any allowance you are not comfortable with before then.',
  );
  assert.equal(formatUtc(ETA), '25 October 2026, 08:00 UTC');
  assert.equal(alert.bytecodeDigest, `0x${'07'.repeat(32)}`);
  assert.match(alert.detail, /can only add to the contract/);
  assert.match(alert.detail, /cannot add a recipient, raise a spending limit or create an allowance/);
  assert.match(alert.detail, new RegExp(`Code fingerprint: 0x${'07'.repeat(32)}`));
  assert.doesNotMatch(alert.summary + alert.detail, /[—–]/, 'plain punctuation: no dashes as separators');
  assert.ok(alert.activeUntilMs >= ETA + 7 * 86_400_000, 'shown until seven days after it can take effect');
  assert.deepEqual(report.ignored, []);
});

test('a spoofed wrapper id is ignored: anyone can wrap a cap of their own and emit the same event', () => {
  const report = classifyGovernanceEvents([upgradeProposed({ wrapper: '0x' + 'ee'.repeat(32) })], POLICY);
  assert.deepEqual(report.alerts, []);
  assert.equal(report.ignored[0].reason, 'wrapper_not_canonical');
});

test('a look-alike upgrade_delay module in another package is ignored, even with every field copied', () => {
  const report = classifyGovernanceEvents([upgradeProposed({ typePackage: ATTACKER })], POLICY);
  assert.deepEqual(report.alerts, []);
  assert.equal(report.ignored[0].reason, 'type_not_canonical');
  // And for the registry events: a compliance_config::RegistryAdditionProposed
  // that splash_core did not define.
  const registry = classifyGovernanceEvents([registryEvent('RegistryAdditionProposed', { typePackage: ATTACKER })], POLICY);
  assert.deepEqual(registry.alerts, []);
  assert.equal(registry.ignored[0].reason, 'type_not_canonical');
});

test('an event for another package id is ignored, and reported as configuration drift', () => {
  const report = classifyGovernanceEvents([upgradeProposed({ package: ATTACKER })], POLICY);
  assert.deepEqual(report.alerts, []);
  assert.equal(report.ignored[0].reason, 'package_not_canonical');
  assert.equal(configurationDrift(report).length, 1, 'a genuine wrapper naming an unknown package is drift, not noise');

  // The wrapper records core's original id at wrap and every event names
  // it, so a later core version in `package` is drift too: it means
  // SPLASH_CORE_PACKAGE_ID was set to that version, not the original.
  const later = classifyGovernanceEvents([upgradeProposed({ package: CORE_V2 })], POLICY);
  assert.deepEqual(later.alerts, []);
  assert.equal(configurationDrift(later).length, 1);
});

test('a registry event for any other config id is ignored', () => {
  const report = classifyGovernanceEvents([registryEvent('RegistryAdditionProposed', { config: '0x' + 'ce'.repeat(32) })], POLICY);
  assert.deepEqual(report.alerts, []);
  assert.equal(report.ignored[0].reason, 'config_not_canonical');
});

test('ids compare in canonical form: short, upper-case or unpadded still match, and only exactly', () => {
  const report = classifyGovernanceEvents(
    [upgradeProposed({ wrapper: WRAP.toUpperCase().replace('0X', '0x'), typePackage: UD.toUpperCase().replace('0X', '0x') })],
    POLICY,
  );
  assert.equal(report.alerts.length, 1);
  const short = '0x2';
  assert.equal(classifyGovernanceEvents([upgradeProposed({ typePackage: short })], POLICY).ignored[0].reason, 'type_not_canonical');
});

test('registry additions name what is being added; authorisation and activation say it has taken effect; owner changes alert', () => {
  const report = classifyGovernanceEvents(
    [
      registryEvent('RegistryAdditionProposed', { registry: 1, typeName: `${'ab'.repeat(32)}::usdt::USDT`, digest: 'TxAsset' }),
      registryEvent('RegistryAdditionProposed', { registry: 2, digest: 'TxApp' }),
      registryEvent('RegistryAdditionProposed', { registry: 3, typeName: `${'ab'.repeat(32)}::cctp_adapter::CCTP`, digest: 'TxBridge' }),
      registryEvent('RegistryAdditionActivated', { registry: 2, digest: 'TxAppLive' }),
      {
        digest: 'TxAuthorized',
        eventSeq: 1,
        type: `${UD}::upgrade_delay::UpgradeAuthorized`,
        timestampMs: ETA + 1000,
        json: { wrapper_id: WRAP, package: CORE, digest: BYTECODE.toString('base64'), policy: 128 },
      },
      {
        digest: 'TxOwner',
        eventSeq: 0,
        type: `${UD}::upgrade_delay::OwnerChangeProposed`,
        timestampMs: PROPOSED,
        json: { wrapper_id: WRAP, new_owner: '0x' + '0b'.repeat(32), eta_ms: String(ETA) },
      },
    ],
    POLICY,
  );
  assert.deepEqual(report.ignored, []);
  const by = Object.fromEntries(report.alerts.map((a) => [a.digest, a]));
  assert.match(by.TxAsset.summary, /^Splash has announced a new payment asset \(usdt::USDT\)\. It can take effect from /);
  assert.match(by.TxApp.summary, /^Splash has announced a new app that can pay under spending rules \(payroll_app::PAYROLL_APP\)\./);
  assert.match(by.TxBridge.summary, /^Splash has announced a new cross-chain bridge adapter \(cctp_adapter::CCTP\)\./);
  assert.match(by.TxApp.detail, new RegExp(`Full type: ${'ab'.repeat(32)}::payroll_app::PAYROLL_APP\\.`));
  assert.match(by.TxAppLive.summary, /^Splash has added a new app that can pay under spending rules \(payroll_app::PAYROLL_APP\)\. It has now taken effect\./);
  assert.equal(by.TxAuthorized.kind, 'upgrade_authorized');
  assert.match(by.TxAuthorized.summary, /has now taken effect\. Review your spending rules/);
  assert.equal(by.TxOwner.kind, 'owner_change_proposed');
  assert.match(by.TxOwner.summary, /^Splash has announced a change to who can update its payment contract\./);
  for (const alert of report.alerts) assert.equal(alert.reviewPath, REVIEW_PATH);
});

test('malformed and unwatched events are ignored with a reason, never alerted', () => {
  const missingEta = upgradeProposed({ digest: 'TxNoEta' });
  delete missingEta.json.eta_ms;
  const report = classifyGovernanceEvents(
    [
      missingEta,
      { digest: 'TxCancel', eventSeq: 0, type: `${UD}::upgrade_delay::UpgradeCancelled`, timestampMs: NOW, json: { wrapper_id: WRAP } },
      { digest: 'TxJunk', eventSeq: 0, type: 'not a type', timestampMs: NOW, json: {} },
    ],
    POLICY,
  );
  assert.deepEqual(report.alerts, []);
  assert.deepEqual(report.ignored.map((i) => [i.digest, i.reason]), [['TxNoEta', 'malformed'], ['TxCancel', 'not_watched'], ['TxJunk', 'malformed']]);
});

test('the listener asks the indexer for exactly the five watched types, under each known core version', () => {
  assert.deepEqual(watchedEventTypes(POLICY).sort(), [
    `${CORE}::compliance_config::RegistryAdditionActivated`,
    `${CORE}::compliance_config::RegistryAdditionProposed`,
    `${UD}::upgrade_delay::OwnerChangeProposed`,
    `${UD}::upgrade_delay::UpgradeAuthorized`,
    `${UD}::upgrade_delay::UpgradeProposed`,
  ]);
});

// ─── 2. Configuration fails closed ─────────────────────────────────────────

test('unconfigured or malformed canonical ids fail closed, naming every key', async () => {
  const { readGovernanceConfig, runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
  const none = readGovernanceConfig({});
  assert.equal(none.ok, false);
  for (const key of ['SPLASH_UPGRADE_DELAY_PACKAGE_ID', 'SPLASH_UPGRADE_WRAPPER_ID', 'SPLASH_CORE_PACKAGE_ID', 'SPLASH_COMPLIANCE_CONFIG_ID']) {
    assert.match(none.reason, new RegExp(key));
  }
  const bad = readGovernanceConfig({ ...ENV, SPLASH_UPGRADE_WRAPPER_ID: '0x123', SPLASH_CORE_PACKAGE_ID: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /SPLASH_UPGRADE_WRAPPER_ID, SPLASH_CORE_PACKAGE_ID are not a 0x \+ 64 hex id/);
  const good = readGovernanceConfig(ENV);
  assert.equal(good.policy.corePackageId, CORE);

  // The monitor refuses before it reads a single event.
  let read = false;
  const result = await runGovernanceAlertMonitor({ env: {}, readEvents: async () => { read = true; return []; } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not configured/);
  assert.equal(read, false, 'no canonical ids, no listening: nothing could be told apart from a spoof');
});

test('the cron route refuses without CRON_SECRET, and answers 502 when the ids are not configured', async () => {
  const saved = {};
  for (const key of ['CRON_SECRET', ...Object.keys(ENV).filter((k) => k !== 'NODE_ENV')]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const route = await import('@/app/api/cron/governance-alerts/route');
    const call = (headers = {}) => new Request('http://localhost/api/cron/governance-alerts', { headers });

    // No secret configured: nobody is authorised, not even a bearer of nothing.
    assert.equal((await route.GET(call())).status, 401);
    assert.equal((await route.GET(call({ authorization: 'Bearer ' }))).status, 401);

    process.env.CRON_SECRET = 'governance-cron-secret-0123456789';
    assert.equal((await route.GET(call())).status, 401, 'no header');
    assert.equal((await route.POST(call({ authorization: 'Bearer wrong-secret-0123456789abcdef' }))).status, 401, 'wrong secret');

    const refused = await route.GET(call({ authorization: `Bearer ${process.env.CRON_SECRET}` }));
    assert.equal(refused.status, 502, 'a watchman with nothing to compare against is not watching');
    const body = await refused.json();
    assert.equal(body.success, false);
    assert.match(body.error, /governance alerts are not configured/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ─── 3. The listener: record once, tell every owner once per channel ───────

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

/** acme: alice (owner, verified WhatsApp), bob (owner, UNVERIFIED number),
 *  carol (checker, not an owner, verified number). northwind: dave (owner, no
 *  channel). erin owns both orgs. */
async function seedOwners(client) {
  await client.exec(`
    INSERT INTO users (id, email, name, email_verified_at) VALUES
      ('u_alice', 'alice@acme.example', 'Alice Tan', now()),
      ('u_bob', 'bob@acme.example', 'Bob Lim', now()),
      ('u_carol', 'carol@acme.example', 'Carol Ong', now()),
      ('u_dave', 'dave@northwind.example', 'Dave Ng', now()),
      ('u_erin', 'erin@both.example', 'Erin Koh', now());
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m_alice', 'u_alice', 'acme', 'admin'),
      ('m_bob', 'u_bob', 'acme', 'admin'),
      ('m_carol', 'u_carol', 'acme', 'checker'),
      ('m_dave', 'u_dave', 'northwind', 'admin'),
      ('m_erin_a', 'u_erin', 'acme', 'admin'),
      ('m_erin_n', 'u_erin', 'northwind', 'admin');
    INSERT INTO approver_channels (id, org_id, user_id, whatsapp_e164, verified_at) VALUES
      ('ac_alice', 'acme', 'u_alice', '+60102651678', now()),
      ('ac_bob', 'acme', 'u_bob', '+60102651679', NULL),
      ('ac_carol', 'acme', 'u_carol', '+60102651680', now());
  `);
}

function harness(events, over = {}) {
  const emails = [];
  const whatsapps = [];
  const pages = [];
  return {
    emails,
    whatsapps,
    pages,
    deps: (db, extra = {}) => ({
      env: ENV,
      db,
      now: NOW,
      appUrl: 'https://v1.splashz.xyz',
      readEvents: async () => events,
      sendEmail: over.sendEmail ?? (async (message) => { emails.push(message); return { providerRef: `em_${emails.length}` }; }),
      sendWhatsApp: async (to, body) => { whatsapps.push({ to, body }); return { sent: true, providerRef: `wa_${whatsapps.length}` }; },
      alert: async (a) => { pages.push(a); },
      ...extra,
    }),
  };
}

const deliveryRows = async (client) =>
  (await client.query(`SELECT user_id, channel, status, attempts, error FROM governance_alert_deliveries ORDER BY channel, user_id`)).rows;

test('a genuine announcement is recorded once and reaches every owner of every org: in-app and email each, WhatsApp only if verified', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const spoofs = [
      upgradeProposed({ digest: 'TxSpoofWrapper', wrapper: '0x' + 'ee'.repeat(32) }),
      upgradeProposed({ digest: 'TxSpoofType', typePackage: ATTACKER }),
      registryEvent('RegistryAdditionProposed', { digest: 'TxSpoofConfig', config: '0x' + 'ce'.repeat(32) }),
    ];
    const h = harness([upgradeProposed(), ...spoofs]);
    const result = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.recorded.length, 1);
    assert.equal(result.owners, 4, 'alice, bob, dave and erin; carol is a checker, not an owner');

    const alerts = (await client.query(`SELECT digest, event_seq, kind, review_path, eta_at FROM governance_alerts`)).rows;
    assert.equal(alerts.length, 1, 'no spoof was recorded');
    assert.equal(alerts[0].digest, 'TxUpgradeProposed1');
    assert.equal(alerts[0].review_path, REVIEW_PATH);
    assert.equal(new Date(alerts[0].eta_at).getTime(), ETA);

    const rows = await deliveryRows(client);
    const by = (channel) => rows.filter((r) => r.channel === channel).map((r) => r.user_id);
    assert.deepEqual(by('in_app'), ['u_alice', 'u_bob', 'u_dave', 'u_erin']);
    assert.deepEqual(by('email'), ['u_alice', 'u_bob', 'u_dave', 'u_erin'], 'erin owns two orgs and is told once');
    assert.deepEqual(by('whatsapp'), ['u_alice'], 'never to an unverified number, never to a non-owner');
    assert.ok(rows.every((r) => r.status === 'sent'));

    assert.deepEqual(h.emails.map((m) => m.to).sort(), ['alice@acme.example', 'bob@acme.example', 'dave@northwind.example', 'erin@both.example']);
    const email = h.emails[0];
    assert.equal(email.subject, 'An update to the Splash payment contract has been announced');
    assert.match(email.text, /^Splash has announced an update to its payment contract\./);
    assert.match(email.text, /https:\/\/v1\.splashz\.xyz\/dashboard\/settings\/spending-rules/);
    assert.equal(email.link, 'https://v1.splashz.xyz/dashboard/settings/spending-rules');
    assert.match(email.text, /transaction TxUpgradeProposed1/, 'checkable without trusting the message');
    assert.deepEqual(h.whatsapps.map((w) => w.to), ['+60102651678']);
    assert.match(h.whatsapps[0].body, /Review your spending rules and allowances: https:\/\/v1\.splashz\.xyz\/dashboard\/settings\/spending-rules$/);
    assert.deepEqual(h.pages, [], 'no drift, no page');
  });
});

test('re-running, even two instances racing on the first run, never records an alert twice or sends anything twice', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness([upgradeProposed()]);

    // Two instances at the same moment, both seeing nothing recorded yet.
    const [a, b] = await Promise.all([runGovernanceAlertMonitor(h.deps(db)), runGovernanceAlertMonitor(h.deps(db))]);
    assert.equal(a.ok && b.ok, true);
    assert.equal(a.recorded.length + b.recorded.length, 1, 'one of them recorded it');
    assert.equal(h.emails.length, 4, 'each owner emailed once between them');
    assert.equal(h.whatsapps.length, 1);
    const before = await deliveryRows(client);
    assert.equal(before.length, 9, 'four in-app, four email, one WhatsApp');

    const again = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(again.ok, true);
    assert.deepEqual(again.recorded, []);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM governance_alerts`)).rows[0].n, 1);
    assert.deepEqual(await deliveryRows(client), before, 'the same rows, untouched');
    assert.equal(h.emails.length + h.whatsapps.length, 5, 'nothing sent again');
    assert.deepEqual(again.deliveries.email, { sent: 0, failed: 0, skipped: 4 });
  });
});

test('a failed delivery is recorded, does not stop the others, and is retried a bounded number of times', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const { MAX_DELIVERY_ATTEMPTS } = await import('../lib/server/governance-alerts-store.ts');
    const delivered = [];
    const flaky = async (message) => {
      if (message.to === 'bob@acme.example') throw new Error('resend returned HTTP 503 for a notice message');
      delivered.push(message.to);
      return { providerRef: null };
    };
    const h = harness([upgradeProposed()], { sendEmail: flaky });
    const first = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(first.ok, true);
    assert.deepEqual(first.deliveries.email, { sent: 3, failed: 1, skipped: 0 });
    assert.deepEqual(delivered.sort(), ['alice@acme.example', 'dave@northwind.example', 'erin@both.example']);
    const bob = (await deliveryRows(client)).find((r) => r.user_id === 'u_bob' && r.channel === 'email');
    assert.equal(bob.status, 'failed');
    assert.match(bob.error, /HTTP 503/);
    const bobInApp = (await deliveryRows(client)).find((r) => r.user_id === 'u_bob' && r.channel === 'in_app');
    assert.equal(bobInApp.status, 'sent', 'his banner does not depend on his email');

    for (let run = 2; run <= MAX_DELIVERY_ATTEMPTS + 2; run += 1) await runGovernanceAlertMonitor(h.deps(db));
    const retried = (await deliveryRows(client)).find((r) => r.user_id === 'u_bob' && r.channel === 'email');
    assert.equal(retried.attempts, MAX_DELIVERY_ATTEMPTS, 'retried, then left alone');
    assert.equal(retried.status, 'failed');
    assert.deepEqual(delivered.sort(), ['alice@acme.example', 'dave@northwind.example', 'erin@both.example'], 'no one else was sent anything twice');
  });
});

test('an owner added during the notice is told on the next run; an expired alert is not fanned out', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness([upgradeProposed()]);
    await runGovernanceAlertMonitor(h.deps(db));
    await client.exec(`
      INSERT INTO users (id, email, name, email_verified_at) VALUES ('u_fay', 'fay@northwind.example', 'Fay Goh', now());
      INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m_fay', 'u_fay', 'northwind', 'admin');
    `);
    const next = await runGovernanceAlertMonitor(h.deps(db, { readEvents: async () => [] }));
    assert.deepEqual(next.deliveries.email, { sent: 1, failed: 0, skipped: 4 }, 'the alert came from the database, not this run\'s events');
    assert.equal(h.emails.at(-1).to, 'fay@northwind.example');

    await client.exec(`INSERT INTO users (id, email, name, email_verified_at) VALUES ('u_gus', 'gus@acme.example', 'Gus Tay', now());
      INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m_gus', 'u_gus', 'acme', 'admin');`);
    const late = await runGovernanceAlertMonitor(h.deps(db, { now: ETA + 30 * 86_400_000, readEvents: async () => [] }));
    assert.deepEqual(late.active, []);
    assert.equal(h.emails.some((m) => m.to === 'gus@acme.example'), false, 'nobody is emailed about a change long past');
  });
});

test('the dashboard banner reads the signed-in owner\'s own in-app deliveries, and only while the alert is active', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const { readGovernanceBannerForSession } = await import('../lib/server/governance-alerts-store.ts');
    await runGovernanceAlertMonitor(harness([upgradeProposed()]).deps(db));

    const alice = await readGovernanceBannerForSession({ email: 'Alice@Acme.example' }, NOW);
    assert.equal(alice.length, 1);
    assert.equal(alice[0].kind, 'upgrade_proposed');
    assert.equal(alice[0].reviewPath, REVIEW_PATH);
    assert.match(alice[0].summary, /^Splash has announced an update to its payment contract\./);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'carol@acme.example' }, NOW), [], 'not an owner, no banner');
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'nobody@else.example' }, NOW), []);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }, ETA + 30 * 86_400_000), [], 'gone once the window closes');
  });
});

test('a genuine wrapper event naming another core package is not alerted, and pages a person instead', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness([upgradeProposed({ package: CORE_V2 })]);
    const result = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(result.ok, true);
    assert.equal(result.drift.length, 1);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM governance_alerts`)).rows[0].n, 0);
    assert.equal(h.emails.length, 0);
    assert.deepEqual(h.pages.map((p) => [p.kind, p.severity, p.digest]), [['governance_config_drift', 'critical', 'TxUpgradeProposed1']]);
  });
});

test('the GraphQL reader parses indexer nodes into classifier input and stops at the window', async () => {
  const { graphqlGovernanceReader } = await import('../lib/server/governance-alert-monitor.ts');
  const asked = [];
  const fetcher = async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    asked.push(variables.type);
    const nodes = variables.type.endsWith('::UpgradeProposed')
      ? [
          { sequenceNumber: 0, timestamp: new Date(NOW - 20 * 86_400_000).toISOString(), transaction: { digest: 'TxOld' }, contents: { type: { repr: variables.type }, json: {} } },
          { sequenceNumber: 2, timestamp: new Date(PROPOSED).toISOString(), transaction: { digest: 'TxNew' }, contents: { type: { repr: variables.type }, json: upgradeProposed().json } },
          { sequenceNumber: 3, timestamp: null, transaction: null, contents: { type: { repr: variables.type }, json: {} } },
        ]
      : [];
    return new Response(JSON.stringify({ data: { events: { pageInfo: { hasPreviousPage: nodes.length > 0, startCursor: 'c' }, nodes } } }), { status: 200 });
  };
  const events = await graphqlGovernanceReader(fetcher, 'https://graphql.invalid')(watchedEventTypes(POLICY), NOW - 9 * 86_400_000);
  assert.equal(asked.length, 5, 'one query per watched type; the old event ended the walk back');
  assert.deepEqual(events.map((e) => [e.digest, e.eventSeq]), [['TxNew', 2]], 'too old and not yet indexed are both dropped');
  assert.equal(classifyGovernanceEvents(events, POLICY).alerts.length, 1);
});

// ─── 4. Review (v2 Phase 1): the chain's state is the source, not a feed ───
//
// These run the real cron route against a fake Sui. The fake serves BOTH the
// global event feed (`events(filter: { type })`, paged backwards the way Sui
// GraphQL pages it) and the two canonical objects (`GovernanceState`), and
// the two always agree, so each test says what the chain holds whichever of
// them a monitor reads. Email (Resend), WhatsApp (Twilio) and the operator
// page (OPERATOR_ALERT_WEBHOOK_URL) go through the same fake, so the test
// sees exactly what left the process. Times are relative to the real clock,
// because the route reads it.

const GRAPHQL = 'https://graphql.review.invalid/graphql';
const WEBHOOK = 'https://pager.review.invalid/hook';
const STRANGER_WRAP = '0x' + 'ee'.repeat(32);
const GOVERNANCE = '0x' + '6a'.repeat(32);
const NEW_GOVERNANCE = '0x' + '0b'.repeat(32);
const CORE_CAP = '0x' + '5c'.repeat(32);
const USDC_TYPE = `${'a1'.repeat(32)}::usdc::USDC`;
const APP_TYPE = `${'ab'.repeat(32)}::payroll_app::PAYROLL_APP`;
const EVIL_ADAPTER = `${'ee'.repeat(32)}::evil::EvilAdapter`;
const DIGEST_HEX = `0x${'07'.repeat(32)}`;
const DIGEST_B64 = Buffer.alloc(32, 7).toString('base64');
const T_UPGRADE = `${UD}::upgrade_delay::UpgradeProposed`;
const T_UPGRADE_CANCELLED = `${UD}::upgrade_delay::UpgradeCancelled`;
const T_OWNER = `${UD}::upgrade_delay::OwnerChangeProposed`;
const T_ADDITION = `${CORE}::compliance_config::RegistryAdditionProposed`;
const T_ADDITION_CANCELLED = `${CORE}::compliance_config::RegistryAdditionCancelled`;

/** The canonical wrapper as `object(address) { … }` renders it. */
function wrapperObject(over = {}) {
  return {
    address: over.address ?? WRAP,
    version: over.version ?? 40,
    owner: { __typename: 'AddressOwner', address: { address: over.owner ?? GOVERNANCE } },
    asMoveObject: {
      contents: {
        type: { repr: over.type ?? `${UD}::upgrade_delay::DelayedUpgradeCap` },
        json: over.json ?? {
          id: over.address ?? WRAP,
          cap: { id: CORE_CAP, package: over.latest ?? CORE, version: String(over.capVersion ?? 1), policy: 128 },
          original_package: over.original ?? CORE,
          pending: over.pending ?? null,
          pending_owner: over.pendingOwner ?? null,
        },
      },
    },
  };
}

/** The canonical compliance config, likewise. */
function configObject(over = {}) {
  return {
    address: CONFIG,
    version: over.version ?? 900,
    owner: { __typename: 'Shared' },
    asMoveObject: {
      contents: {
        type: { repr: over.type ?? `${CORE}::compliance_config::ComplianceConfig` },
        json: over.json ?? {
          id: CONFIG,
          paused: false,
          accepted_assets: { contents: over.assets ?? [USDC_TYPE] },
          settlement_apps: { contents: over.apps ?? [] },
          bridge_adapters: { contents: over.adapters ?? [] },
          pending_additions: (over.pending ?? []).map((p) => ({
            registry: p.registry,
            type_name: p.typeName,
            proposed_at_ms: String(p.proposedAtMs),
            eta_ms: String(p.etaMs),
          })),
          legacy_enabled: true,
        },
      },
    },
  };
}

function eventNode(type, digest, seq, ms, json) {
  return { sequenceNumber: seq, timestamp: new Date(ms).toISOString(), transaction: { digest }, contents: { type: { repr: type }, json } };
}

/**
 * Everything outside the process. `chain.wrapper` / `chain.config` are the
 * objects (null: no such object), `chain.events` the feed oldest first,
 * `chain.stateReply` overrides the object read's whole HTTP reply.
 */
function fakeWorld(chain) {
  const calls = { events: 0, state: 0 };
  const emails = [];
  const whatsapps = [];
  const pages = [];
  const fetcher = async (url, init = {}) => {
    const href = String(url);
    if (href === GRAPHQL) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('events(')) {
        calls.events += 1;
        const matching = (chain.events ?? []).filter((n) => n.contents.type.repr === variables.type);
        const end = variables.before == null ? matching.length : Number(variables.before);
        const start = Math.max(0, end - variables.last);
        const nodes = matching.slice(start, end);
        return Response.json({ data: { events: { pageInfo: { hasPreviousPage: start > 0, startCursor: nodes.length ? String(start) : null }, nodes } } });
      }
      if (query.includes('GovernanceState')) {
        calls.state += 1;
        if (chain.stateReply) return chain.stateReply();
        return Response.json({ data: { wrapper: chain.wrapper === undefined ? wrapperObject() : chain.wrapper, config: chain.config === undefined ? configObject() : chain.config } });
      }
      return Response.json({ errors: [{ message: 'unknown query' }] });
    }
    if (href === 'https://api.resend.com/emails') {
      const body = JSON.parse(init.body);
      emails.push({ to: body.to[0], subject: body.subject, text: body.text });
      return Response.json({ id: `em_${emails.length}` });
    }
    if (href.startsWith('https://api.twilio.com/')) {
      const form = new URLSearchParams(String(init.body));
      whatsapps.push({ to: form.get('To'), body: form.get('Body') });
      return Response.json({ sid: `SM${whatsapps.length}` });
    }
    if (href === WEBHOOK) {
      pages.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`the test world has no ${href}`);
  };
  return { fetcher, calls, emails, whatsapps, pages };
}

const ROUTE_ENV = {
  CRON_SECRET: 'governance-cron-secret-0123456789',
  SPLASH_UPGRADE_DELAY_PACKAGE_ID: UD,
  SPLASH_UPGRADE_WRAPPER_ID: WRAP,
  SPLASH_CORE_PACKAGE_ID: CORE,
  SPLASH_COMPLIANCE_CONFIG_ID: CONFIG,
  SUI_GRAPHQL_URL: GRAPHQL,
  OPERATOR_ALERT_WEBHOOK_URL: WEBHOOK,
  NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz',
  EMAIL_TRANSPORT: 'resend',
  EMAIL_API_KEY: 're_test_governance',
  EMAIL_FROM: 'alerts@splashz.xyz',
  TWILIO_ACCOUNT_SID: 'ACgovernancetest',
  TWILIO_AUTH_TOKEN: 'governance-test-token',
  TWILIO_WHATSAPP_FROM: '+60100000000',
};

/** Seeded owners, the real route, and a fake world the test can change between runs. */
async function withRoute(run, envOver = {}) {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const env = { ...ROUTE_ENV, ...envOver };
    const saved = { fetch: globalThis.fetch };
    for (const key of Object.keys(env)) saved[key] = process.env[key];
    const chain = {};
    const world = fakeWorld(chain);
    try {
      Object.assign(process.env, env);
      globalThis.fetch = world.fetcher;
      const route = await import('@/app/api/cron/governance-alerts/route');
      const cron = async () => {
        const res = await route.GET(new Request('http://localhost/api/cron/governance-alerts', { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }));
        return { status: res.status, body: await res.json() };
      };
      await run({ client, db, chain, world, cron });
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [key, value] of Object.entries(saved)) {
        if (key === 'fetch') continue;
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

const alertRows = async (client) =>
  (await client.query(`SELECT kind, bytecode_digest, eta_at, new_owner, registry, type_name, detail FROM governance_alerts ORDER BY kind`)).rows;

test('review A7: a flood of look-alike events cannot hide a pending proposal; the wrapper\'s own state alerts, and the event feed is not read', async () => {
  await withRoute(async ({ client, chain, world, cron }) => {
    const proposed = Date.now() - 10 * 60_000;
    const eta = proposed + 86_400_000;
    chain.wrapper = wrapperObject({
      pending: { digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta) },
      pendingOwner: { new_owner: NEW_GOVERNANCE, eta_ms: String(eta) },
    });
    // The genuine announcements, then 300 + 200 look-alikes of exactly the
    // canonical types from a stranger's own wrapper (`wrap` is public), all
    // newer. Faithfully paged, the feed's newest 200 per type are the flood.
    chain.events = [
      eventNode(T_UPGRADE, 'TxGenuineUpgrade', 0, proposed, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta), policy: 128 }),
      eventNode(T_OWNER, 'TxGenuineOwner', 1, proposed, { wrapper_id: WRAP, new_owner: NEW_GOVERNANCE, eta_ms: String(eta) }),
      ...Array.from({ length: 300 }, (_, i) => eventNode(T_UPGRADE, 'TxFlood', i * 2, proposed + 2_000, {
        wrapper_id: STRANGER_WRAP, package: ATTACKER, digest: DIGEST_B64, proposed_at_ms: String(proposed + 2_000), eta_ms: String(eta + 2_000), policy: 128,
      })),
      ...Array.from({ length: 200 }, (_, i) => eventNode(T_OWNER, 'TxFlood', 600 + i * 2, proposed + 2_000, { wrapper_id: STRANGER_WRAP, new_owner: '0x' + '0c'.repeat(32), eta_ms: String(eta + 2_000) })),
    ];

    const { status, body } = await cron();
    assert.equal(status, 200, body.error);
    const rows = await alertRows(client);
    assert.deepEqual(rows.map((r) => r.kind), ['owner_change_proposed', 'upgrade_proposed'], 'both genuine proposals alerted, nothing from the flood');
    const upgrade = rows.find((r) => r.kind === 'upgrade_proposed');
    assert.equal(upgrade.bytecode_digest, DIGEST_HEX);
    assert.equal(new Date(upgrade.eta_at).getTime(), eta);
    assert.equal(rows.find((r) => r.kind === 'owner_change_proposed').new_owner, NEW_GOVERNANCE);
    assert.equal(world.emails.length, 8, 'four owners, two announcements each');
    assert.equal(world.calls.events, 0, 'discovery never touches the global event feed anyone can write to');
    assert.ok(world.calls.state >= 1);
  });
});

test('review A7: a configured id that is not the canonical object on chain answers 502, records nothing and pages a person', async () => {
  await withRoute(async ({ client, chain, world, cron }) => {
    const proposed = Date.now() - 10 * 60_000;
    const pending = { digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(proposed + 86_400_000) };
    chain.events = [eventNode(T_UPGRADE, 'TxGenuineUpgrade', 0, proposed, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64, proposed_at_ms: pending.proposed_at_ms, eta_ms: pending.eta_ms, policy: 128 })];
    const cases = [
      ['the wrapper id names no object', { wrapper: null }, /SPLASH_UPGRADE_WRAPPER_ID/],
      ['the wrapper is a DelayedUpgradeCap of a look-alike package', { wrapper: wrapperObject({ type: `${ATTACKER}::upgrade_delay::DelayedUpgradeCap`, pending }) }, /SPLASH_UPGRADE_WRAPPER_ID/],
      ['the wrapper id names some other object', { wrapper: wrapperObject({ type: `${CORE}::business_account::AdminCap`, pending }) }, /SPLASH_UPGRADE_WRAPPER_ID/],
      ['the config id names no object', { wrapper: wrapperObject({ pending }), config: null }, /SPLASH_COMPLIANCE_CONFIG_ID/],
      ['the config is a ComplianceConfig of another package', { wrapper: wrapperObject({ pending }), config: configObject({ type: `${ATTACKER}::compliance_config::ComplianceConfig` }) }, /SPLASH_COMPLIANCE_CONFIG_ID/],
    ];
    for (const [label, objects, names] of cases) {
      Object.assign(chain, objects);
      const pagesBefore = world.pages.length;
      const { status, body } = await cron();
      assert.equal(status, 502, `${label}: must not answer success`);
      assert.equal(body.success, false, label);
      assert.match(body.error, names, label);
      assert.equal((await alertRows(client)).length, 0, `${label}: nothing recorded`);
      assert.equal(world.emails.length, 0, `${label}: nobody told anything`);
      assert.ok(world.pages.slice(pagesBefore).some((p) => p.severity === 'critical'), `${label}: a person is paged`);
      delete chain.wrapper;
      delete chain.config;
    }
  });
});

test('review A7: an unreadable or partial read of the chain answers 502, never success', async () => {
  await withRoute(async ({ client, chain, world, cron }) => {
    const proposed = Date.now() - 10 * 60_000;
    const pending = { digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(proposed + 86_400_000) };
    chain.events = [eventNode(T_UPGRADE, 'TxGenuineUpgrade', 0, proposed, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64, proposed_at_ms: pending.proposed_at_ms, eta_ms: pending.eta_ms, policy: 128 })];
    const good = wrapperObject({ pending }).asMoveObject.contents.json;
    const replies = [
      ['the indexer is down', () => new Response('upstream unavailable', { status: 503 })],
      ['the query is refused', () => Response.json({ errors: [{ message: 'Query exceeded max output nodes' }] })],
      ['no data at all', () => Response.json({ data: null })],
      ['the wrapper has no pending field', () => Response.json({ data: { wrapper: wrapperObject({ json: { ...good, pending: undefined } }), config: configObject() } })],
      ['a 31-byte digest', () => Response.json({ data: { wrapper: wrapperObject({ pending: { ...pending, digest: Buffer.alloc(31, 7).toString('base64') } }), config: configObject() } })],
      ['an eta that is not a number', () => Response.json({ data: { wrapper: wrapperObject({ pending: { ...pending, eta_ms: 'soon' } }), config: configObject() } })],
      ['a registry with no contents', () => Response.json({ data: { wrapper: wrapperObject({ pending }), config: configObject({ json: { ...configObject().asMoveObject.contents.json, settlement_apps: null } }) } })],
      ['pending additions that are not a list', () => Response.json({ data: { wrapper: wrapperObject({ pending }), config: configObject({ json: { ...configObject().asMoveObject.contents.json, pending_additions: { truncated: true } } }) } })],
    ];
    for (const [label, reply] of replies) {
      chain.stateReply = reply;
      const { status, body } = await cron();
      assert.equal(status, 502, `${label}: must not answer success`);
      assert.equal(body.success, false, label);
      assert.equal((await alertRows(client)).length, 0, `${label}: nothing recorded from a read that could not be trusted`);
    }
    assert.equal(world.emails.length, 0);
  });
});

test('review A9: core\'s original id comes from the wrapper, so SPLASH_CORE_PACKAGE_ID set to a later version cannot silence a registry addition', async () => {
  await withRoute(async ({ client, chain, cron }) => {
    const proposed = Date.now() - 10 * 60_000;
    const eta = proposed + 86_400_000;
    chain.wrapper = wrapperObject({ original: CORE, latest: CORE_V2, capVersion: 2 });
    chain.config = configObject({ pending: [{ registry: 3, typeName: EVIL_ADAPTER, proposedAtMs: proposed, etaMs: eta }] });
    chain.events = [eventNode(T_ADDITION, 'TxEvilAdapter', 0, proposed, { config_id: CONFIG, registry: 3, type_name: EVIL_ADAPTER, proposed_at_ms: String(proposed), eta_ms: String(eta) })];
    const { status, body } = await cron();
    assert.equal(status, 200, body.error);
    const rows = await alertRows(client);
    assert.deepEqual(rows.map((r) => [r.kind, r.registry, r.type_name]), [['registry_addition_proposed', 3, EVIL_ADAPTER]]);
    assert.equal(new Date(rows[0].eta_at).getTime(), eta);
  }, { SPLASH_CORE_PACKAGE_ID: CORE_V2 });
});

test('review: a withdrawn proposal stops showing as a change that can take effect', async () => {
  await withRoute(async ({ chain, cron }) => {
    const { readGovernanceBannerForSession } = await import('../lib/server/governance-alerts-store.ts');
    const proposed = Date.now() - 10 * 60_000;
    const eta = proposed + 86_400_000;
    const upgradeEvent = eventNode(T_UPGRADE, 'TxUp', 0, proposed, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta), policy: 128 });
    const additionEvent = eventNode(T_ADDITION, 'TxApp', 0, proposed, { config_id: CONFIG, registry: 2, type_name: APP_TYPE, proposed_at_ms: String(proposed), eta_ms: String(eta) });
    chain.wrapper = wrapperObject({ version: 40, pending: { digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta) } });
    chain.config = configObject({ version: 900, pending: [{ registry: 2, typeName: APP_TYPE, proposedAtMs: proposed, etaMs: eta }] });
    chain.events = [upgradeEvent, additionEvent];
    assert.equal((await cron()).status, 200);
    assert.equal((await readGovernanceBannerForSession({ email: 'alice@acme.example' })).length, 2);

    // Governance cancels both. The objects no longer hold them; the feed
    // gains the cancellations.
    chain.wrapper = wrapperObject({ version: 41 });
    chain.config = configObject({ version: 901 });
    chain.events = [
      upgradeEvent,
      additionEvent,
      eventNode(T_UPGRADE_CANCELLED, 'TxUpCancel', 0, proposed + 60_000, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64 }),
      eventNode(T_ADDITION_CANCELLED, 'TxAppCancel', 0, proposed + 60_000, { config_id: CONFIG, registry: 2, type_name: APP_TYPE }),
    ];
    assert.equal((await cron()).status, 200);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }), [], 'nothing withdrawn is shown as able to take effect');
  });
});

test('review: every channel says what the chain shows, and nothing it cannot back', async () => {
  await withRoute(async ({ client, chain, world, cron }) => {
    const proposed = Date.now() - 10 * 60_000;
    const eta = proposed + 86_400_000;
    chain.wrapper = wrapperObject({
      pending: { digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta) },
      pendingOwner: { new_owner: NEW_GOVERNANCE, eta_ms: String(eta) },
    });
    chain.config = configObject({ pending: [{ registry: 2, typeName: APP_TYPE, proposedAtMs: proposed, etaMs: eta }] });
    chain.events = [
      eventNode(T_UPGRADE, 'TxUp', 0, proposed, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta), policy: 128 }),
      eventNode(T_OWNER, 'TxOwner', 0, proposed, { wrapper_id: WRAP, new_owner: NEW_GOVERNANCE, eta_ms: String(eta) }),
      eventNode(T_ADDITION, 'TxApp', 0, proposed, { config_id: CONFIG, registry: 2, type_name: APP_TYPE, proposed_at_ms: String(proposed), eta_ms: String(eta) }),
    ];
    assert.equal((await cron()).status, 200);
    const rows = await alertRows(client);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));

    // The upgrade: the bytecode digest, the policy and the eta, on every
    // channel, and where an owner can check them without trusting us.
    assert.match(by.upgrade_proposed.detail, new RegExp(DIGEST_HEX));
    assert.match(by.upgrade_proposed.detail, /additive/);
    const email = world.emails.find((m) => m.to === 'alice@acme.example' && m.text.includes(DIGEST_HEX));
    assert.ok(email, 'the upgrade email carries the bytecode digest');
    assert.match(email.text, new RegExp(formatUtc(eta)));
    assert.match(email.text, new RegExp(WRAP), 'the object an owner can look up on any explorer');
    const whatsapp = world.whatsapps.find((w) => w.body.includes('update to its payment contract'));
    assert.ok(whatsapp, 'the verified number is told about the upgrade');
    assert.match(whatsapp.body, new RegExp(DIGEST_HEX), 'WhatsApp carries the digest too');

    // A settlement app: what it can actually do once registered.
    assert.match(by.registry_addition_proposed.detail, /open payment requests in your account's name/);
    assert.match(by.registry_addition_proposed.detail, /only under an allowance you grant to this app/);
    assert.doesNotMatch(by.registry_addition_proposed.detail, /can pay from an allowance within your spending rules/);

    // The owner change: the chain proves no single KEY can sign, not that no
    // single person holds two keys.
    assert.match(by.owner_change_proposed.detail, /no single key can sign for it alone/);
    assert.doesNotMatch(by.owner_change_proposed.detail, /no single person/);
  });
});

test('review: a delivery left in sending by a run that died is claimed again once its lease has run out, and sent once', async () => {
  await withRoute(async ({ client, chain, world, cron }) => {
    const { readGovernanceBannerForSession } = await import('../lib/server/governance-alerts-store.ts');
    const proposed = Date.now() - 10 * 60_000;
    const eta = proposed + 86_400_000;
    chain.wrapper = wrapperObject({ pending: { digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta) } });
    chain.events = [eventNode(T_UPGRADE, 'TxUp', 0, proposed, { wrapper_id: WRAP, package: CORE, digest: DIGEST_B64, proposed_at_ms: String(proposed), eta_ms: String(eta), policy: 128 })];
    assert.equal((await cron()).status, 200);
    assert.equal(world.emails.length, 4);

    // A run claimed alice's email and her banner and died before finishing
    // either, an hour ago. Bob's email was claimed a moment ago by a run that
    // is still going.
    await client.exec(`
      UPDATE governance_alert_deliveries SET status = 'sending', sent_at = NULL, updated_at = now() - interval '1 hour'
        WHERE user_id = 'u_alice' AND channel IN ('email', 'in_app');
      UPDATE governance_alert_deliveries SET status = 'sending', sent_at = NULL, updated_at = now()
        WHERE user_id = 'u_bob' AND channel = 'email';
    `);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }), []);

    assert.equal((await cron()).status, 200);
    assert.deepEqual(world.emails.slice(4).map((m) => m.to), ['alice@acme.example'], 'alice\'s stale claim is retried; bob\'s live one is left to its run');
    const alice = (await client.query(`SELECT channel, status, attempts FROM governance_alert_deliveries WHERE user_id = 'u_alice' ORDER BY channel`)).rows;
    assert.deepEqual(alice.find((r) => r.channel === 'email'), { channel: 'email', status: 'sent', attempts: 2 });
    assert.equal(alice.find((r) => r.channel === 'in_app').status, 'sent');
    assert.equal((await readGovernanceBannerForSession({ email: 'alice@acme.example' })).length, 1, 'her banner is back');

    assert.equal((await cron()).status, 200);
    assert.equal(world.emails.length, 5, 'and only once: nothing is sent again');
  });
});
