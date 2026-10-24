import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Plain Node cannot resolve the extensionless `next/server`; point it at the
// file, as tests/launch-scope-routes.test.mjs does, so the real route loads.
registerHooks({
  resolve: (specifier, context, nextResolve) => nextResolve(specifier === 'next/server' ? 'next/server.js' : specifier, context),
});

import { attachDb, migratedDb } from './helpers/store-db.mjs';
import { REVIEW_PATH, deriveGovernanceAlerts, formatUtc, parseGovernanceState } from '../lib/server/governance-events.ts';

/* v2 brief 3.5, review checklist A.7: "check the listener, not just the event".

   The Move side holds a pending upgrade in the DelayedUpgradeCap and pending
   registry additions in the ComplianceConfig, for at least 24 hours each;
   this file tests what the backend does with that state. `wrap` is public, so
   anyone can emit events of the canonical types from a wrapper of their own,
   which is why the monitor reads the two canonical objects and never an event
   feed. It must alert on what those objects hold and nothing else, refuse an
   object it cannot verify, record each alert once and tell every owner once
   per channel, however often it runs. Nothing here reaches a network: the
   chain, the email transport and WhatsApp are injected or faked, and the
   database is PGlite with every migration applied. The object fixtures
   (wrapperObject, configObject) are in section 4. */

const UD = '0x' + 'd1'.repeat(32);
const WRAP = '0x' + 'a1'.repeat(32);
const CORE = '0x' + 'c0'.repeat(32);
const CORE_V2 = '0x' + 'c2'.repeat(32);
const CONFIG = '0x' + 'cf'.repeat(32);
const ATTACKER = '0x' + '99'.repeat(32);

const POLICY = { upgradeDelayPackageId: UD, wrapperId: WRAP, complianceConfigId: CONFIG };
const ENV = {
  NODE_ENV: 'test',
  SPLASH_UPGRADE_DELAY_PACKAGE_ID: UD,
  SPLASH_UPGRADE_WRAPPER_ID: WRAP,
  SPLASH_COMPLIANCE_CONFIG_ID: CONFIG,
};

const NOW = Date.UTC(2026, 9, 24, 9, 0);
const PROPOSED = NOW - 60 * 60 * 1000;
const ETA = PROPOSED + 86_400_000;
const DAY = 86_400_000;
const NO_HISTORY = { wrapper: null, config: null };

const pendingUpgrade = (over = {}) => ({
  digest: over.digest ?? Buffer.alloc(32, 7).toString('base64'),
  proposed_at_ms: String(over.proposed ?? PROPOSED),
  eta_ms: String(over.eta ?? ETA),
});

/** A read of both objects; each side takes wrapperObject / configObject overrides. */
function chainRead({ wrapper = {}, config = {} } = {}) {
  return { wrapper: wrapperObject(wrapper), config: configObject(config) };
}

function stateOf(read) {
  const parsed = parseGovernanceState(read, POLICY);
  assert.equal(parsed.ok, true, parsed.reason);
  return parsed.state;
}

// ─── 1. The decision: canonical state in, alerts out ───────────────────────

test('a pending upgrade in the canonical wrapper is one alert: its bytecode digest, policy and eta, keyed by its content', () => {
  const read = chainRead({ wrapper: { pending: pendingUpgrade() } });
  const { alerts, snapshots } = deriveGovernanceAlerts(stateOf(read), NO_HISTORY, NOW);
  assert.equal(alerts.length, 1);
  const [alert] = alerts;
  assert.equal(alert.kind, 'upgrade_proposed');
  assert.equal(alert.subjectId, WRAP);
  assert.equal(alert.key, `upgrade_proposed|${WRAP}|${DIGEST_HEX}|${ETA}`);
  assert.equal(alert.bytecodeDigest, DIGEST_HEX);
  assert.equal(alert.upgradePolicy, 128);
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
  assert.match(alert.detail, new RegExp(`^The update's bytecode digest is ${DIGEST_HEX}\\. Upgrade policy: additive \\(128\\)\\. `));
  assert.match(alert.detail, /only if it adds to the contract: existing functions stay as they are/);
  assert.match(alert.detail, /cannot add a recipient, raise a spending limit or create an allowance/);
  assert.doesNotMatch(alert.summary + alert.detail, /[—–]/, 'plain punctuation: no dashes as separators');
  assert.doesNotMatch(alert.detail, /source|rebuil|verified/i, 'nothing about the code the chain does not show');
  assert.equal(alert.activeUntilMs, ETA + 7 * DAY, 'shown until the chain would refuse it as lapsed');
  assert.deepEqual(snapshots.wrapper.pendingKeys, [alert.key]);

  // The same state, read again or by a second instance, is the same alert.
  assert.equal(deriveGovernanceAlerts(stateOf(read), NO_HISTORY, NOW + 15 * 60_000).alerts[0].key, alert.key);
  // Nothing pending, nothing to say.
  assert.deepEqual(deriveGovernanceAlerts(stateOf(chainRead()), NO_HISTORY, NOW).alerts, []);
});

test('a pending owner change and pending registry additions alert, naming what the chain names', () => {
  const state = stateOf(chainRead({
    wrapper: { pendingOwner: { new_owner: NEW_GOVERNANCE, eta_ms: String(ETA) } },
    config: {
      pending: [
        { registry: 1, typeName: `${'ab'.repeat(32)}::usdt::USDT`, proposedAtMs: PROPOSED, etaMs: ETA },
        { registry: 2, typeName: APP_TYPE, proposedAtMs: PROPOSED, etaMs: ETA },
        { registry: 3, typeName: `${'ab'.repeat(32)}::cctp_adapter::CCTP`, proposedAtMs: PROPOSED, etaMs: ETA },
      ],
    },
  }));
  const { alerts, snapshots } = deriveGovernanceAlerts(state, NO_HISTORY, NOW);
  const by = Object.fromEntries(alerts.map((a) => [a.registry ?? a.kind, a]));
  assert.equal(alerts.length, 4);

  const owner = by.owner_change_proposed;
  assert.equal(owner.key, `owner_change_proposed|${WRAP}|${NEW_GOVERNANCE}|${ETA}`);
  assert.equal(owner.newOwner, NEW_GOVERNANCE);
  assert.match(owner.summary, /^Splash has announced a change to who can update its payment contract\. It can take effect from 25 October 2026, 08:00 UTC\./);
  assert.match(owner.detail, new RegExp(`would move from ${GOVERNANCE} to ${NEW_GOVERNANCE}, a multisig account: no single key can sign for it alone\\.`));

  assert.match(by[1].summary, /^Splash has announced a new payment asset \(usdt::USDT\)\. It can take effect from /);
  assert.match(by[2].summary, /^Splash has announced a new settlement app \(payroll_app::PAYROLL_APP\)\./);
  assert.equal(
    by[2].detail,
    "Once it takes effect, this app can open payment requests in your account's name and settle them. " +
      `It can spend from your wallet only under an allowance you grant to this app. Full type: ${APP_TYPE}.`,
  );
  assert.match(by[3].summary, /^Splash has announced a new cross-chain bridge adapter \(cctp_adapter::CCTP\)\./);
  assert.equal(by[2].key, `registry_addition_proposed|${CONFIG}|2|${APP_TYPE}|${ETA}`);
  assert.equal(snapshots.config.pendingKeys.length, 3);
  for (const alert of alerts) assert.equal(alert.reviewPath, REVIEW_PATH);
});

test('a proposal past its window has lapsed on chain and is not alerted; one past its eta but inside the window still is', () => {
  const lapsedEta = NOW - 7 * DAY - 1;
  const lapsed = stateOf(chainRead({
    wrapper: { pending: pendingUpgrade({ proposed: lapsedEta - DAY, eta: lapsedEta }), pendingOwner: { new_owner: NEW_GOVERNANCE, eta_ms: String(lapsedEta) } },
    config: { pending: [{ registry: 2, typeName: APP_TYPE, proposedAtMs: lapsedEta - DAY, etaMs: lapsedEta }] },
  }));
  const none = deriveGovernanceAlerts(lapsed, NO_HISTORY, NOW);
  assert.deepEqual(none.alerts, [], 'the chain would refuse every one of them now');
  assert.deepEqual(none.snapshots.wrapper.pendingKeys, []);
  assert.deepEqual(none.snapshots.config.pendingKeys, []);

  const dueEta = NOW - 60_000;
  const due = stateOf(chainRead({ wrapper: { pending: pendingUpgrade({ proposed: dueEta - DAY, eta: dueEta }) } }));
  const [alert] = deriveGovernanceAlerts(due, NO_HISTORY, NOW).alerts;
  assert.equal(alert.kind, 'upgrade_proposed', 'its notice has run: it can be put into force now');
  assert.ok(alert.activeUntilMs > NOW);
});

test('what took effect is told only against an older stored state: a committed upgrade and an activated addition; the first state stored is a baseline', () => {
  // First run ever: core is already at version 2 and an app is registered.
  // Nothing says when those happened, so neither is announced.
  const already = stateOf(chainRead({ wrapper: { capVersion: 2, latest: CORE_V2 }, config: { apps: [APP_TYPE] } }));
  assert.deepEqual(deriveGovernanceAlerts(already, NO_HISTORY, NOW).alerts, []);

  const before = deriveGovernanceAlerts(stateOf(chainRead({ wrapper: { version: 40 }, config: { version: 900 } })), NO_HISTORY, NOW).snapshots;
  const after = stateOf(chainRead({ wrapper: { version: 41, capVersion: 2, latest: CORE_V2 }, config: { version: 901, apps: [APP_TYPE] } }));
  const { alerts, snapshots } = deriveGovernanceAlerts(after, before, NOW);
  const by = Object.fromEntries(alerts.map((a) => [a.kind, a]));
  assert.deepEqual(Object.keys(by).sort(), ['registry_addition_activated', 'upgrade_committed']);
  assert.equal(by.upgrade_committed.key, `upgrade_committed|${WRAP}|2|${CORE_V2}`);
  assert.equal(by.upgrade_committed.packageId, CORE_V2);
  assert.equal(by.upgrade_committed.packageVersion, 2);
  assert.match(by.upgrade_committed.summary, /^An update to Splash's payment contract has taken effect\./);
  assert.match(by.upgrade_committed.detail, new RegExp(`^The contract is now at version 2, package ${CORE_V2}\\. Upgrade policy: additive \\(128\\)\\.`));
  assert.equal(by.upgrade_committed.activeUntilMs, NOW + 8 * DAY);
  assert.equal(by.registry_addition_activated.key, `registry_addition_activated|${CONFIG}|2|${APP_TYPE}|900`);
  assert.match(by.registry_addition_activated.summary, /^Splash has added a new settlement app \(payroll_app::PAYROLL_APP\)\. It has now taken effect\./);
  assert.match(by.registry_addition_activated.detail, /^This app can now open payment requests in your account's name/);

  // A lagging read (older object versions than what is stored) can never
  // make an entry look new, or an upgrade look committed.
  assert.deepEqual(deriveGovernanceAlerts(stateOf(chainRead({ wrapper: { version: 40 }, config: { version: 900 } })), snapshots, NOW).alerts, []);

  // Removed, then added again later: a new alert, under a new key.
  const removed = deriveGovernanceAlerts(stateOf(chainRead({ wrapper: { version: 41, capVersion: 2, latest: CORE_V2 }, config: { version: 905 } })), snapshots, NOW).snapshots;
  const readded = deriveGovernanceAlerts(stateOf(chainRead({ wrapper: { version: 41, capVersion: 2, latest: CORE_V2 }, config: { version: 990, apps: [APP_TYPE] } })), removed, NOW);
  assert.deepEqual(readded.alerts.map((a) => a.key), [`registry_addition_activated|${CONFIG}|2|${APP_TYPE}|905`]);
});

test('only the canonical objects are read: a missing object, a look-alike type, or a config not of core\'s original package is refused, naming the setting', () => {
  const refused = (read, objectId, names) => {
    const parsed = parseGovernanceState(read, POLICY);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.objectId, objectId);
    assert.match(parsed.reason, names);
    return parsed.reason;
  };
  refused({ wrapper: null, config: configObject() }, WRAP, /SPLASH_UPGRADE_WRAPPER_ID .* names no object on chain/);
  refused(chainRead({ wrapper: { type: `${ATTACKER}::upgrade_delay::DelayedUpgradeCap` } }), WRAP, /SPLASH_UPGRADE_WRAPPER_ID .* is a 0x9{2}.*::upgrade_delay::DelayedUpgradeCap, not a 0xd1d1/);
  refused(chainRead({ wrapper: { type: `${UD}::upgrade_delay::DelayedUpgradeCap<u8>` } }), WRAP, /SPLASH_UPGRADE_WRAPPER_ID/);
  refused(chainRead({ wrapper: { address: STRANGER_WRAP } }), WRAP, /not the one asked for/);
  refused({ wrapper: { ...wrapperObject(), owner: { __typename: 'Shared' } }, config: configObject() }, WRAP, /not owned by an address/);
  refused({ wrapper: wrapperObject(), config: null }, CONFIG, /SPLASH_COMPLIANCE_CONFIG_ID .* names no object on chain/);
  refused(chainRead({ config: { type: `${ATTACKER}::compliance_config::ComplianceConfig` } }), CONFIG, /SPLASH_COMPLIANCE_CONFIG_ID/);
  // Core's original id is the wrapper's record, not whichever version the
  // app calls: a config typed under the latest id is not core's.
  refused(chainRead({ wrapper: { original: CORE, latest: CORE_V2, capVersion: 2 }, config: { type: `${CORE_V2}::compliance_config::ComplianceConfig` } }), CONFIG, /its original_package/);
  assert.equal(stateOf(chainRead({ wrapper: { original: CORE, latest: CORE_V2, capVersion: 2 } })).wrapper.originalPackage, CORE);
});

test('ids compare in canonical form: upper-case or unpadded still match, and only exactly', () => {
  const upper = (id) => id.toUpperCase().replace('0X', '0x');
  const state = stateOf(chainRead({ wrapper: { type: `${upper(UD)}::upgrade_delay::DelayedUpgradeCap`, original: upper(CORE) } }));
  assert.equal(state.wrapper.originalPackage, CORE);
  const short = parseGovernanceState(chainRead({ wrapper: { type: '0x2::upgrade_delay::DelayedUpgradeCap' } }), POLICY);
  assert.equal(short.ok, false);
});

test('every field the alerts depend on must parse, or the whole read is refused', () => {
  const wrapperJson = wrapperObject({ pending: pendingUpgrade() }).asMoveObject.contents.json;
  const configJson = configObject().asMoveObject.contents.json;
  const cases = [
    ['no pending_owner field', { wrapper: { json: { ...wrapperJson, pending_owner: undefined } } }],
    ['a 31-byte digest', { wrapper: { pending: { ...pendingUpgrade(), digest: Buffer.alloc(31, 7).toString('base64') } } }],
    ['an eta that is not a time', { wrapper: { pending: { ...pendingUpgrade(), eta_ms: '1e12' } } }],
    ['a new owner that is not an address', { wrapper: { pendingOwner: { new_owner: 'governance', eta_ms: String(ETA) } } }],
    ['no cap version', { wrapper: { json: { ...wrapperJson, cap: { ...wrapperJson.cap, version: undefined } } } }],
    ['an original_package that is not an id', { wrapper: { json: { ...wrapperJson, original_package: 'core' } } }],
    ['no settlement_apps', { config: { json: { ...configJson, settlement_apps: undefined } } }],
    ['an addition to registry 4', { config: { pending: [{ registry: 4, typeName: APP_TYPE, proposedAtMs: PROPOSED, etaMs: ETA }] } }],
    ['an addition with no type', { config: { pending: [{ registry: 2, typeName: ' ', proposedAtMs: PROPOSED, etaMs: ETA }] } }],
    ['a config id that is not the configured one', { config: { json: { ...configJson, id: '0x' + 'ce'.repeat(32) } } }],
  ];
  for (const [label, over] of cases) {
    const parsed = parseGovernanceState(chainRead(over), POLICY);
    assert.equal(parsed.ok, false, label);
    assert.match(parsed.reason, /could not be read in full/, label);
  }
  const noVersion = chainRead();
  delete noVersion.wrapper.version;
  assert.equal(parseGovernanceState(noVersion, POLICY).ok, false, 'no object version');
});

test('the objects parse exactly as Sui testnet GraphQL rendered them (24 October 2026)', () => {
  // Read with the monitor's own query from https://graphql.testnet.sui.io on
  // 24 October 2026: the v2 Phase 1 wrapper and config (experiments/v2-phase1).
  const ids = {
    upgradeDelayPackageId: '0xc8ea66e425577c26a4bde76185f3d68b869f23e65de7f8e4de2aa1db608cc0a0',
    wrapperId: '0x34ec5a523b809c442f91f916596bf79ca30c49f6ce239989928737e7b12ceecb',
    complianceConfigId: '0x271897e5ab3ab8ba391f777860bd4aabb9ae403c581e36eeebebd41defd3327d',
  };
  const core = '0x993736cefd0df038b62126ddfceade1a45db5f45b93106ee220eec20437d9db2';
  const read = {
    wrapper: {
      address: ids.wrapperId,
      version: 4,
      owner: { __typename: 'AddressOwner', address: { address: '0xafea5352bb6313c6af89594eac518d24049e5bc6dfd4bbc18a14bf191f82b6b5' } },
      asMoveObject: { contents: { type: { repr: `${ids.upgradeDelayPackageId}::upgrade_delay::DelayedUpgradeCap` }, json: {
        id: ids.wrapperId,
        cap: { id: '0x43599013c394675788158e0af688403628471393785d454be90e212ecf423a67', package: core, version: '1', policy: 128 },
        original_package: core,
        pending: null,
        pending_owner: null,
      } } },
    },
    config: {
      address: ids.complianceConfigId,
      version: 1064231216,
      owner: { __typename: 'Shared' },
      asMoveObject: { contents: { type: { repr: `${core}::compliance_config::ComplianceConfig` }, json: {
        id: ids.complianceConfigId,
        max_deviation_ppm: '5000',
        max_staleness_ms: '60000',
        max_slippage_bps: '50',
        min_depth_base_units: '1000000',
        min_settlement_amount: '1000000',
        allowed_deepbook_pools: { contents: ['0x5b431dfe8ca757d1bb157833a137ce0fd3c66cefed1fd3cdab4b0e6c7501a587'] },
        paused: false,
        accepted_assets: { contents: ['a1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC'] },
        settlement_apps: { contents: [] },
        bridge_adapters: { contents: [] },
        pending_additions: [{ registry: 2, type_name: 'c69ab1af37da3c0b15b9f692e893aee5b4aeb56e2fafdb2291cde1ab6857025a::splash_spend::SettleWitness', proposed_at_ms: '1792790973810', eta_ms: '1792877373810' }],
        legacy_enabled: true,
      } } },
    },
  };
  const parsed = parseGovernanceState(read, ids);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.state.wrapper.originalPackage, core);
  assert.equal(parsed.state.config.objectVersion, 1064231216);
  const { alerts } = deriveGovernanceAlerts(parsed.state, NO_HISTORY, 1792877373810 - DAY + 60_000);
  assert.deepEqual(alerts.map((a) => [a.kind, a.typeName]), [['registry_addition_proposed', 'c69ab1af37da3c0b15b9f692e893aee5b4aeb56e2fafdb2291cde1ab6857025a::splash_spend::SettleWitness']]);
  assert.match(alerts[0].summary, /^Splash has announced a new settlement app \(splash_spend::SettleWitness\)\./);
});

// ─── 2. Configuration fails closed ─────────────────────────────────────────

test('unconfigured or malformed canonical ids fail closed, naming every key', async () => {
  const { readGovernanceConfig, runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
  const none = readGovernanceConfig({});
  assert.equal(none.ok, false);
  for (const key of ['SPLASH_UPGRADE_DELAY_PACKAGE_ID', 'SPLASH_UPGRADE_WRAPPER_ID', 'SPLASH_COMPLIANCE_CONFIG_ID']) {
    assert.match(none.reason, new RegExp(key));
  }
  assert.doesNotMatch(none.reason, /SPLASH_CORE_PACKAGE_ID/, "core's original id is read from the wrapper, not configured");
  const bad = readGovernanceConfig({ ...ENV, SPLASH_UPGRADE_WRAPPER_ID: '0x123', SPLASH_COMPLIANCE_CONFIG_ID: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /SPLASH_UPGRADE_WRAPPER_ID, SPLASH_COMPLIANCE_CONFIG_ID are not a 0x \+ 64 hex id/);
  const good = readGovernanceConfig({ ...ENV, SPLASH_UPGRADE_WRAPPER_ID: WRAP.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(good.policy, POLICY);

  // The monitor refuses before it reads anything.
  let read = false;
  const result = await runGovernanceAlertMonitor({ env: {}, readState: async () => { read = true; return chainRead(); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not configured/);
  assert.equal(read, false, 'no canonical ids, no reading: there would be nothing to check the objects against');
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

/** `read` may be changed between runs: the harness reads it each time. */
function harness(read, over = {}) {
  const emails = [];
  const whatsapps = [];
  const pages = [];
  const h = {
    read,
    emails,
    whatsapps,
    pages,
    deps: (db, extra = {}) => ({
      env: ENV,
      db,
      now: NOW,
      appUrl: 'https://v1.splashz.xyz',
      readState: async () => h.read,
      sendEmail: over.sendEmail ?? (async (message) => { emails.push(message); return { providerRef: `em_${emails.length}` }; }),
      sendWhatsApp: async (to, body) => { whatsapps.push({ to, body }); return { sent: true, providerRef: `wa_${whatsapps.length}` }; },
      alert: async (a) => { pages.push(a); },
      ...extra,
    }),
  };
  return h;
}

const deliveryRows = async (client) =>
  (await client.query(`SELECT user_id, channel, status, attempts, error FROM governance_alert_deliveries ORDER BY channel, user_id`)).rows;

const pendingRead = () => chainRead({ wrapper: { pending: pendingUpgrade() } });

test('a pending announcement is recorded once and reaches every owner of every org: in-app and email each, WhatsApp only if verified', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness(pendingRead());
    const result = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.recorded.length, 1);
    assert.equal(result.owners, 4, 'alice, bob, dave and erin; carol is a checker, not an owner');
    assert.equal(result.observed.wrapper.corePackage, CORE);
    assert.equal(result.observed.wrapper.pendingUpgrade, true);

    const alerts = (await client.query(`SELECT content_key, subject_id, kind, bytecode_digest, upgrade_policy, review_path, eta_at FROM governance_alerts`)).rows;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].content_key, `upgrade_proposed|${WRAP}|${DIGEST_HEX}|${ETA}`);
    assert.equal(alerts[0].subject_id, WRAP);
    assert.equal(alerts[0].bytecode_digest, DIGEST_HEX);
    assert.equal(alerts[0].upgrade_policy, 128);
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
    assert.match(email.text, new RegExp(`bytecode digest is ${DIGEST_HEX}`));
    assert.match(email.text, /https:\/\/v1\.splashz\.xyz\/dashboard\/settings\/spending-rules/);
    assert.equal(email.link, 'https://v1.splashz.xyz/dashboard/settings/spending-rules');
    assert.match(email.text, new RegExp(`any Sui explorer: object ${WRAP} holds the pending update`), 'checkable without trusting the message');
    assert.deepEqual(h.whatsapps.map((w) => w.to), ['+60102651678']);
    assert.match(h.whatsapps[0].body, new RegExp(DIGEST_HEX));
    assert.match(h.whatsapps[0].body, /Review your spending rules and allowances: https:\/\/v1\.splashz\.xyz\/dashboard\/settings\/spending-rules$/);
    assert.deepEqual(h.pages, [], 'the objects checked out: no page');
  });
});

test('re-running, even two instances racing on the first run, never records an alert twice or sends anything twice', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness(pendingRead());

    // Two instances at the same moment, both seeing nothing recorded yet.
    const [a, b] = await Promise.all([runGovernanceAlertMonitor(h.deps(db)), runGovernanceAlertMonitor(h.deps(db))]);
    assert.equal(a.ok && b.ok, true);
    assert.equal(a.recorded.length + b.recorded.length, 1, 'one of them recorded it');
    assert.equal(h.emails.length, 4, 'each owner emailed once between them');
    assert.equal(h.whatsapps.length, 1);
    const before = await deliveryRows(client);
    assert.equal(before.length, 9, 'four in-app, four email, one WhatsApp');

    const again = await runGovernanceAlertMonitor(h.deps(db, { now: NOW + 15 * 60_000 }));
    assert.equal(again.ok, true);
    assert.deepEqual(again.recorded, []);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM governance_alerts`)).rows[0].n, 1);
    assert.deepEqual(await deliveryRows(client), before, 'the same rows, untouched');
    assert.equal(h.emails.length + h.whatsapps.length, 5, 'nothing sent again');
    assert.deepEqual(again.deliveries.email, { sent: 0, failed: 0, skipped: 4 });
    assert.deepEqual(again.deliveries.in_app, { sent: 0, failed: 0, skipped: 4 });
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
    const h = harness(pendingRead(), { sendEmail: flaky });
    const first = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(first.ok, true);
    assert.deepEqual(first.deliveries.email, { sent: 3, failed: 1, skipped: 0 });
    assert.deepEqual(delivered.sort(), ['alice@acme.example', 'dave@northwind.example', 'erin@both.example']);
    const bob = (await deliveryRows(client)).find((r) => r.user_id === 'u_bob' && r.channel === 'email');
    assert.equal(bob.status, 'failed');
    assert.match(bob.error, /HTTP 503/);
    const bobInApp = (await deliveryRows(client)).find((r) => r.user_id === 'u_bob' && r.channel === 'in_app');
    assert.equal(bobInApp.status, 'sent', 'his banner does not depend on his email');

    for (let run = 2; run <= MAX_DELIVERY_ATTEMPTS + 2; run += 1) await runGovernanceAlertMonitor(h.deps(db, { now: NOW + run * 15 * 60_000 }));
    const retried = (await deliveryRows(client)).find((r) => r.user_id === 'u_bob' && r.channel === 'email');
    assert.equal(retried.attempts, MAX_DELIVERY_ATTEMPTS, 'retried, then left alone');
    assert.equal(retried.status, 'failed');
    assert.deepEqual(delivered.sort(), ['alice@acme.example', 'dave@northwind.example', 'erin@both.example'], 'no one else was sent anything twice');
  });
});

test('an owner added during the notice is told on the next run; nobody is told about a proposal once it has lapsed', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness(pendingRead());
    await runGovernanceAlertMonitor(h.deps(db));
    await client.exec(`
      INSERT INTO users (id, email, name, email_verified_at) VALUES ('u_fay', 'fay@northwind.example', 'Fay Goh', now());
      INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m_fay', 'u_fay', 'northwind', 'admin');
    `);
    const next = await runGovernanceAlertMonitor(h.deps(db, { now: NOW + 15 * 60_000 }));
    assert.deepEqual(next.deliveries.email, { sent: 1, failed: 0, skipped: 4 });
    assert.equal(h.emails.at(-1).to, 'fay@northwind.example');

    // Still pending on chain, but past its window: the chain would refuse it.
    await client.exec(`INSERT INTO users (id, email, name, email_verified_at) VALUES ('u_gus', 'gus@acme.example', 'Gus Tay', now());
      INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m_gus', 'u_gus', 'acme', 'admin');`);
    const late = await runGovernanceAlertMonitor(h.deps(db, { now: ETA + 7 * DAY + 1 }));
    assert.equal(late.ok, true);
    assert.deepEqual(late.alerts, []);
    assert.deepEqual(late.active, []);
    assert.equal(h.emails.some((m) => m.to === 'gus@acme.example'), false, 'nobody is emailed about a change that can no longer happen');
  });
});

test('a cancelled proposal is no longer fanned out or shown, and a lagging read cannot bring it back', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const { readGovernanceBannerForSession } = await import('../lib/server/governance-alerts-store.ts');
    const h = harness(chainRead({ wrapper: { version: 40, pending: pendingUpgrade() } }));
    await runGovernanceAlertMonitor(h.deps(db));
    assert.equal((await readGovernanceBannerForSession({ email: 'alice@acme.example' }, NOW)).length, 1);

    // Cancelled on chain (the wrapper's version moves on), then a new owner.
    h.read = chainRead({ wrapper: { version: 41 } });
    await client.exec(`INSERT INTO users (id, email, name, email_verified_at) VALUES ('u_fay', 'fay@northwind.example', 'Fay Goh', now());
      INSERT INTO memberships (id, user_id, org_id, role) VALUES ('m_fay', 'u_fay', 'northwind', 'admin');`);
    const after = await runGovernanceAlertMonitor(h.deps(db, { now: NOW + 15 * 60_000 }));
    assert.deepEqual(after.active, []);
    assert.equal(h.emails.some((m) => m.to === 'fay@northwind.example'), false, 'fay is not told about a withdrawn update');
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }, NOW + 15 * 60_000), []);

    // A lagging indexer still serves the old version, proposal and all. The
    // stored state is newer, so nothing changes.
    h.read = chainRead({ wrapper: { version: 40, pending: pendingUpgrade() } });
    const lagging = await runGovernanceAlertMonitor(h.deps(db, { now: NOW + 30 * 60_000 }));
    assert.deepEqual(lagging.active, []);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }, NOW + 30 * 60_000), []);
    const stored = (await client.query(`SELECT object_version FROM governance_watch_state WHERE subject_id = $1`, [WRAP])).rows[0];
    assert.equal(Number(stored.object_version), 41);
  });
});

test('what took effect reaches every owner once: an upgrade committed after its notice', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness(chainRead({ wrapper: { version: 40, pending: pendingUpgrade() } }));
    await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(h.emails.length, 4);

    // Authorised, run and committed in one transaction after the eta.
    h.read = chainRead({ wrapper: { version: 41, capVersion: 2, latest: CORE_V2 } });
    const done = await runGovernanceAlertMonitor(h.deps(db, { now: ETA + 60_000 }));
    assert.deepEqual(done.alerts.map((a) => a.kind), ['upgrade_committed']);
    assert.equal(done.active.length, 1, 'the announcement is no longer pending; what took effect is shown');
    const committed = h.emails.slice(4);
    assert.equal(committed.length, 4);
    assert.equal(committed[0].subject, 'An update to the Splash payment contract has taken effect');
    assert.match(committed[0].text, new RegExp(`now at version 2, package ${CORE_V2}`));
    assert.match(committed[0].text, new RegExp(`object ${WRAP} shows the contract's current version and package`));

    await runGovernanceAlertMonitor(h.deps(db, { now: ETA + 16 * 60_000 }));
    assert.equal(h.emails.length, 8, 'told once');
    const kinds = (await client.query(`SELECT kind FROM governance_alerts ORDER BY kind`)).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['upgrade_committed', 'upgrade_proposed']);
  });
});

test('the dashboard banner reads the signed-in owner\'s own in-app deliveries, and only while the alert is shown', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const { readGovernanceBannerForSession } = await import('../lib/server/governance-alerts-store.ts');
    await runGovernanceAlertMonitor(harness(pendingRead()).deps(db));

    const alice = await readGovernanceBannerForSession({ email: 'Alice@Acme.example' }, NOW);
    assert.equal(alice.length, 1);
    assert.equal(alice[0].kind, 'upgrade_proposed');
    assert.equal(alice[0].reviewPath, REVIEW_PATH);
    assert.match(alice[0].summary, /^Splash has announced an update to its payment contract\./);
    assert.match(alice[0].detail, new RegExp(DIGEST_HEX));
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'carol@acme.example' }, NOW), [], 'not an owner, no banner');
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'nobody@else.example' }, NOW), []);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }, ETA + 7 * DAY), [], 'gone once it has lapsed');
  });
});

test('a configured id that does not check out records nothing, tells no owner, and pages a person once per process', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const h = harness(chainRead({ wrapper: { type: `${UD}::upgrade_delay::CapWrapped`, pending: pendingUpgrade() } }));
    const first = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(first.ok, false);
    assert.match(first.reason, /SPLASH_UPGRADE_WRAPPER_ID .* is a 0xd1d1.*::upgrade_delay::CapWrapped/);
    const second = await runGovernanceAlertMonitor(h.deps(db));
    assert.equal(second.ok, false, 'every run refuses; the route answers 502 each time');
    assert.deepEqual(h.pages.map((p) => [p.kind, p.severity, p.objectId]), [['governance_config_mismatch', 'critical', WRAP]]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM governance_alerts`)).rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM governance_watch_state`)).rows[0].n, 0);
    assert.equal(h.emails.length, 0);

    let threw = 0;
    const down = await runGovernanceAlertMonitor(h.deps(db, { readState: async () => { threw += 1; throw new Error('the Sui indexer answered HTTP 503'); } }));
    assert.equal(down.ok, false);
    assert.match(down.reason, /could not read the governance objects: the Sui indexer answered HTTP 503/);
    assert.equal(threw, 1);
  });
});

test('a claim older than the lease is claimed again, by exactly one of two racing runs, and only its own finish counts', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const store = await import('../lib/server/governance-alerts-store.ts');
    const [alert] = deriveGovernanceAlerts(stateOf(pendingRead()), NO_HISTORY, NOW).alerts;
    const { alert: stored } = await store.recordGovernanceAlert(db, alert);
    const input = (nowMs) => ({ alertId: stored.id, userId: 'u_alice', orgId: 'acme', channel: 'email', nowMs });

    // A run claims at NOW and dies.
    const dead = await store.claimGovernanceDelivery(db, input(NOW));
    assert.deepEqual(dead.attempts, 1);
    assert.equal(await store.claimGovernanceDelivery(db, input(NOW + store.DELIVERY_LEASE_MS - 1)), null, 'inside the lease the claim is honoured');

    // After the lease, two runs race: one wins.
    const later = NOW + store.DELIVERY_LEASE_MS + 1;
    const [x, y] = await Promise.all([store.claimGovernanceDelivery(db, input(later)), store.claimGovernanceDelivery(db, input(later))]);
    assert.equal([x, y].filter(Boolean).length, 1);
    const winner = x ?? y;
    assert.equal(winner.attempts, 2);

    // The dead run wakes up and reports: ignored, the claim is not its own.
    await store.finishGovernanceDelivery(db, dead, { ok: false, error: 'late' }, later);
    const row = async () => (await client.query(`SELECT status, attempts, error FROM governance_alert_deliveries WHERE user_id = 'u_alice' AND channel = 'email'`)).rows[0];
    assert.deepEqual(await row(), { status: 'sending', attempts: 2, error: null });
    await store.finishGovernanceDelivery(db, winner, { ok: true, providerRef: 'em_1' }, later);
    assert.deepEqual(await row(), { status: 'sent', attempts: 2, error: null });
    assert.equal(await store.claimGovernanceDelivery(db, input(later + 30 * DAY)), null, 'a sent delivery is never claimed again');
  });
});

test('the GraphQL reader asks for the two configured objects in one query, and refuses anything but a complete answer', async () => {
  const { graphqlGovernanceStateReader } = await import('../lib/server/governance-alert-monitor.ts');
  const asked = [];
  const reply = { current: () => Response.json({ data: { wrapper: wrapperObject(), config: configObject() } }) };
  const fetcher = async (url, init) => {
    asked.push({ url, ...JSON.parse(init.body) });
    return reply.current();
  };
  const read = graphqlGovernanceStateReader(fetcher, 'https://graphql.invalid');
  const got = await read(POLICY);
  assert.equal(parseGovernanceState(got, POLICY).ok, true);
  assert.equal(asked.length, 1, 'one query for both objects');
  assert.match(asked[0].query, /query GovernanceState/);
  assert.doesNotMatch(asked[0].query, /events\s*\(/, 'never the event feed');
  assert.deepEqual(asked[0].variables, { wrapper: WRAP, config: CONFIG });

  reply.current = () => Response.json({ data: { wrapper: null, config: configObject() } });
  assert.equal((await read(POLICY)).wrapper, null, 'no such object is an answer, which the parser refuses');

  for (const [label, current, message] of [
    ['HTTP 500', () => new Response('no', { status: 500 }), /HTTP 500/],
    ['a GraphQL error', () => Response.json({ errors: [{ message: 'timeout' }] }), /refused the query: timeout/],
    ['no config field', () => Response.json({ data: { wrapper: wrapperObject() } }), /without the wrapper and the config/],
  ]) {
    reply.current = current;
    await assert.rejects(read(POLICY), message, label);
  }
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
