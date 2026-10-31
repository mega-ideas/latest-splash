/**
 * What Settings → Team shows each person, and what the Wallet page, Transfer
 * and Home show a member about Add funds and Withdraw (v2 Phase 3). Pure: the
 * server decides (tests/team-roles.test.mjs); these only decide what to
 * OFFER, and they offer nothing the server would refuse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  FINANCE_LEAD_NAME,
  activitySummary,
  financeLeadWords,
  roleChoicesFor,
  rowControls,
  walletActions,
} from '../lib/team/view.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const row = (over = {}) => ({ userId: 'u-x', name: 'Mei', email: 'mei@acme.test', role: 'maker', financeLead: false, inCharge: false, addFunds: false, withdraw: false, ...over });

test('the role is named in plain words: Finance lead', () => {
  assert.equal(FINANCE_LEAD_NAME, 'Finance lead');
});

test('an owner can give any of the four roles; the Finance lead the three below owner; nobody else any', () => {
  assert.deepEqual(roleChoicesFor('owner'), ['viewer', 'maker', 'checker', 'admin']);
  assert.deepEqual(roleChoicesFor('finance_lead'), ['viewer', 'maker', 'checker']);
  assert.deepEqual(roleChoicesFor(null), []);
});

test('an owner sees every control on everyone but themselves', () => {
  const you = 'u-me';
  const staff = rowControls({ manager: 'owner', youUserId: you }, row({ role: 'maker' }));
  assert.deepEqual([staff.roles.length > 0, staff.remove, staff.access, staff.financeLead], [true, true, true, null]);
  const approver = rowControls({ manager: 'owner', youUserId: you }, row({ role: 'checker' }));
  assert.equal(approver.financeLead, 'appoint');
  assert.equal(rowControls({ manager: 'owner', youUserId: you }, row({ role: 'checker', financeLead: true })).financeLead, 'take_back');
  const owner = rowControls({ manager: 'owner', youUserId: you }, row({ role: 'admin' }));
  assert.deepEqual([owner.roles.length > 0, owner.remove, owner.access], [true, true, false], 'an owner has Add funds and Withdraw already');
  const viewer = rowControls({ manager: 'owner', youUserId: you }, row({ role: 'viewer' }));
  assert.deepEqual([viewer.access, viewer.financeLead], [false, null]);
  const self = rowControls({ manager: 'owner', youUserId: 'u-x' }, row({ role: 'admin' }));
  assert.deepEqual([self.roles, self.remove, self.access, self.financeLead], [[], false, false, null], 'nobody changes or removes themselves');
});

test('the Finance lead sees controls on viewers, staff and approvers only: never an owner, themselves, the Finance lead role or access', () => {
  const ctx = { manager: 'finance_lead', youUserId: 'u-me' };
  for (const role of ['viewer', 'maker', 'checker']) {
    const c = rowControls(ctx, row({ role }));
    assert.deepEqual([c.roles, c.remove, c.access, c.financeLead], [['viewer', 'maker', 'checker'], true, false, null], role);
  }
  const owner = rowControls(ctx, row({ role: 'admin' }));
  assert.deepEqual([owner.roles, owner.remove, owner.access, owner.financeLead], [[], false, false, null]);
  const self = rowControls({ ...ctx, youUserId: 'u-x' }, row({ role: 'checker', financeLead: true }));
  assert.deepEqual([self.roles, self.remove, self.access, self.financeLead], [[], false, false, null]);
});

test('a member who manages nothing is offered nothing', () => {
  for (const role of ['viewer', 'maker', 'checker', 'admin']) {
    assert.deepEqual(rowControls({ manager: null, youUserId: 'u-me' }, row({ role })), { roles: [], remove: false, access: false, financeLead: null });
  }
});

test('the words say what the role can do, what it cannot, and what it means on chain', () => {
  const w = financeLeadWords();
  assert.ok(w.can.length >= 3 && w.cannot.length >= 6);
  const cannot = w.cannot.join(' ').toLowerCase();
  for (const phrase of ['wallet signers', 'bank account', 'add funds', 'withdraw', 'owner', 'limits', 'this role']) assert.ok(cannot.includes(phrase), phrase);
  assert.match(w.chain, /owners'? quorum|owners sign/i, 'adding a signer stays the owners\' to sign');
  assert.match(w.chain, /start/i);
  assert.match(w.chain, /Splash holds no key|no key/i);
  const all = JSON.stringify(w);
  assert.doesNotMatch(all, /non-custodial|licen[cs]e|coming soon|demo|testnet/i);
  assert.doesNotMatch(all, /—/, 'no long dashes in what a customer reads');
});

test('a member sees Add funds and Withdraw only when an owner granted them, and is told who to ask when they have neither', () => {
  assert.deepEqual(walletActions({ addFunds: true, withdraw: true }), { addFunds: true, withdraw: true, notice: null });
  assert.deepEqual(walletActions({ addFunds: true, withdraw: false }), { addFunds: true, withdraw: false, notice: null });
  const none = walletActions({ addFunds: false, withdraw: false });
  assert.deepEqual([none.addFunds, none.withdraw], [false, false]);
  assert.match(none.notice, /owner/i);
  assert.match(none.notice, /Settings/);
  // While access is unknown nothing is offered.
  assert.deepEqual(walletActions(null), { addFunds: false, withdraw: false, notice: null });
  assert.deepEqual(walletActions(undefined), { addFunds: false, withdraw: false, notice: null });
});

test('the activity line says who did what to whom in plain words, for every action the trail records', () => {
  const s = (action, detail = {}) => activitySummary({ action, detail, actorName: 'Asha', subjectName: 'Ben' });
  assert.equal(s('member_added', { role: 'checker' }), 'Asha added Ben as an approver.');
  assert.equal(s('member_role_changed', { from: 'maker', to: 'checker' }), 'Asha changed Ben from staff to approver.');
  assert.equal(s('member_removed', { role: 'viewer' }), 'Asha removed Ben (a viewer).');
  assert.equal(s('finance_lead_appointed'), 'Asha made Ben the Finance lead.');
  assert.equal(s('finance_lead_revoked'), 'Asha took the Finance lead role back from Ben.');
  assert.equal(s('member_access_granted', { access: 'add_funds' }), 'Asha let Ben add funds.');
  assert.equal(s('member_access_granted', { access: 'withdraw' }), 'Asha let Ben withdraw.');
  assert.equal(s('member_access_revoked', { access: 'withdraw' }), 'Asha stopped Ben withdrawing.');
  assert.equal(activitySummary({ action: 'member_added', detail: { role: 'maker' }, actorName: 'Splash support', subjectName: 'Ben' }), 'Splash support added Ben as staff.');
});

/* ── The pages use them ───────────────────────────────────────────────── */

test('the Wallet page offers Add funds and Withdraw from the server\'s access, on the balance and in the sections', () => {
  const page = read('components/wallet/WalletPage.tsx');
  assert.match(page, /walletActions\(o\.access\)/);
  assert.doesNotMatch(page, /canAsk=\{o\.role === 'OWNER' \|\| o\.role === 'MAKER'/, 'a role no longer decides Withdraw');
  assert.doesNotMatch(page, /canAdd=\{o\.role !== 'VIEWER'\}/, 'a role no longer decides Add funds');
  const balance = read('components/wallet/BalanceCard.tsx');
  assert.match(balance, /actions\.addFunds/);
  assert.match(balance, /actions\.withdraw/);
});

test('Transfer, Batch and Home show an Add funds link only to someone with the access', () => {
  for (const path of ['components/transfer/TransferFlow.tsx', 'components/batch/BatchFlow.tsx', 'components/home/PhoneHome.tsx']) {
    const text = read(path);
    assert.match(text, /useTeamAccess\(/, path);
  }
});

test('Settings shows the team to anyone who manages it, even before a business wallet exists', () => {
  const page = read('components/settings/SettingsPage.tsx');
  assert.match(page, /\/api\/team'/);
  assert.match(page, /<TeamCard/);
});
