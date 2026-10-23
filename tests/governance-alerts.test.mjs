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
