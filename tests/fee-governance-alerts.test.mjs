import assert from 'node:assert/strict';
import test from 'node:test';

import { attachDb, migratedDb } from './helpers/store-db.mjs';
import { LAUNCH_SCHEDULE, U64_MAX } from '../lib/fees/schedule.ts';
import { formatRate } from '../lib/fees/copy.ts';
import { deriveGovernanceAlerts, formatUtc, parseGovernanceState } from '../lib/server/governance-events.ts';

/* v2 Phase 2 carried item (A1 §6): owners are alerted to FeeScheduleProposed
   and FeeRecipientProposed. As for the upgrade wrapper and the compliance
   config, the monitor reads the canonical FeeConfig's STATE (its pending
   schedule slots and its pending recipient), never the event feed, and tells
   every owner of every business. It also tells them when a schedule or a
   recipient has taken effect, against the state it stored on its last run.
   Nothing here reaches a network; the database is PGlite. */

const UD = '0x' + 'd1'.repeat(32);
const WRAP = '0x' + 'a1'.repeat(32);
const CORE = '0x' + 'c0'.repeat(32);
const CONFIG = '0x' + 'cf'.repeat(32);
const FEE = '0x' + 'fe'.repeat(32);
const TABLE = '0x' + 'db'.repeat(32);
const FINANCE = '0x' + 'f1'.repeat(32);
const NEW_FINANCE = '0x' + 'f2'.repeat(32);
const ATTACKER = '0x' + '99'.repeat(32);
const GOVERNANCE = '0x' + '6a'.repeat(32);

const POLICY = { upgradeDelayPackageId: UD, wrapperId: WRAP, complianceConfigId: CONFIG, feeConfigId: FEE };
const ENV = {
  NODE_ENV: 'test',
  SPLASH_UPGRADE_DELAY_PACKAGE_ID: UD,
  SPLASH_UPGRADE_WRAPPER_ID: WRAP,
  SPLASH_COMPLIANCE_CONFIG_ID: CONFIG,
  SPLASH_FEE_CONFIG_ID: FEE,
};

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 9, 0);
const ETA = NOW + 23 * 60 * 60 * 1000;
const NO_HISTORY = { wrapper: null, config: null, feeConfig: null };

function wrapperObject() {
  return {
    address: WRAP,
    version: 40,
    owner: { __typename: 'AddressOwner', address: { address: GOVERNANCE } },
    asMoveObject: { contents: { type: { repr: `${UD}::upgrade_delay::DelayedUpgradeCap` }, json: {
      id: WRAP,
      cap: { id: '0x' + '5c'.repeat(32), package: CORE, version: '1', policy: 128 },
      original_package: CORE,
      pending: null,
      pending_owner: null,
    } } },
  };
}

function configObject() {
  return {
    address: CONFIG,
    version: 900,
    owner: { __typename: 'Shared' },
    asMoveObject: { contents: { type: { repr: `${CORE}::compliance_config::ComplianceConfig` }, json: {
      id: CONFIG,
      accepted_assets: { contents: [`${'a1'.repeat(32)}::usdc::USDC`] },
      settlement_apps: { contents: [] },
      bridge_adapters: { contents: [] },
      pending_additions: [],
    } } },
  };
}

const s = (n) => String(n);
const scheduleJson = (k) => ({ tiers: k.tiers.map((t) => ({ upper_minor: s(t.upperMinor), bps: s(t.bps) })), min_minor: s(k.minMinor), max_minor: s(k.maxMinor) });

/** A bank-payout schedule 1 bps dearer on every tier than the launch one. */
const DEARER_BANK = { ...LAUNCH_SCHEDULE[4], tiers: LAUNCH_SCHEDULE[4].tiers.map((t) => ({ upperMinor: t.upperMinor, bps: t.bps + 1n })) };

function feeObject(over = {}) {
  const pendingSchedules = [null, null, null, null, null];
  for (const [kind, p] of Object.entries(over.pendingSchedules ?? {})) pendingSchedules[Number(kind)] = { schedule: scheduleJson(p.schedule), eta_ms: s(p.eta) };
  return {
    address: over.address ?? FEE,
    version: over.version ?? 77,
    owner: over.owner ?? { __typename: 'Shared' },
    asMoveObject: { contents: { type: { repr: over.type ?? `${CORE}::fee_config::FeeConfig` }, json: over.json ?? {
      id: over.address ?? FEE,
      schedules: (over.schedules ?? LAUNCH_SCHEDULE).map(scheduleJson),
      fee_recipient: over.recipient === undefined ? FINANCE : over.recipient,
      discounts: { id: TABLE, size: '0' },
      pending_schedules: pendingSchedules,
      pending_recipient: over.pendingRecipient ? { recipient: over.pendingRecipient.recipient, eta_ms: s(over.pendingRecipient.eta) } : null,
    } } },
  };
}

const chainRead = (fee = {}) => ({ wrapper: wrapperObject(), config: configObject(), feeConfig: feeObject(fee) });

function stateOf(read) {
  const parsed = parseGovernanceState(read, POLICY);
  assert.equal(parsed.ok, true, parsed.reason);
  return parsed.state;
}

// ─── 1. The decision ─────────────────────────────────────────────────────────

test('a pending schedule in the canonical FeeConfig is one alert: the kind, what is proposed against what is in force, and the eta', () => {
  const state = stateOf(chainRead({ pendingSchedules: { 4: { schedule: DEARER_BANK, eta: ETA } } }));
  const { alerts, snapshots } = deriveGovernanceAlerts(state, NO_HISTORY, NOW);
  assert.equal(alerts.length, 1);
  const [a] = alerts;
  assert.equal(a.kind, 'fee_schedule_proposed');
  assert.equal(a.subjectId, FEE);
  assert.equal(a.feeKind, 4);
  assert.equal(a.etaMs, ETA);
  assert.match(a.key, new RegExp(`^fee_schedule_proposed\\|${FEE}\\|4\\|.+\\|${ETA}$`));
  assert.equal(a.summary, `Splash has announced a change to its fee for payments to a bank. It can take effect from ${formatUtc(ETA)}.`);
  // Every rate in the words comes from lib/fees, never written here.
  assert.match(a.detail, new RegExp(`Proposed: under 1,000 USDC ${formatRate(31n).replace('.', '\\.')}`));
  assert.match(a.detail, new RegExp(`In force now: under 1,000 USDC ${formatRate(30n).replace('.', '\\.')}`));
  assert.match(a.detail, /A payment never pays more than the Splash fee its approvers were shown: if the fee rises before it settles, the chain refuses it and it needs a new approval\./);
  assert.equal(a.activeUntilMs, ETA + 7 * DAY, 'shown until the chain would refuse it as lapsed');
  assert.deepEqual(snapshots.feeConfig.pendingKeys, [a.key]);
  assert.doesNotMatch(a.summary + a.detail, /[—–]/, 'plain punctuation');

  // The same state read again is the same alert.
  assert.equal(deriveGovernanceAlerts(state, NO_HISTORY, NOW + 15 * 60_000).alerts[0].key, a.key);
  // A different proposal for the same kind and eta is a different alert.
  const other = stateOf(chainRead({ pendingSchedules: { 4: { schedule: { ...DEARER_BANK, minMinor: 1n }, eta: ETA } } }));
  assert.notEqual(deriveGovernanceAlerts(other, NO_HISTORY, NOW).alerts[0].key, a.key);
});

test('a pending fee recipient is one alert naming the new account; the first one says the fees start', () => {
  const change = deriveGovernanceAlerts(stateOf(chainRead({ pendingRecipient: { recipient: NEW_FINANCE, eta: ETA } })), NO_HISTORY, NOW).alerts;
  assert.equal(change.length, 1);
  assert.equal(change[0].kind, 'fee_recipient_proposed');
  assert.equal(change[0].feeRecipient, NEW_FINANCE);
  assert.equal(change[0].key, `fee_recipient_proposed|${FEE}|${NEW_FINANCE}|${ETA}`);
  assert.equal(change[0].summary, `Splash has announced a change to the account its fees are paid to. It can take effect from ${formatUtc(ETA)}.`);
  assert.match(change[0].detail, new RegExp(`Fees would be paid to ${NEW_FINANCE} instead of ${FINANCE}\\.`));
  assert.match(change[0].detail, /a multisig account the contract checked when the change was proposed: no single key can sign for it alone\./);
  assert.match(change[0].detail, /No payment pays a fee to anyone but this account, and the fee itself does not change\./);

  const first = deriveGovernanceAlerts(stateOf(chainRead({ recipient: null, pendingRecipient: { recipient: FINANCE, eta: ETA } })), NO_HISTORY, NOW).alerts;
  assert.equal(first[0].summary, `Splash has announced that its fees start. They can start from ${formatUtc(ETA)}.`);
  assert.match(first[0].detail, /No Splash fee is charged yet\./);
  assert.match(first[0].detail, new RegExp(`Fees would be paid to ${FINANCE}, a multisig account`));
});

test('a schedule proposed while the fees are off says it applies once they start', () => {
  const [a] = deriveGovernanceAlerts(stateOf(chainRead({ recipient: null, pendingSchedules: { 1: { schedule: LAUNCH_SCHEDULE[1], eta: ETA } } })), NO_HISTORY, NOW).alerts;
  assert.equal(a.summary, `Splash has announced a change to its fee for payments to a Sui wallet. It can take effect from ${formatUtc(ETA)}.`);
  assert.match(a.detail, /No Splash fee is charged yet: this schedule would apply once fees start\./);
});

test('a lapsed proposal is not alerted; one past its eta but inside the window still is', () => {
  const lapsed = NOW - 7 * DAY - 1;
  const none = deriveGovernanceAlerts(stateOf(chainRead({ pendingSchedules: { 2: { schedule: LAUNCH_SCHEDULE[2], eta: lapsed } }, pendingRecipient: { recipient: NEW_FINANCE, eta: lapsed } })), NO_HISTORY, NOW);
  assert.deepEqual(none.alerts, []);
  assert.deepEqual(none.snapshots.feeConfig.pendingKeys, []);
  const due = deriveGovernanceAlerts(stateOf(chainRead({ pendingRecipient: { recipient: NEW_FINANCE, eta: NOW - 60_000 } })), NO_HISTORY, NOW);
  assert.deepEqual(due.alerts.map((a) => a.kind), ['fee_recipient_proposed']);
});

test('what took effect is told only against an older stored state: an applied schedule and an applied recipient; the first state is a baseline', () => {
  assert.deepEqual(deriveGovernanceAlerts(stateOf(chainRead({ schedules: [...LAUNCH_SCHEDULE.slice(0, 4), DEARER_BANK] })), NO_HISTORY, NOW).alerts, [], 'nothing says when the baseline happened');

  const before = deriveGovernanceAlerts(stateOf(chainRead({ version: 77 })), NO_HISTORY, NOW).snapshots;
  const after = stateOf(chainRead({ version: 80, schedules: [...LAUNCH_SCHEDULE.slice(0, 4), DEARER_BANK], recipient: NEW_FINANCE }));
  const { alerts } = deriveGovernanceAlerts(after, before, NOW);
  const by = Object.fromEntries(alerts.map((a) => [a.kind, a]));
  assert.deepEqual(Object.keys(by).sort(), ['fee_recipient_applied', 'fee_schedule_applied']);
  assert.equal(by.fee_schedule_applied.feeKind, 4);
  assert.match(by.fee_schedule_applied.key, new RegExp(`^fee_schedule_applied\\|${FEE}\\|4\\|.+\\|77$`));
  assert.equal(by.fee_schedule_applied.summary, 'Splash has changed its fee for payments to a bank. The new schedule has taken effect.');
  assert.match(by.fee_schedule_applied.detail, new RegExp(`^Now: under 1,000 USDC ${formatRate(31n).replace('.', '\\.')}`));
  assert.equal(by.fee_recipient_applied.key, `fee_recipient_applied|${FEE}|${NEW_FINANCE}|77`);
  assert.equal(by.fee_recipient_applied.summary, 'Splash has changed the account its fees are paid to. The change has taken effect.');
  assert.equal(by.fee_recipient_applied.activeUntilMs, NOW + 8 * DAY);

  // Fees turned on: the first recipient applied.
  const off = deriveGovernanceAlerts(stateOf(chainRead({ version: 70, recipient: null })), NO_HISTORY, NOW).snapshots;
  const on = deriveGovernanceAlerts(stateOf(chainRead({ version: 71 })), off, NOW).alerts;
  assert.equal(on[0].summary, "Splash's fees have started. They are paid to the account announced 24 hours or more ago.");

  // A lagging read can never make a change look new.
  const later = deriveGovernanceAlerts(after, before, NOW).snapshots;
  assert.deepEqual(deriveGovernanceAlerts(stateOf(chainRead({ version: 77 })), later, NOW).alerts, []);
});

test('only the canonical FeeConfig is read: missing, a look-alike type, not shared, another package, or any unreadable field is refused', () => {
  const refused = (read, names) => {
    const parsed = parseGovernanceState(read, POLICY);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.objectId, FEE);
    assert.match(parsed.reason, names);
  };
  refused({ ...chainRead(), feeConfig: null }, /SPLASH_FEE_CONFIG_ID .* names no object on chain/);
  refused({ ...chainRead(), feeConfig: feeObject({ type: `${ATTACKER}::fee_config::FeeConfig` }) }, /SPLASH_FEE_CONFIG_ID .* is a 0x9{2}.*::fee_config::FeeConfig, not a 0xc0c0/);
  refused({ ...chainRead(), feeConfig: feeObject({ owner: { __typename: 'AddressOwner', address: { address: ATTACKER } } }) }, /could not be read in full \(it is not shared\)/);
  refused({ ...chainRead(), feeConfig: feeObject({ address: '0x' + 'fd'.repeat(32) }) }, /could not be read in full/);
  const json = feeObject().asMoveObject.contents.json;
  for (const [label, bad] of [
    ['four pending slots', { ...json, pending_schedules: [null, null, null, null] }],
    ['a pending recipient with no eta', { ...json, pending_recipient: { recipient: NEW_FINANCE } }],
    ['a pending schedule above the ceiling', { ...json, pending_schedules: [null, null, null, null, { schedule: { tiers: [{ upper_minor: s(U64_MAX), bps: '101' }], min_minor: '0', max_minor: '0' }, eta_ms: s(ETA) }] }],
  ]) {
    const parsed = parseGovernanceState({ ...chainRead(), feeConfig: feeObject({ json: bad }) }, POLICY);
    assert.equal(parsed.ok, false, label);
    assert.match(parsed.reason, /the fee config .* could not be read in full/, label);
  }
});

// ─── 2. Configuration and the reader ─────────────────────────────────────────

test('SPLASH_FEE_CONFIG_ID is required: unconfigured or malformed, the monitor does not run', async () => {
  const { readGovernanceConfig } = await import('../lib/server/governance-alert-monitor.ts');
  const none = readGovernanceConfig({ ...ENV, SPLASH_FEE_CONFIG_ID: '' });
  assert.equal(none.ok, false);
  assert.match(none.reason, /SPLASH_FEE_CONFIG_ID is not configured/);
  const bad = readGovernanceConfig({ ...ENV, SPLASH_FEE_CONFIG_ID: '0x12' });
  assert.match(bad.reason, /SPLASH_FEE_CONFIG_ID is not a 0x \+ 64 hex id/);
  assert.deepEqual(readGovernanceConfig(ENV).policy, POLICY);
});

test('the GraphQL reader asks for all three objects in one query and refuses an answer without the fee config', async () => {
  const { graphqlGovernanceStateReader } = await import('../lib/server/governance-alert-monitor.ts');
  const asked = [];
  let reply = () => Response.json({ data: chainRead() });
  const read = graphqlGovernanceStateReader(async (url, init) => { asked.push(JSON.parse(init.body)); return reply(); }, 'https://graphql.invalid');
  const got = await read(POLICY);
  assert.equal(parseGovernanceState(got, POLICY).ok, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].variables, { wrapper: WRAP, config: CONFIG, feeConfig: FEE });
  assert.doesNotMatch(asked[0].query, /events\s*\(/, 'never the event feed');
  assert.match(asked[0].query, /feeConfig: object\(address: \$feeConfig\)/);
  reply = () => Response.json({ data: { wrapper: wrapperObject(), config: configObject() } });
  await assert.rejects(read(POLICY), /without the wrapper, the config and the fee config/);
});

// ─── 3. The listener: every owner, once per channel ──────────────────────────

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

async function seedOwners(client) {
  await client.exec(`
    INSERT INTO users (id, email, name, email_verified_at) VALUES
      ('u_alice', 'alice@acme.example', 'Alice Tan', now()),
      ('u_carol', 'carol@acme.example', 'Carol Ong', now()),
      ('u_dave', 'dave@northwind.example', 'Dave Ng', now());
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m_alice', 'u_alice', 'acme', 'admin'),
      ('m_carol', 'u_carol', 'acme', 'checker'),
      ('m_dave', 'u_dave', 'northwind', 'admin');
    INSERT INTO approver_channels (id, org_id, user_id, whatsapp_e164, verified_at) VALUES
      ('ac_alice', 'acme', 'u_alice', '+60102651678', now());
  `);
}

function deps(db, read, sink, extra = {}) {
  return {
    env: ENV,
    db,
    now: NOW,
    appUrl: 'https://v1.splashz.xyz',
    readState: async () => read(),
    sendEmail: async (m) => { sink.emails.push(m); return { providerRef: `em_${sink.emails.length}` }; },
    sendWhatsApp: async (to, body) => { sink.whatsapps.push({ to, body }); return { sent: true, providerRef: `wa_${sink.whatsapps.length}` }; },
    alert: async (a) => { sink.pages.push(a); },
    ...extra,
  };
}

test('a fee proposal reaches every owner of every business once, on every channel, and is stored with its kind and recipient', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const { readGovernanceBannerForSession } = await import('../lib/server/governance-alerts-store.ts');
    const sink = { emails: [], whatsapps: [], pages: [] };
    let read = chainRead({ pendingSchedules: { 4: { schedule: DEARER_BANK, eta: ETA } }, pendingRecipient: { recipient: NEW_FINANCE, eta: ETA } });
    const first = await runGovernanceAlertMonitor(deps(db, () => read, sink));
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.recorded.length, 2);
    assert.equal(first.observed.feeConfig.pendingSchedules, 1);
    assert.equal(first.observed.feeConfig.pendingRecipient, true);

    const rows = (await client.query(`SELECT kind, subject_id, fee_kind, fee_recipient, review_path FROM governance_alerts ORDER BY kind`)).rows;
    assert.deepEqual(rows.map((r) => [r.kind, r.subject_id, r.fee_kind, r.fee_recipient]), [
      ['fee_recipient_proposed', FEE, null, NEW_FINANCE],
      ['fee_schedule_proposed', FEE, 4, null],
    ]);
    assert.ok(rows.every((r) => r.review_path === '/dashboard/settings'), 'the fees are reviewed under Settings, not the spending rules');

    assert.deepEqual(sink.emails.map((m) => m.to).sort(), ['alice@acme.example', 'alice@acme.example', 'dave@northwind.example', 'dave@northwind.example']);
    const scheduleMail = sink.emails.find((m) => m.subject === 'A change to the Splash fee schedule has been announced');
    assert.ok(scheduleMail);
    assert.match(scheduleMail.text, new RegExp(`any Sui explorer: object ${FEE} holds the proposed schedule in its pending schedules, with when it can take effect`));
    assert.ok(sink.emails.some((m) => m.subject === 'A change to the account Splash fees are paid to has been announced'));
    assert.equal(sink.whatsapps.length, 2, 'only alice has a verified number');
    assert.equal(sink.emails.some((m) => m.to === 'carol@acme.example'), false, 'a checker is not an owner');
    assert.equal((await readGovernanceBannerForSession({ email: 'dave@northwind.example' }, NOW)).length, 2);

    // Re-run: nothing recorded or sent twice.
    const again = await runGovernanceAlertMonitor(deps(db, () => read, sink, { now: NOW + 15 * 60_000 }));
    assert.deepEqual(again.recorded, []);
    assert.equal(sink.emails.length, 4);

    // Withdrawn on chain: no longer shown.
    read = chainRead({ version: 78 });
    const withdrawn = await runGovernanceAlertMonitor(deps(db, () => read, sink, { now: NOW + 30 * 60_000 }));
    assert.deepEqual(withdrawn.active, []);
    assert.deepEqual(await readGovernanceBannerForSession({ email: 'alice@acme.example' }, NOW + 30 * 60_000), []);
    const stored = (await client.query(`SELECT subject_kind, object_version FROM governance_watch_state WHERE subject_id = $1`, [FEE])).rows[0];
    assert.deepEqual([stored.subject_kind, Number(stored.object_version)], ['fee_config', 78]);
    assert.deepEqual(sink.pages, []);
  });
});

test('a FeeConfig that does not check out records nothing and pages a person', async () => {
  await withDb(async ({ client, db }) => {
    await seedOwners(client);
    const { runGovernanceAlertMonitor } = await import('../lib/server/governance-alert-monitor.ts');
    const sink = { emails: [], whatsapps: [], pages: [] };
    const read = () => ({ ...chainRead(), feeConfig: feeObject({ type: `${ATTACKER}::fee_config::FeeConfig`, pendingRecipient: { recipient: ATTACKER, eta: ETA } }) });
    const result = await runGovernanceAlertMonitor(deps(db, read, sink));
    assert.equal(result.ok, false);
    assert.match(result.reason, /SPLASH_FEE_CONFIG_ID/);
    assert.deepEqual(sink.pages.map((p) => [p.kind, p.objectId]), [['governance_config_mismatch', FEE]]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM governance_alerts`)).rows[0].n, 0);
    assert.equal(sink.emails.length, 0);
  });
});
