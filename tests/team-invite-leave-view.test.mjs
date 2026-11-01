/**
 * What the page offers and says about invitations and leaving (v2 Phase 3):
 * pure, client-safe, and held to the same rule the server uses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADD_CHOICES,
  INVITATION_DAYS,
  LAST_OWNER_SENTENCE,
  LEAVE_WHY_NOT,
  ON_A_BUSINESS,
  TEAM_ACTIONS,
  activitySummary,
  financeLeadWords,
  leaveDecisionRefusal,
  leaveSentence,
  maskEmail,
} from '../lib/team/view.ts';

const row = (over = {}) => ({ userId: 'u-x', role: 'maker', inCharge: false, addFunds: false, withdraw: false, ...over });

test('a masked address keeps the first letter and the domain, never the rest', () => {
  assert.equal(maskEmail('free@example.test'), 'f***@example.test');
  assert.equal(maskEmail('a@b.test'), 'a*@b.test');
  assert.equal(maskEmail('very.long.address.here@example.test'), 'v******@example.test');
  assert.equal(maskEmail('nope'), '***');
  assert.doesNotMatch(maskEmail('secret.name@example.test'), /secret|name/);
});

test('who may decide a request to leave: one rule, for owners, the lead and everyone else', () => {
  const d = (manager, actorUserId, leaver) => leaveDecisionRefusal({ manager, actorUserId, leaver });
  assert.equal(d(null, 'u-a', row()), 'not_a_manager');
  assert.equal(d('owner', 'u-x', row()), 'own_request', 'nobody decides their own');
  assert.equal(d('finance_lead', 'u-x', row()), 'own_request');
  assert.equal(d('owner', 'u-a', row({ role: 'admin' })), null, 'an owner’s leaving is for ANOTHER owner');
  assert.equal(d('owner', 'u-a', row({ inCharge: true })), null);
  assert.equal(d('finance_lead', 'u-a', row({ role: 'viewer' })), null);
  assert.equal(d('finance_lead', 'u-a', row({ role: 'checker' })), null);
  assert.equal(d('finance_lead', 'u-a', row({ role: 'admin' })), 'owner_only');
  assert.equal(d('finance_lead', 'u-a', row({ inCharge: true })), 'granted_authority');
  assert.equal(d('finance_lead', 'u-a', row({ addFunds: true })), 'granted_authority');
  assert.equal(d('finance_lead', 'u-a', row({ withdraw: true })), 'granted_authority');
  for (const reason of ['not_a_manager', 'own_request', 'owner_only', 'granted_authority']) assert.ok(LEAVE_WHY_NOT[reason].length > 10);
});

test('the sentences a person reads about their own request say what is kept and what is next', () => {
  assert.match(leaveSentence('pending'), /keep your access/);
  assert.match(leaveSentence('pending'), /spending rule/);
  assert.match(leaveSentence('declined', 'Asha'), /^Asha declined your request to leave\./);
  assert.match(leaveSentence('declined', 'Asha'), /still on the team/);
  assert.match(leaveSentence('declined'), /^An owner declined/);
  assert.equal(leaveSentence('none'), null);
  assert.match(LAST_OWNER_SENTENCE, /only owner/);
  assert.match(ON_A_BUSINESS, /already belong to a business/);
});

test('the two ways to add someone are named in plain words, with the 7 days and the confirmation', () => {
  assert.equal(INVITATION_DAYS, 7);
  assert.equal(ADD_CHOICES.invite.title, 'Send an invitation');
  assert.equal(ADD_CHOICES.direct.title, 'Add directly');
  assert.match(ADD_CHOICES.invite.body, /accept or decline/);
  assert.match(ADD_CHOICES.invite.body, /7 days/);
  assert.match(ADD_CHOICES.invite.body, /withdraw/);
  assert.match(ADD_CHOICES.direct.body, /straight away/);
  assert.match(ADD_CHOICES.direct.confirm, /right person/);
});

test('every new trail action is a team action, reads as a sentence, and names no business or full address', () => {
  const lines = {
    team_invitation_sent: [{ role: 'maker', emailMask: 'f***@example.test' }, /Asha invited f\*\*\*@example\.test as staff\./],
    team_invitation_accepted: [{ role: 'checker' }, /Asha accepted the invitation and joined as an approver\./],
    team_invitation_declined: [{ role: 'viewer' }, /Asha declined the invitation to join as a viewer\./],
    team_invitation_withdrawn: [{ role: 'viewer', emailMask: 'f***@example.test' }, /Asha withdrew the invitation to f\*\*\*@example\.test\./],
    team_invitation_expired: [{ emailMask: 'f***@example.test' }, /ended after 7 days without an answer\./],
    leave_requested: [{}, /Asha asked to leave the team\./],
    leave_withdrawn: [{}, /Asha withdrew their request to leave\./],
    leave_approved: [{}, /Asha approved Ben’s request to leave\. Ben no longer has access\./],
    leave_declined: [{}, /Asha declined Ben’s request to leave\. Ben is still on the team\./],
  };
  for (const [action, [detail, pattern]] of Object.entries(lines)) {
    assert.ok(TEAM_ACTIONS.includes(action), action);
    const text = activitySummary({ action, detail, actorName: 'Asha', subjectName: 'Ben' });
    assert.match(text, pattern, action);
    assert.doesNotMatch(text, /changed the team/, action);
  }
  const closed = activitySummary({ action: 'team_invitation_withdrawn', detail: { reason: 'inviter_no_longer_manages', emailMask: 'f***@example.test' }, actorName: 'Splash', subjectName: null });
  assert.match(closed, /no longer manages the team/);
});

test('the Finance lead’s words include inviting and leave requests, and the limits on both', () => {
  const words = financeLeadWords();
  assert.ok(words.can.some((t) => /invitation/.test(t) && /add them directly/.test(t)));
  assert.ok(words.can.some((t) => /request to leave/.test(t) && /not in charge/.test(t)));
  assert.ok(words.cannot.some((t) => /request to leave from an owner/.test(t) && /no one decides their own/.test(t)));
});

test('the new components say nothing the copy rules forbid, and use no em dash, coral or Demo wording', () => {
  for (const path of ['components/team/AddPersonForm.tsx', 'components/team/OpenInvitations.tsx', 'components/team/LeaveRequests.tsx', 'components/team/LeaveSection.tsx', 'components/team/InvitationBanner.tsx', 'lib/team/view.ts']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /—/, `${path}: no em dash`);
    assert.doesNotMatch(text, /E39774|coral|Coming soon|\bDemo\b|\bDEMO\b|testnet|non-custodial/i, path);
  }
});
