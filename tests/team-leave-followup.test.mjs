/**
 * What happens AFTER an owner approves a request to leave (v2 Phase 3 review,
 * Medium x2).
 *
 * The membership ends in the approving transaction. Two things on the chain do
 * not end with it, because only the wallet's owners can change them, on their
 * own devices:
 *
 *   - the person's spending rule (taken back through the spending-rules revoke
 *     path), and
 *   - their place among the business wallet's SIGNERS. Leaving the team does not
 *     remove a signer; for an owner who leaves, that is the step that matters
 *     most, and nothing used to say so.
 *
 * Every outcome is now a line of the append-only trail (`leave_follow_up`), so a
 * step that was skipped or failed is on record and not only in one response
 * note. The chain-touching parts are handed in (`deps`) so the order, the
 * record and the words are tested without a chain. The state itself is also
 * shown to the owners without this step: a rule that outlives its holder reads
 * as orphaned on the wallet page and in Settings, so a follow-up lost between
 * the commit and the call cannot hide it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { listAuthorityEvents } from '../lib/server/wallet-authority.ts';
import { listTeamActivity } from '../lib/server/team-admin.ts';
import { runLeaveFollowUp } from '../lib/server/team-leave-followup.ts';
import { TEAM_ACTIONS, activitySummary, leaveFollowUpNote } from '../lib/team/view.ts';

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const input = { orgId: 'acme', actorUserId: 'u-owner', requestId: 'lvr_1', leaverUserId: 'u-owner2', now: () => T0 };

async function seeded() {
  const { client, db } = await migratedDb();
  for (const [id, email, role] of [['u-owner', 'owner@acme.test', 'admin'], ['u-owner2', 'owner2@acme.test', 'admin']]) {
    await db.insert(schema.users).values({ id, email, name: id === 'u-owner2' ? 'Dana Owner' : id, emailVerifiedAt: VERIFIED });
    if (id === 'u-owner') await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: 'acme', role });
  }
  return { client, db };
}

const followUps = async (db) => (await listAuthorityEvents(db, 'acme')).filter((e) => e.action === 'leave_follow_up');

test('every outcome is on the trail: the rule request opened and the person still a signer', async () => {
  const { client, db } = await seeded();
  const out = await runLeaveFollowUp(db, { ...input, deps: { revokeRules: async () => 'opened', signerState: async () => 'still_signer' } });
  assert.deepEqual([out.rules, out.signer], ['opened', 'still_signer']);
  assert.match(out.note, /spending rule is being taken back/);
  assert.match(out.note, /still a signer/);
  assert.match(out.note, /owners sign/, 'says who changes the signers');
  const [line] = await followUps(db);
  assert.equal(line.actorUserId, 'u-owner');
  assert.equal(line.subjectUserId, 'u-owner2');
  assert.equal(line.ref, 'lvr_1');
  assert.deepEqual({ rules: line.detail.rules, signer: line.detail.signer }, { rules: 'opened', signer: 'still_signer' });
  await client.close();
});

test('a revoke that could not be opened, or a throw anywhere, is recorded as not opened and never loses the approval', async () => {
  const { client, db } = await seeded();
  const out = await runLeaveFollowUp(db, {
    ...input,
    deps: {
      revokeRules: async () => {
        throw new Error('chain down');
      },
      signerState: async () => {
        throw new Error('chain down');
      },
    },
  });
  assert.deepEqual([out.rules, out.signer], ['not_opened', 'unknown']);
  assert.match(out.note, /could not be taken back automatically/);
  assert.match(out.note, /Spending rules in Settings/);
  assert.match(out.note, /If they signed for the business wallet, they still do/);
  const [line] = await followUps(db);
  assert.deepEqual({ rules: line.detail.rules, signer: line.detail.signer }, { rules: 'not_opened', signer: 'unknown' });
  await client.close();
});

test('nothing to take back and not a signer says only that, and is still recorded', async () => {
  const { client, db } = await seeded();
  const out = await runLeaveFollowUp(db, { ...input, deps: { revokeRules: async () => 'none', signerState: async () => 'not_a_signer' } });
  assert.match(out.note, /no spending rule/);
  assert.doesNotMatch(out.note, /signer/);
  assert.equal((await followUps(db)).length, 1);
  await client.close();
});

test('a repeat of the follow-up for the same request writes no second line', async () => {
  const { client, db } = await seeded();
  const deps = { revokeRules: async () => 'opened', signerState: async () => 'not_a_signer' };
  await runLeaveFollowUp(db, { ...input, deps });
  await runLeaveFollowUp(db, { ...input, deps });
  assert.equal((await followUps(db)).length, 1);
  await client.close();
});

test('the activity feed says in plain words what was and was not taken back', async () => {
  const { client, db } = await seeded();
  await runLeaveFollowUp(db, { ...input, deps: { revokeRules: async () => 'not_opened', signerState: async () => 'still_signer' } });
  assert.ok(TEAM_ACTIONS.includes('leave_follow_up'));
  const feed = await listTeamActivity(db, 'acme');
  const line = feed.find((e) => e.action === 'leave_follow_up');
  assert.ok(line, 'the line is in the feed');
  assert.match(line.summary, /Dana Owner/);
  assert.match(line.summary, /Spending rules/);
  assert.match(line.summary, /signer/);
  assert.match(activitySummary({ action: 'leave_follow_up', detail: { rules: 'opened', signer: 'not_a_signer' }, actorName: 'A', subjectName: 'B' }), /being taken back/);
  await client.close();
});

test('the words: each combination reads plainly and mentions only what applies', () => {
  assert.match(leaveFollowUpNote({ rules: 'opened', signer: 'not_a_signer' }), /being taken back/);
  assert.doesNotMatch(leaveFollowUpNote({ rules: 'opened', signer: 'not_a_signer' }), /signer/);
  assert.match(leaveFollowUpNote({ rules: 'none', signer: 'still_signer' }), /nothing to take back/);
  assert.match(leaveFollowUpNote({ rules: 'none', signer: 'still_signer' }), /still a signer/);
  for (const text of [leaveFollowUpNote({ rules: 'not_opened', signer: 'unknown' }), leaveFollowUpNote({ rules: 'opened', signer: 'still_signer' })]) {
    assert.doesNotMatch(text, /—/);
    assert.doesNotMatch(text, /testnet|non-custodial|coming soon|\bdemo\b/i);
  }
});

test('the approve route is the owner’s alone, runs the follow-up, and no longer has a path that leaves the rule to someone else', () => {
  const route = readFileSync(new URL('../app/api/team/leave-requests/[requestId]/approve/route.ts', import.meta.url), 'utf8');
  assert.match(route, /runLeaveFollowUp/);
  assert.doesNotMatch(route, /by_owner/);
  const rules = readFileSync(new URL('../lib/server/team-leave-rules.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(rules, /by_owner/);
  assert.match(rules, /signerState/);
});

test('the approval dialog tells the owner the person stays a signer until the signers are changed', () => {
  const text = readFileSync(new URL('../components/team/LeaveRequests.tsx', import.meta.url), 'utf8');
  assert.match(text, /signer/i);
});
