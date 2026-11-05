import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fromBase64 } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { T0 } from './fixtures/wallet-world.mjs';
import { spendWorld } from './fixtures/spend-world.mjs';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { changeSpendingRule, issueSpendingRule, readSpendingRules, startSpendPolicy } from '../lib/server/spend-rules.ts';
import { signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { ruleRequest } from '../lib/team-rules/form.ts';
import { revokeWords, rulesState } from '../lib/team-rules/states.ts';
import { reviewSummary, ruleSummary } from '../lib/team-rules/summary.ts';
import { ruleLine } from '../lib/team-rules/view.ts';
import { rulesSummary } from '../lib/wallet-page/rules.ts';

/**
 * v2 Phase 3, brief 4.2: the independent review of the spending-rules screens.
 *
 *   bridge      a change made after the person has paid today leaves a short
 *               bridge allowance and a later one that starts when the window
 *               renews (spend-rules.ts carriedIssue). The screens read the
 *               rule as a whole, not the bridge as if it were the rule
 *   states      a team read that is still loading or has failed is never
 *               shown as "No staff yet"
 *   words       what staff read is not written to the owner; take-back does
 *               not promise what the chain refuses; a rule that cannot pay
 *               its maximum is not accepted; a recipient added for everyone
 *               is named before anyone signs; "Used up" is a state
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const U = (n) => String(Math.round(n * 1_000_000));
const NOW = new Date('2026-10-28T10:00:00Z');
const HOUR = 3_600_000;

/* ── A change after spending: the chain's own bridge, read back ─────────────── */

const DAY = 86_400_000n;
const USDC_1 = 1_000_000n;
const t0 = BigInt(T0.getTime());
const staffKey = softPasskey();
const STAFF = staffKey.address;

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}
async function signBy(w, view, ...who) {
  let last;
  for (const name of who) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: name === 'founder' ? 'u-founder' : `u-${name}`, id: view.id, signature: await sign(w.keys[name], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}
async function withPolicy(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  await signBy(w, register, 'two', 'three');
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const opened = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, perPaymentMaxMinor: 20_000n * USDC_1 });
  await signBy(w, opened.request, 'founder', 'two');
  return members;
}
const rule = (over = {}) => ({ spender: STAFF, perPaymentMaxMinor: 200n * USDC_1, cap: { period: 'day', limitMinor: 300n * USDC_1 }, expiresAtMs: t0 + 300n * DAY, ...over });

/** A rule given, 100 spent today, then changed: the chain's two-allowance result, read as the screens read it. */
async function changedAfterSpending(lifetime) {
  const w = await spendWorld();
  const members = await withPolicy(w);
  const given = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule(lifetime ? { lifetimeCapMinor: lifetime } : {}) });
  assert.equal(given.ok, true, JSON.stringify(given));
  await signBy(w, given.request, 'two', 'three');
  w.charge([...w.spend.allowances.keys()][0], 100n * USDC_1, t0 + 1_000n);
  const changed = await changeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule(lifetime ? { lifetimeCapMinor: lifetime } : {}) });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  await signBy(w, changed.request, 'founder', 'two');
  const { view } = await readSpendingRules(w.sc);
  await w.client.close();
  return { view, rule: { ...view.rules[0], name: 'Aisha Rahman', userId: 'u-staff', standing: 'member' } };
}

test('the fixture is the chain’s own bridge: a short allowance now and the full rule from the renewal', async () => {
  const { rule: r } = await changedAfterSpending(null);
  assert.deepEqual(r.allowances.map((a) => [a.state, a.lifetimeCapMinor, a.window.limitMinor]), [
    ['active', U(200), U(200)],
    ['not_started', null, U(300)],
  ]);
  assert.equal(r.allowances[0].expiresAtMs, r.allowances[1].startsAtMs, 'the later one starts when the bridge ends');
});

test('after a change made after spending, the screens say the whole rule, not the bridge', async () => {
  const { view, rule: r } = await changedAfterSpending(null);
  const summary = ruleSummary(r, view.policy, T0);
  const text = summary.alone.join(' | ');
  assert.match(text, /Pay up to 300\.00 USDC a day in all/, text);
  assert.doesNotMatch(text, /No more than/, 'the owner set no lifetime total; the bridge’s is not one');
  assert.match(text, new RegExp(`Until ${new Date(Number(t0 + 300n * DAY) - 1).toISOString().slice(0, 10)} \\(UTC\\)`), 'it runs to the rule’s end, not to the bridge’s');
  const l = ruleLine(r, T0);
  assert.equal(l.lifetime, null);
  assert.match(l.endsIn ?? '', /^Ends in 300 days/);
  assert.equal(l.left, '200.00 USDC left today', 'today only 200 is left');
  assert.equal(l.usage, null, 'what was spent before the change is not known from the bridge, so no "0 of 200 used"');
  assert.match(l.renewsIn ?? '', /^The full cap applies again in /);
});

test('Change opens with the whole rule: the cap, no lifetime total, and the real end date', async () => {
  const { rule: r } = await changedAfterSpending(null);
  const { changeInitial } = await import('../lib/team-rules/terms.ts');
  const initial = changeInitial(r, T0);
  assert.equal(initial.cap, '300.00');
  assert.equal(initial.period, 'day');
  assert.equal(initial.perPayment, '200.00');
  assert.equal('lifetimeCap' in initial, false, 'an owner who set none is not handed the bridge’s');
  assert.equal(initial.expires, new Date(Number(t0 + 300n * DAY) - 1).toISOString().slice(0, 10));
});

test('a lifetime total the owner set is the sum of the pieces, and what is left is the sum of what is left', async () => {
  const { view, rule: r } = await changedAfterSpending(1_000n * USDC_1);
  assert.deepEqual(r.allowances.map((a) => a.lifetimeCapMinor), [U(200), U(700)], 'the chain: 200 bridge, 700 from the renewal, 100 already spent');
  const text = ruleSummary(r, view.policy, T0).alone.join(' | ');
  assert.match(text, /No more than 900\.00 USDC in all under this rule \(900\.00 USDC left\)/, text);
  assert.equal(ruleLine(r, T0).lifetime, '900.00 of 900.00 USDC left in all');
  const { changeInitial } = await import('../lib/team-rules/terms.ts');
  assert.equal(changeInitial(r, T0).lifetimeCap, '900.00', 'asking again for 900 less nothing spent under the new allowances is 900 left, as it is now');
});

test('what has been paid is summed across the rule’s allowances, and says since when', () => {
  const a = (over) => ({ current: true, state: 'active', startsAtMs: null, expiresAtMs: String(Date.UTC(2027, 1, 1)), currentSpendMinor: U(40), lifetimeCapMinor: null, lifetimeRemainingMinor: null, spendableNowMinor: U(10), window: { period: 'day', limitMinor: U(300), spentMinor: U(40), remainingMinor: U(260), endsAtMs: String(Date.UTC(2026, 9, 29)), rolledOver: false }, ...over });
  const r = { userId: 'u', name: 'Aisha', spender: '0x1', standing: 'member', perPaymentMaxMinor: U(200), status: 'active', allowances: [a({ expiresAtMs: String(Date.UTC(2026, 9, 29)), currentSpendMinor: U(40) }), a({ state: 'not_started', startsAtMs: String(Date.UTC(2026, 9, 29)), currentSpendMinor: U(15), window: { ...a().window, spentMinor: '0', remainingMinor: U(300), limitMinor: U(300) } })] };
  const l = ruleLine(r, NOW);
  assert.equal(l.paidInAll, 'Paid since the rule was given or last changed: 55.00 USDC');
});

/* ── The team read ─────────────────────────────────────────────────────────── */

const READY = { owner: true, loading: false, error: null, hasPolicy: true, staff: 0, rules: 0 };

test('a team that is still being read, or could not be, is not "No staff yet"', () => {
  assert.equal(rulesState({ ...READY, staffLoading: true }), 'loading');
  assert.equal(rulesState({ ...READY, staffError: 'The people in charge could not be loaded.' }), 'staff_error');
  assert.equal(rulesState({ ...READY }), 'no_staff', 'only a successful read that found no one says so');
  assert.equal(rulesState({ ...READY, staff: 2 }), 'empty');
  // Rules already listed stay listed whatever the team read does.
  assert.equal(rulesState({ ...READY, rules: 1, staffLoading: true }), 'list');
  // The team read is the owner's: a staff member's page does not wait for or fail on it.
  assert.equal(rulesState({ ...READY, owner: false, staffError: 'x', staffLoading: true }), 'empty');
});

test('Settings gives the rules section the team read’s own loading and error, and a way to try it again', () => {
  const page = code(read('components/settings/SettingsPage.tsx'));
  assert.match(page, /staffLoading=\{charge\.loading\}/);
  assert.match(page, /staffError=\{charge\.error\}/);
  assert.match(page, /onRetryStaff=\{charge\.reload\}/);
  const section = code(read('components/settings/RulesSection.tsx'));
  assert.match(section, /staffLoading,\s*staffError/);
  assert.match(section, /state === 'staff_error'/);
});

/* ── Whose words ───────────────────────────────────────────────────────────── */

const policy = { perPaymentMaxMinor: U(5000), secondApprovalThresholdMinor: U(10000), runningWindowMs: String(24 * HOUR), recipients: [{ address: '0xr1', tag: 'wallet' }, { address: '0xr2', tag: 'exchange' }], beneficiaries: [] };
const simple = () => ({
  userId: 'u', name: 'Aisha Rahman', spender: '0x1', standing: 'member', perPaymentMaxMinor: U(500), status: 'active',
  allowances: [{ current: true, state: 'active', startsAtMs: null, expiresAtMs: String(Date.UTC(2027, 1, 1)), currentSpendMinor: U(300), lifetimeCapMinor: null, lifetimeRemainingMinor: null, spendableNowMinor: U(1700), window: { period: 'day', limitMinor: U(2000), spentMinor: U(300), remainingMinor: U(1700), endsAtMs: String(Date.UTC(2026, 9, 29)), rolledOver: false } }],
});

test('a staff member reads "the 2 verified recipients", never "you have verified"; the owner keeps "you"', () => {
  const owner = ruleSummary(simple(), policy, NOW, { owner: true });
  assert.match(owner.alone.join(' '), /Pay the 2 recipients you have verified\./);
  const staff = ruleSummary(simple(), policy, NOW, { owner: false });
  assert.match(staff.alone.join(' '), /Pay the 2 verified recipients\./);
  assert.doesNotMatch(staff.alone.join(' ') + staff.approval.join(' '), /\byou\b/i);
  const none = ruleSummary(simple(), { ...policy, recipients: [] }, NOW, { owner: false });
  assert.match(none.alone.join(' '), /until one is verified/);
  assert.doesNotMatch(none.alone.join(' '), /\byou\b/i);
});

test('the card’s own words for staff carry no owner-only sentence', async () => {
  const { rulesIntro } = await import('../lib/team-rules/summary.ts');
  const owner = rulesIntro({ owner: true, thresholdMinor: U(10000) });
  assert.match(owner, /recipients you have verified/);
  assert.match(owner, /Your own changes take effect at once/);
  const staff = rulesIntro({ owner: false, thresholdMinor: U(10000) });
  assert.doesNotMatch(staff, /you have verified|Your own changes|take effect at once/);
  assert.match(staff, /10,000\.00 USDC/);
  assert.match(staff, /above/);
  const section = code(read('components/settings/RulesSection.tsx'));
  assert.match(section, /rulesIntro\(/);
  assert.match(section, /ruleSummary\(raw, spend\.policy, now, \{ owner \}\)/);
});

test('taking a rule back does not promise the person can pay again: the chain pays only a spender', () => {
  const w = revokeWords('Aisha Rahman');
  const stays = w.stays.join(' ');
  assert.doesNotMatch(stays, /can pay again/);
  assert.match(stays, /can still ask the owners to pay/);
  assert.match(stays, /owners pay from the wallet/);
});

/* ── A rule that can pay what it says ──────────────────────────────────────── */

const form = (over = {}) => ({ staffUserId: 'u', perPayment: '600', period: 'day', cap: '1000', expires: '2027-01-31', lifetimeCap: '', ...over });
const ctx = { now: new Date('2026-10-28T10:00:00Z'), policyMaxMinor: null };

test('a cap, or a lifetime total, that the most one payment plus its fee would break is not accepted', () => {
  // The fee at its ceiling is 1%: 600 + 6 = 606.
  assert.equal(ruleRequest(form({ cap: '606' }), ctx).ok, true, 'exactly one full payment and its fee fits');
  const tight = ruleRequest(form({ cap: '600' }), ctx);
  assert.equal(tight.ok, false);
  assert.match(tight.errors.cap, /plus its fee/);
  assert.match(tight.errors.cap, /606\.00 USDC/);
  assert.equal(ruleRequest(form({ cap: '605.999999' }), ctx).ok, false, 'one minor unit short is short');
  assert.equal(ruleRequest(form({ lifetimeCap: '606' }), ctx).ok, true);
  const life = ruleRequest(form({ lifetimeCap: '600' }), ctx);
  assert.equal(life.ok, false);
  assert.match(life.errors.lifetimeCap, /plus its fee/);
});

/* ── Who becomes payable by everyone ───────────────────────────────────────── */

test('the review names each recipient the request adds for everyone with a rule', () => {
  const body = { perPaymentMaxMinor: U(500), cap: { period: 'day', limitMinor: U(2000) }, expiresAtMs: String(Date.UTC(2027, 1, 1)), recipients: { add: [{ address: '0x' + 'ab'.repeat(32), tag: 'wallet' }] } };
  const s = reviewSummary(body, policy, 'Aisha Rahman', [{ name: 'Kopi Works', address: '0x' + 'ab'.repeat(32) }]);
  assert.equal(s.added.length, 1);
  assert.match(s.added[0], /Kopi Works/);
  assert.match(s.added[0], /0xabab…abab/);
  assert.match(s.alone.join(' '), /Pay the 3 recipients you have verified/);
  assert.deepEqual(reviewSummary({ ...body, recipients: undefined }, policy, 'Aisha Rahman').added ?? [], []);
  const formSrc = code(read('components/settings/RuleForm.tsx'));
  assert.match(formSrc, /Added for everyone with a rule/);
});

/* ── Used up ───────────────────────────────────────────────────────────────── */

test('a rule whose lifetime total is spent says "Used up", not "Active", and every payment goes to the owners', () => {
  const used = simple();
  used.allowances[0] = { ...used.allowances[0], lifetimeCapMinor: U(1000), lifetimeRemainingMinor: '0', currentSpendMinor: U(1000), spendableNowMinor: '0' };
  const l = ruleLine(used, NOW);
  assert.deepEqual(l.state, { label: 'Used up', tone: 'wait' });
  const s = ruleSummary(used, policy, NOW);
  assert.deepEqual(s.alone, []);
  assert.match(s.approval.join(' '), /used up/);
  // A window that is full is not used up: it renews.
  const full = simple();
  full.allowances[0] = { ...full.allowances[0], spendableNowMinor: '0', window: { ...full.allowances[0].window, spentMinor: U(2000), remainingMinor: '0' } };
  assert.equal(ruleLine(full, NOW).state.label, 'Active');
  const card = code(read('components/settings/RulesSection.tsx'));
  assert.doesNotMatch(card, /bg-\[#F6F0ED\]"\s*>\s*<div className="h-full/, 'the spend bar has no filled track behind it');
});

/* ── Someone with no passkey ───────────────────────────────────────────────── */

test('the owner sees who has no passkey before the last question, not after it', () => {
  const form = code(read('components/settings/RuleForm.tsx'));
  assert.match(form, /hasPasskey/);
  assert.match(form, /no passkey yet/);
  const page = code(read('components/settings/SettingsPage.tsx'));
  assert.match(page, /hasPasskey: m\.hasPasskey/);
  const route = code(read('app/api/wallet/persons-in-charge/route.ts'));
  assert.match(route, /orgMemberWalletAddresses\(gate\.route\.db, gate\.route\.orgId\)/);
  assert.match(route, /hasPasskey/);
});

/* ── The policy card and the Wallet page ───────────────────────────────────── */

test('the policy card says an owner approves above the amount, as the chain applies it', () => {
  const card = code(read('components/settings/PolicyCard.tsx'));
  assert.doesNotMatch(card, /An owner approves from/);
  assert.match(card, /An owner approves above/);
});

test('the Wallet page card reads a changed rule as a whole too', async () => {
  const { rule: r } = await changedAfterSpending(null);
  const s = rulesSummary({ policy: { secondApprovalThresholdMinor: U(10000) }, reissueNeeded: false, rules: [r] }, { owner: true });
  assert.equal(s.rules[0].state, 'Active');
  assert.doesNotMatch(s.rules[0].window ?? '', /0\.00 of 200\.00/);
  assert.match(s.rules[0].window ?? '', /200\.00 USDC left today/);
});

test('a bridged rule still shows what is left today and when the full cap returns; a used-up rule shows no window room', async () => {
  const { rule: r } = await changedAfterSpending(null);
  const section = code(read('components/settings/RulesSection.tsx'));
  assert.match(section, /l\.usage \|\| l\.left/, 'the list does not hide "left today" because no "used" figure is known');
  const l = ruleLine(r, T0);
  assert.equal(l.usage, null);
  assert.ok(l.renewsLine?.startsWith('The full cap applies again in '), l.renewsLine ?? 'none');
  assert.match(l.renewsLine ?? '', /\(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/);
  const used = simple();
  used.allowances[0] = { ...used.allowances[0], lifetimeCapMinor: U(1000), lifetimeRemainingMinor: '0', currentSpendMinor: U(1000), spendableNowMinor: '0' };
  const u = ruleLine(used, NOW);
  assert.deepEqual([u.usage, u.left, u.renewsLine], [null, null, null], 'a full lifetime total pays nothing, so no window figure reads as room');
  const card = rulesSummary({ policy: { secondApprovalThresholdMinor: U(10000) }, reissueNeeded: false, rules: [used] }, { owner: true }).rules[0];
  assert.deepEqual([card.state, card.window], ['Used up', null], 'the Wallet card says the same');
});
