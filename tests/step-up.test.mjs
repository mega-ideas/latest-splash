import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  approvalStyleOf,
  approveByClick,
  confirmStepUpPasskey,
  consumeStepUp,
  maskNumber,
  passkeyApprovalMessage,
  requestStepUp,
  STEP_UP_RESEND_COOLDOWN_MS,
  STEP_UP_TTL_MS,
  listPendingApprovals,
  stepUpStatus,
  subjectDigest,
  verifyStepUpCode,
} from '../lib/server/step-up.ts';

/**
 * Step-up approval in both styles, against real migrations. The WhatsApp
 * sender and the passkey check are doubles; everything else is the code that
 * runs in production.
 */

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
const SUBJECT = { kind: 'stablecoin-transfer', outflowId: 'sco_1', principalMinor: '1000000000' };

async function world() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const text = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement.trim());
    }
  }
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('org_a', 'A Co');
    INSERT INTO users (id, email, name) VALUES
      ('u_ceo', 'ceo@a.test', 'Aisha CEO'),
      ('u_admin2', 'admin2@a.test', 'Second Admin'),
      ('u_checker', 'checker@a.test', 'Chen Checker'),
      ('u_maker', 'maker@a.test', 'Mo Maker');
    INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES
      ('m1', 'u_ceo', 'org_a', 'admin', '2026-01-01T00:00:00Z'),
      ('m2', 'u_admin2', 'org_a', 'admin', '2026-02-01T00:00:00Z'),
      ('m3', 'u_checker', 'org_a', 'checker', '2026-03-01T00:00:00Z'),
      ('m4', 'u_maker', 'org_a', 'maker', '2026-04-01T00:00:00Z');
    INSERT INTO approver_channels (id, org_id, user_id, whatsapp_e164, verified_at) VALUES
      ('c1', 'org_a', 'u_ceo', '+447700900001', now()),
      ('c2', 'org_a', 'u_admin2', '+447700900002', now()),
      ('c3', 'org_a', 'u_checker', '+447700900003', NULL);
    INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, sui_address, rp_id) VALUES
      ('pk_ceo', 'u_ceo', 'cred-ceo', 'AAAA', '0x01', 'localhost');
  `);
  const sent = [];
  let now = T0;
  let passkeyOk = true;
  const deps = {
    db,
    key: 'test-key',
    now: () => now,
    send: async (to, message) => { sent.push({ to, ...message }); return { sent: true }; },
    verifyPasskey: async ({ userId, message }) => {
      const text = new TextDecoder().decode(message);
      if (!passkeyOk) return { ok: false, reason: 'bad signature' };
      return userId === 'u_ceo' && text.startsWith('Splash approval') ? { ok: true, credentialId: 'pk_ceo' } : { ok: false, reason: 'no passkey' };
    },
  };
  return {
    client, db, deps, sent,
    advance: (ms) => { now += ms; },
    failPasskey: () => { passkeyOk = false; },
  };
}

const request = (deps, extra = {}) => requestStepUp(deps, {
  orgId: 'org_a', style: 'WHATSAPP_PASSKEY', requesterUserId: 'u_maker', requesterName: 'Mo Maker',
  purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: SUBJECT,
  label: '1,000.00 USDC to Maria', summary: 'Send 1,000.00 USDC to Maria.', ...extra,
});
const code = (deps, approvalId, typed, extra = {}) => verifyStepUpCode(deps, {
  orgId: 'org_a', userId: 'u_ceo', approvalId, code: typed, ...extra,
});
const passkey = (deps, approvalId, extra = {}) => confirmStepUpPasskey(deps, {
  orgId: 'org_a', userId: 'u_ceo', approvalId, signature: 'sig', ...extra,
});
const consume = (db, extra = {}) => consumeStepUp(db, { orgId: 'org_a', purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: SUBJECT, nowMs: T0, ...extra });

test('the style follows the WhatsApp switch in Settings', () => {
  assert.equal(approvalStyleOf({ whatsappEnabled: true }), 'WHATSAPP_PASSKEY');
  assert.equal(approvalStyleOf({ whatsappEnabled: false }), 'CLICK');
});

test('WhatsApp: the FIRST admin gets the code, and only a keyed hash of it is stored', async () => {
  const w = await world();
  const r = await request(w.deps);
  assert.equal(r.ok, true);
  assert.equal(r.approverName, 'Aisha CEO', 'the first admin, not the second');
  assert.equal(r.sentTo, maskNumber('+447700900001'));
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].to, '+447700900001');
  assert.match(w.sent[0].code, /^\d{6}$/);
  assert.match(w.sent[0].fallbackBody, /Send 1,000\.00 USDC to Maria/);

  const row = (await w.client.query('SELECT code_hash, method FROM step_up_codes')).rows[0];
  assert.equal(row.method, 'WHATSAPP_PASSKEY');
  assert.equal(row.code_hash.length, 64);
  assert.notEqual(row.code_hash, w.sent[0].code);
  await w.client.close();
});

test('WhatsApp: code, then passkey — both are required before the approval can be used', async () => {
  const w = await world();
  const { id } = await request(w.deps);
  const typed = w.sent[0].code;

  const pending = await listPendingApprovals(w.db, { orgId: 'org_a', userId: 'u_ceo', nowMs: T0 });
  assert.equal(pending.length, 1, 'it waits on the main admin');
  assert.equal(pending[0].summary, 'Send 1,000.00 USDC to Maria.');
  assert.equal(pending[0].requestedByName, 'Mo Maker');
  assert.equal(pending[0].stage, 'CODE');
  assert.equal((await listPendingApprovals(w.db, { orgId: 'org_a', userId: 'u_maker', nowMs: T0 })).length, 0);

  const wrong = await code(w.deps, id, typed === '000000' ? '000001' : '000000');
  assert.equal(wrong.code, 'wrong_code');
  assert.match(wrong.error, /4 attempts left/);

  const otherPerson = await code(w.deps, id, typed, { userId: 'u_admin2' });
  assert.equal(otherPerson.code, 'not_the_approver', 'a code works only in the session of the person it was sent to');
  assert.match(otherPerson.error, /Aisha CEO/);

  const step = await code(w.deps, id, typed);
  assert.equal(step.next, 'PASSKEY');
  assert.match(step.message, /^Splash approval\nPurpose: STABLECOIN_TRANSFER\nSubject: sco_1\nDigest: [0-9a-f]{64}\nApproval: stp_/);
  assert.equal(await consume(w.db), false, 'a code alone is not an approval');
  assert.equal((await stepUpStatus(w.db, { orgId: 'org_a', purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: SUBJECT, nowMs: T0 })).state, 'AWAITING_PASSKEY');

  assert.equal((await passkey(w.deps, id)).ok, true);
  assert.equal(await consume(w.db), true);
  assert.equal(await consume(w.db), false, 'used once');
  await w.client.close();
});

test('WhatsApp: a failed passkey leaves the approval ungiven', async () => {
  const w = await world();
  const { id } = await request(w.deps);
  await code(w.deps, id, w.sent[0].code);
  w.failPasskey();
  const r = await passkey(w.deps, id);
  assert.equal(r.code, 'passkey_rejected');
  assert.equal(await consume(w.db), false);
  await w.client.close();
});

test('an approval does not transfer to a changed subject', async () => {
  const w = await world();
  const { id } = await request(w.deps);
  const changed = { ...SUBJECT, principalMinor: '9000000000' };
  await code(w.deps, id, w.sent[0].code);
  await passkey(w.deps, id);
  const status = await stepUpStatus(w.db, { orgId: 'org_a', purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: changed, nowMs: T0 });
  assert.equal(status.state, 'CHANGED');
  assert.equal(await consume(w.db, { subject: changed }), false, 'approved 1,000 does not approve 9,000');
  assert.equal(await consume(w.db), true);
  await w.client.close();
});

test('five wrong codes lock it; a new request replaces the old code', async () => {
  const w = await world();
  const first = await request(w.deps);
  const right = w.sent[0].code;
  const wrongCode = right === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i += 1) await code(w.deps, first.id, wrongCode);
  assert.equal((await code(w.deps, first.id, right)).code, 'locked', 'the right code no longer helps');

  assert.equal((await request(w.deps)).code, 'cooldown');
  w.advance(STEP_UP_RESEND_COOLDOWN_MS + 1);
  const second = await request(w.deps);
  assert.equal(w.sent.length, 2);
  assert.equal((await code(w.deps, first.id, right)).code, 'no_code', 'the replaced request is gone');
  const fresh = await code(w.deps, second.id, w.sent[1].code);
  assert.equal(fresh.next, 'PASSKEY');
  await w.client.close();
});

test('codes and approvals expire', async () => {
  const w = await world();
  const { id } = await request(w.deps);
  w.advance(STEP_UP_TTL_MS + 1);
  assert.equal((await code(w.deps, id, w.sent[0].code)).code, 'expired');

  const v = await world();
  const second = await request(v.deps);
  await code(v.deps, second.id, v.sent[0].code);
  await passkey(v.deps, second.id);
  assert.equal(await consume(v.db, { nowMs: T0 + STEP_UP_TTL_MS + 1 }), false, 'an approval is not good forever');
  await w.client.close();
  await v.client.close();
});

test('the main admin must have a verified number; settings codes go to the editor’s own number first', async () => {
  const w = await world();
  await w.client.exec(`UPDATE approver_channels SET verified_at = NULL WHERE user_id = 'u_ceo'`);
  const r = await request(w.deps);
  assert.equal(r.code, 'admin_whatsapp_unverified');
  assert.match(r.error, /Aisha CEO is the main admin/);

  const settings = await request(w.deps, { purpose: 'SETTINGS_CHANGE', subjectId: 'settings:org_a:u_admin2', requesterUserId: 'u_admin2', requesterName: 'Second Admin' });
  assert.equal(settings.approverName, 'Second Admin', 'their own verified number');
  await w.client.exec(`UPDATE approver_channels SET verified_at = now() WHERE user_id = 'u_ceo'`);
  const makerEdit = await request(w.deps, { purpose: 'PROFILE_CHANGE', subjectId: 'profile:u_maker', requesterUserId: 'u_maker' });
  assert.equal(makerEdit.approverName, 'Aisha CEO', 'a maker has no number, so the main admin approves');
  await w.client.close();
});

test('CLICK: approvers only; maker-checker refuses the person who asked; a solo business approves its own', async () => {
  const w = await world();
  const click = (extra) => approveByClick(w.deps, {
    orgId: 'org_a', style: 'CLICK', requesterUserId: 'u_ceo', requireSecondPerson: true,
    purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: SUBJECT, summary: 'Send 1,000.00 USDC to Maria.', ...extra,
  });
  assert.equal((await click({ userId: 'u_maker', dbRole: 'maker' })).code, 'not_an_approver');
  assert.equal((await click({ userId: 'u_ceo', dbRole: 'admin' })).code, 'maker_checker');
  assert.equal((await click({ userId: 'u_checker', dbRole: 'checker' })).ok, true, 'a second person approves');
  assert.equal(await consume(w.db), true);

  const solo = await world();
  const r = await approveByClick(solo.deps, {
    orgId: 'org_a', style: 'CLICK', userId: 'u_ceo', dbRole: 'admin', requesterUserId: 'u_ceo', requireSecondPerson: false,
    purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: SUBJECT, summary: 's',
  });
  assert.equal(r.ok, true, 'the CEO who runs everything approves their own');
  assert.equal(await consume(solo.db), true);
  await w.client.close();
  await solo.client.close();
});

test('the style is enforced both ways', async () => {
  const w = await world();
  assert.equal((await request(w.deps, { style: 'CLICK' })).code, 'click_style');
  const r = await approveByClick(w.deps, {
    orgId: 'org_a', style: 'WHATSAPP_PASSKEY', userId: 'u_ceo', dbRole: 'admin', requesterUserId: 'u_maker', requireSecondPerson: false,
    purpose: 'STABLECOIN_TRANSFER', subjectId: 'sco_1', subject: SUBJECT, summary: 's',
  });
  assert.equal(r.code, 'whatsapp_style', 'a click cannot stand in for WhatsApp + passkey');
  await w.client.close();
});

test('the table refuses a WhatsApp approval without its passkey, and a click with a code', async () => {
  const w = await world();
  const digest = subjectDigest(SUBJECT);
  await assert.rejects(() => w.client.exec(`
    INSERT INTO step_up_codes (id, org_id, method, approver_user_id, requested_by, purpose, subject_id, subject_digest, summary, code_hash, expires_at, code_verified_at, verified_at)
    VALUES ('x1', 'org_a', 'WHATSAPP_PASSKEY', 'u_ceo', 'u_maker', 'STABLECOIN_TRANSFER', 's', '${digest}', 's', '${'a'.repeat(64)}', now(), now(), now())`), /check/i);
  await assert.rejects(() => w.client.exec(`
    INSERT INTO step_up_codes (id, org_id, method, approver_user_id, requested_by, purpose, subject_id, subject_digest, summary, code_hash, expires_at)
    VALUES ('x2', 'org_a', 'CLICK', 'u_ceo', 'u_maker', 'STABLECOIN_TRANSFER', 's', '${digest}', 's', '${'a'.repeat(64)}', now())`), /check/i);
  assert.equal(passkeyApprovalMessage({ id: 'stp_1', purpose: 'P', subjectId: 'S', subjectDigest: 'D' }), 'Splash approval\nPurpose: P\nSubject: S\nDigest: D\nApproval: stp_1');
  await w.client.close();
});
