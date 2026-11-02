/**
 * An automatic run handed back to “ask me first” is a request nobody has approved yet (v2 Phase 3,
 * p3-no-approver). It follows the same ladder as any other waiting request, and when the owners do not
 * answer it lapses the same way: unpaid, in plain words, to the owners, with the scheduled payer having
 * signed nothing. The schedule world's model chain; no key is real and nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { LAPSE_WORDS } from '../lib/approve/wait.ts';
import { LAPSED_REASON } from '../lib/schedule/rules.ts';
import { sweepApprovalWaitsForStaff } from '../lib/server/approval-wait.ts';
import { runScheduledPayments } from '../lib/server/scheduled-runner.ts';
import * as S from '../lib/server/scheduled-payments.ts';
import { listRuns, saveSettings } from '../lib/server/scheduled-store.ts';
import { DAY, OWNER_ACTOR, sched, scheduleWorld, t0 } from './fixtures/schedule-world.mjs';

const MIN = 60_000;
const HOUR = 3_600_000;
const FIRST = new Date(Number(t0) + 2 * Number(DAY));
const at = (ms) => new Date(ms);
const runner = (t) => ({ db: t.w.db, now: () => t.w.signing.now(), depsFor: async (orgId) => (orgId === 'acme' ? t.sdeps() : null), env: { NODE_ENV: 'test' } });
const mailbox = () => {
  const sent = [];
  return { sent, async sendMessage(message) { sent.push(message); return { providerRef: null }; } };
};

async function handedBack() {
  const t = await scheduleWorld();
  await t.allowance({});
  await t.payBefore(t.ids.a, 1);
  await t.payBefore(t.ids.b, 1);
  const made = await S.createSchedule(t.sdeps(), OWNER_ACTOR, sched(t.ids, { mode: 'auto', firstDueAt: FIRST.toISOString() }));
  assert.equal(made.ok, true, JSON.stringify(made));
  await saveSettings(t.w.db, 'acme', { graceMinutes: 0 }, new Date());
  // The owners pause automatic payments: the run cannot go automatically and is handed back.
  await S.pauseAutomatic(t.sdeps(), OWNER_ACTOR);
  await t.clock(FIRST);
  await runScheduledPayments(runner(t));
  const [run] = await listRuns(t.w.db, 'acme');
  assert.equal(run.status, 'waiting_approval');
  assert.equal(run.fallback, true);
  return { t, run };
}

test('an automatic run handed back is asked at 0, 10 minutes, 1 hour and 4 hours, then lapses unpaid with nobody’s money moved', async () => {
  const { t, run } = await handedBack();
  const db = t.w.db;
  const [batch] = await db.select().from(schema.walletBatches).where(eq(schema.walletBatches.orgId, 'acme'));
  const mail = mailbox();
  const sweep = (when) => sweepApprovalWaitsForStaff(db, { now: () => at(when), mail, appUrl: 'http://localhost:3000', env: { NODE_ENV: 'test' } });
  const steps = async () => (await db.select().from(schema.approvalWaitSteps).where(eq(schema.approvalWaitSteps.subjectId, batch.signingRequestId))).map((r) => r.step).sort();

  await sweep(FIRST.getTime());
  await sweep(FIRST.getTime());
  assert.deepEqual(await steps(), ['asked']);
  const asked = await db.select().from(schema.approvalNotices).where(eq(schema.approvalNotices.subjectId, batch.signingRequestId));
  assert.deepEqual(asked.map((n) => n.userId).sort(), ['u-three', 'u-two'], 'the owners who sign; the owner whose schedule it is already knows');
  await sweep(FIRST.getTime() + 10 * MIN);
  await sweep(FIRST.getTime() + HOUR);
  await sweep(FIRST.getTime() + 4 * HOUR);
  await sweep(FIRST.getTime() + 4 * HOUR);
  assert.deepEqual(await steps(), ['asked', 'reminder_10m', 'reminder_1h', 'reminder_4h']);
  const requester = (await db.select().from(schema.approvalNotices).where(eq(schema.approvalNotices.step, 'reminder_10m'))).find((n) => n.userId === 'u-founder');
  assert.equal(requester.audience, 'requester');
  assert.match(requester.body, /Nobody has answered/);

  // 24 hours later nobody has approved: the request ends and so does the run, in the same words.
  const end = FIRST.getTime() + 24 * HOUR + MIN;
  await t.clock(at(end));
  await runScheduledPayments(runner(t));
  await sweep(end);
  await sweep(end);
  const [ended] = await listRuns(t.w.db, 'acme');
  assert.equal(ended.status, 'lapsed');
  assert.equal(ended.reason, LAPSED_REASON);
  assert.ok(ended.reason.startsWith(LAPSE_WORDS), 'the run says what every lapse says');
  assert.match(ended.reason, /no late fee or penalty/i);
  assert.equal(t.spent(), 0, 'nothing was paid');
  assert.equal(t.signed.length, 0, 'the scheduled payer signed nothing');
  assert.deepEqual(await steps(), ['asked', 'lapsed', 'reminder_10m', 'reminder_1h', 'reminder_4h']);
  const lapse = await db.select().from(schema.approvalNotices).where(eq(schema.approvalNotices.step, 'lapsed'));
  assert.deepEqual(lapse.map((n) => n.userId).sort(), ['u-founder', 'u-three', 'u-two'], 'the owner whose schedule it is, and the owners');
  assert.equal(run.id, ended.id);
});
