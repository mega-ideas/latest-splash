import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { parseUsdc, policyRequest, ruleRequest } from '../lib/team-rules/form.ts';
import { housekeeping, policyView, recipientOffers, ruleLine, teamRows } from '../lib/team-rules/view.ts';
import { ABOUT } from '../lib/settings-page/about.ts';

/**
 * v2 Phase 3, brief 5.9: Settings, Team & rules on the §4.2 backend. An owner
 * gives, changes and takes back a rule; sees each rule's live spend and what is
 * left of its window; sets the business's spending policy; chooses which
 * verified recipients staff may pay alone; appoints the person in charge. Every
 * change is a request the owners sign on their own devices (instant for an
 * owner's own change: no cooldown). The words are checked here; the chain
 * rules are checked in spend-rules.test.mjs.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const U = (n) => String(Math.round(n * 1_000_000));
const NOW = new Date('2026-10-28T10:00:00Z');

/* Amounts ------------------------------------------------------------------- */

test('an amount is read as USDC to six places, and anything else is refused', () => {
  assert.equal(parseUsdc('12'), 12_000_000n);
  assert.equal(parseUsdc('12.5'), 12_500_000n);
  assert.equal(parseUsdc(' 1,000.25 '), 1_000_250_000n);
  assert.equal(parseUsdc('0.000001'), 1n);
  for (const bad of ['', ' ', '-1', '1.0000001', '1e3', 'abc', '1,00,0', '0x10', '$5', '5 USDC', '1..2', '.']) assert.equal(parseUsdc(bad), null, JSON.stringify(bad));
  assert.equal(parseUsdc('99999999999999.999999'), null, 'more than the chain can hold is refused');
});

/* A rule -------------------------------------------------------------------- */

const form = (over = {}) => ({ staffUserId: 'u-staff', perPayment: '500', period: 'day', cap: '2,000', expires: '2027-01-31', lifetimeCap: '', ...over });
const ctx = (over = {}) => ({ now: NOW, policyMaxMinor: 5_000_000_000n, ...over });

test('a rule becomes exactly the request the route takes: minor units, a cap, and an end at the close of the chosen day (UTC)', () => {
  const r = ruleRequest(form(), ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, {
    staffUserId: 'u-staff',
    perPaymentMaxMinor: '500000000',
    cap: { period: 'day', limitMinor: '2000000000' },
    expiresAtMs: String(Date.UTC(2027, 0, 31) + 86_400_000),
  });
  const withLifetime = ruleRequest(form({ period: 'month', lifetimeCap: '20000' }), ctx());
  assert.equal(withLifetime.body.lifetimeCapMinor, '20000000000');
  assert.equal(withLifetime.body.cap.period, 'month');
  assert.equal('lifetimeCapMinor' in r.body, false, 'no lifetime cap unless one is given');
  assert.equal(JSON.stringify(r.body).includes('orgId'), false, 'the business is the session’s, never the page’s');
  assert.equal('address' in r.body || 'spender' in r.body, false, 'the person’s address is their own passkey, chosen by the server');
});

test('a rule that cannot work is said so, field by field, before anything is asked of the owners', () => {
  const errs = (over, c = {}) => ruleRequest(form(over), ctx(c)).errors;
  assert.match(errs({ staffUserId: '' }).staffUserId, /Choose who this is for/);
  assert.match(errs({ perPayment: '' }).perPayment, /most one payment/);
  assert.match(errs({ perPayment: '0' }).perPayment, /above zero/);
  assert.match(errs({ perPayment: '6000' }).perPayment, /more than the business’s limit of 5,000/);
  assert.match(errs({ cap: '' }).cap, /daily or monthly cap/);
  assert.match(errs({ cap: '100' }).cap, /lower than the most one payment/);
  assert.match(errs({ expires: '' }).expires, /date the rule ends/);
  assert.match(errs({ expires: '2026-10-27' }).expires, /in the future/);
  assert.match(errs({ expires: '2028-10-28' }).expires, /within a year/);
  assert.match(errs({ expires: 'next week' }).expires, /date the rule ends/);
  assert.match(errs({ lifetimeCap: '100' }).lifetimeCap, /lower than the most one payment/);
  assert.match(errs({ lifetimeCap: 'lots' }).lifetimeCap, /amount in USDC/);
  assert.equal(ruleRequest(form(), ctx()).errors, undefined);
  // Without a policy yet there is no business limit to compare with; the route says so.
  assert.equal(ruleRequest(form({ perPayment: '6000', cap: '9000' }), ctx({ policyMaxMinor: null })).ok, true);
});

test('a date that does not exist is not a date', () => {
  assert.match(ruleRequest(form({ expires: '2027-02-30' }), ctx()).errors.expires, /date the rule ends/);
  assert.match(ruleRequest(form({ expires: '2027-13-01' }), ctx()).errors.expires, /date the rule ends/);
});

/* The policy ---------------------------------------------------------------- */

test('the spending policy is created with a per-payment maximum, and changed one limit at a time or together', () => {
  assert.deepEqual(policyRequest({ perPayment: '5,000', threshold: '', windowHours: '' }, { creating: true }), { ok: true, body: { perPaymentMaxMinor: '5000000000' } });
  assert.match(policyRequest({ perPayment: '', threshold: '', windowHours: '' }, { creating: true }).errors.perPayment, /most any one payment/);
  const change = policyRequest({ perPayment: '', threshold: '10000', windowHours: '48' }, { creating: false });
  assert.deepEqual(change.body, { secondApprovalThresholdMinor: '10000000000', runningWindowMs: String(48 * 3_600_000) });
  assert.match(policyRequest({ perPayment: '', threshold: '', windowHours: '' }, { creating: false }).errors.form, /Change at least one limit/);
  assert.match(policyRequest({ perPayment: '', threshold: '', windowHours: '0' }, { creating: false }).errors.windowHours, /between 1 hour and 30 days/);
  assert.match(policyRequest({ perPayment: '', threshold: '', windowHours: '721' }, { creating: false }).errors.windowHours, /between 1 hour and 30 days/);
  assert.equal(policyRequest({ perPayment: '', threshold: '', windowHours: '720' }, { creating: false }).ok, true);
  assert.match(policyRequest({ perPayment: '', threshold: '0', windowHours: '' }, { creating: false }).errors.threshold, /above zero/);
});

/* What a rule reads like ---------------------------------------------------- */

const rule = (over = {}) => ({
  userId: 'u-staff',
  name: 'Aisha Rahman',
  spender: '0xaaa',
  role: 'staff',
  standing: 'member',
  perPaymentMaxMinor: U(500),
  status: 'active',
  // A rule ends at the close of its last day: midnight UTC after it.
  allowances: [{ current: true, state: 'active', expiresAtMs: String(Date.UTC(2027, 1, 1)), currentSpendMinor: U(300), lifetimeCapMinor: null, lifetimeRemainingMinor: null, spendableNowMinor: U(1700), window: { period: 'day', limitMinor: U(2000), spentMinor: U(300), remainingMinor: U(1700), startsAtMs: String(Date.UTC(2026, 9, 28)), endsAtMs: String(Date.UTC(2026, 9, 29)), rolledOver: false } }],
  runningTotals: [],
  recentSpends: [],
  ...over,
});

test('a rule shows its live spend, what is left, when the window renews and when the rule ends', () => {
  const l = ruleLine(rule(), NOW);
  assert.equal(l.name, 'Aisha Rahman');
  assert.deepEqual([l.state.label, l.state.tone], ['Active', 'ok']);
  assert.equal(l.perPayment, '500.00 USDC');
  assert.equal(l.usage.text, '300.00 of 2,000.00 USDC used today');
  assert.equal(l.usage.percent, 15);
  assert.equal(l.left, '1,700.00 USDC left today');
  assert.match(l.renews, /^Renews 2026-10-29 00:00 UTC$/);
  assert.equal(l.ends, 'Ends 2027-01-31 (UTC)');
  assert.equal(l.lifetime, null);
  const monthly = ruleLine(rule({ allowances: [{ ...rule().allowances[0], window: { ...rule().allowances[0].window, period: 'month' }, lifetimeCapMinor: U(20000), lifetimeRemainingMinor: U(19700) }] }), NOW);
  assert.equal(monthly.usage.text, '300.00 of 2,000.00 USDC used this month');
  assert.equal(monthly.lifetime, '19,700.00 of 20,000.00 USDC left in all');
});

test('a rule that cannot pay says why: expired, not started, revoked, or held by someone who is gone', () => {
  assert.deepEqual([ruleLine(rule({ status: 'expired' }), NOW).state.label, ruleLine(rule({ status: 'expired' }), NOW).state.tone], ['Expired', 'bad']);
  assert.equal(ruleLine(rule({ status: 'not_started' }), NOW).state.label, 'Starts later');
  assert.equal(ruleLine(rule({ status: 'no_allowance', allowances: [] }), NOW).state.label, 'Taken back');
  const gone = ruleLine(rule({ standing: 'removed' }), NOW);
  assert.equal(gone.state.label, 'Belongs to someone who left');
  assert.equal(gone.orphaned, true);
  assert.equal(ruleLine(rule({ standing: 'viewer' }), NOW).state.label, 'Belongs to a viewer');
  assert.equal(ruleLine(rule({ name: null }), NOW).name, 'A staff member');
});

test('a window that has rolled over reads as it will for the next payment: the whole cap is there', () => {
  const l = ruleLine(rule({ allowances: [{ ...rule().allowances[0], window: { ...rule().allowances[0].window, spentMinor: '0', remainingMinor: U(2000), rolledOver: true } }] }), NOW);
  assert.equal(l.usage.text, '0.00 of 2,000.00 USDC used today');
  assert.equal(l.left, '2,000.00 USDC left today');
});

test('an allowance of an earlier wallet is not the rule: only the current one is read', () => {
  const stale = { ...rule().allowances[0], current: false, currentSpendMinor: U(99999) };
  const l = ruleLine(rule({ allowances: [stale, rule().allowances[0]] }), NOW);
  assert.equal(l.usage.text, '300.00 of 2,000.00 USDC used today');
  const none = ruleLine(rule({ allowances: [stale] }), NOW);
  assert.equal(none.usage, null);
});

/* The team ------------------------------------------------------------------ */

test('the team lists each person with their role, whether they are in charge, and their rule', () => {
  const members = [
    { userId: 'u-owner', name: 'Farid', role: 'admin' },
    { userId: 'u-staff', name: 'Aisha Rahman', role: 'maker' },
    { userId: 'u-appr', name: 'Chen', role: 'checker' },
    { userId: 'u-view', name: 'Dewi', role: 'viewer' },
  ];
  const rows = teamRows({ members, personsInCharge: [{ userId: 'u-appr' }], rules: [rule()] }, NOW);
  assert.deepEqual(rows.map((r) => [r.name, r.role, r.inCharge, r.canHaveRule, r.rule ? 'rule' : 'none']), [
    ['Farid', 'Owner', false, false, 'none'],
    ['Aisha Rahman', 'Staff', false, true, 'rule'],
    ['Chen', 'Approver', true, true, 'none'],
    ['Dewi', 'Viewer', false, false, 'none'],
  ]);
});

/* The policy and the recipients staff may pay ------------------------------- */

const policy = { id: '0xp', perPaymentMaxMinor: U(5000), secondApprovalThresholdMinor: U(10000), runningWindowMs: String(24 * 3_600_000), generation: '1', recipients: [{ address: `0x${'77'.repeat(32)}`, tag: 'wallet' }], beneficiaries: [{ commitment: '0xab', partnerDeposit: '0xcd' }] };

test('the policy reads in words: the most any payment may be, when an owner must approve, and the window that adds payments together', () => {
  const v = policyView(policy);
  assert.deepEqual(v, { perPayment: '5,000.00 USDC', threshold: '10,000.00 USDC', window: '24 hours', recipients: 1, bankAccounts: 1 });
  assert.equal(policyView({ ...policy, runningWindowMs: String(7 * 24 * 3_600_000) }).window, '7 days');
  assert.equal(policyView(null), null);
});

const saved = (over = {}) => ({ id: 'r1', name: 'Dela Cruz Trading', country: 'PH', bank: '', account: '', kybStatus: 'none', createdAt: '2026-10-20T00:00:00Z', screeningVerdict: 'CLEAR', approvedAt: '2026-10-21T00:00:00Z', savedByYou: false, hasEmail: true, payoutMethod: 'WALLET', walletAddress: `0x${'77'.repeat(32)}`, delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'proven' }, ...over });

test('staff may pay alone only the recipients that are ready, tagged for what they are, and not already allowed', () => {
  const ex = saved({ id: 'r2', name: 'Maria Exchange', walletAddress: `0x${'66'.repeat(32)}`, delivery: { deliveryKind: 'EXCHANGE', exchangeId: 'pdax', destinationAddress: `0x${'66'.repeat(32)}` } });
  const unproven = saved({ id: 'r3', name: 'Not proven', walletAddress: `0x${'55'.repeat(32)}`, delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } });
  const cross = saved({ id: 'r4', name: 'Base', walletAddress: undefined, payoutMethod: 'CROSS_CHAIN', delivery: { deliveryKind: 'CROSS_CHAIN', destinationChain: 'BASE', destinationAddress: '0x52908400098527886e0f7030069857d2e4169ee7' } });
  const o = recipientOffers(policy, [saved(), ex, unproven, cross]);
  assert.deepEqual(o.allowed.map((a) => [a.name, a.tag]), [['Dela Cruz Trading', 'wallet']]);
  assert.deepEqual(o.offers.map((a) => [a.name, a.tag, a.address]), [['Maria Exchange', 'exchange', `0x${'66'.repeat(32)}`]]);
  assert.equal(o.allowed[0].address, `0x${'77'.repeat(32)}`);
  const other = recipientOffers({ ...policy, recipients: [{ address: `0x${'99'.repeat(32)}`, tag: 'wallet' }] }, []);
  assert.equal(other.allowed[0].name, null, 'an address with no saved recipient is shown as an address');
  assert.deepEqual(recipientOffers(null, [saved()]).offers, []);
});

test('what needs an owner’s attention is said in one place: a reissue after a rotation, rules of people who left, and near-threshold flags', () => {
  const h = housekeeping({ reissueNeeded: true, orphaned: ['0xa', '0xb'], nearThreshold: [{}, {}, {}], stale: [{}], unattached: [] });
  assert.deepEqual(h.map((x) => x.id), ['reissue', 'orphaned', 'near_threshold', 'stale']);
  assert.match(h[0].text, /signers changed/);
  assert.match(h[1].text, /2 rules belong to people who are no longer on the team/);
  assert.match(h[2].text, /3 recipients are near/);
  assert.deepEqual(housekeeping({ reissueNeeded: false, orphaned: [], nearThreshold: [], stale: [], unattached: [] }), []);
  assert.match(housekeeping({ reissueNeeded: false, orphaned: ['0xa'], nearThreshold: [{}] , stale: [], unattached: [] })[0].text, /A rule belongs to someone who is no longer on the team/);
});

/* How Splash operates ------------------------------------------------------- */

test('the “How Splash operates” card says what is true, with no custody, licence or regulator-progress claim and no sweep ladder', () => {
  const text = ABOUT.map((a) => `${a.label} ${a.text}`).join('\n');
  assert.match(text, /does not hold customer funds|holds none of it|no key/i);
  assert.doesNotMatch(text, /Labuan|DFS|regulator-ready|licen[cs]ed|non-custodial|Money Broker|Recipient ladder|sweep|stored balance|partners of record hold/i);
  assert.ok(ABOUT.length >= 4);
  assert.ok(ABOUT.some((a) => /Treasury/.test(a.label)));
  assert.match(text, /not Shariah-compliant/);
});

/* The page ------------------------------------------------------------------ */

const settingsFiles = () => {
  const dir = new URL('../components/settings/', import.meta.url);
  return readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [`components/settings/${f}`, read(`components/settings/${f}`)]);
};

test('Settings is one page of sections an owner can reach by name: team, rules, signers, funding sources, approvals, alerts, controls and how Splash operates', () => {
  assert.ok(existsSync(new URL('../components/settings/SettingsPage.tsx', import.meta.url)));
  const page = read('components/settings/SettingsPage.tsx');
  for (const part of ['TeamCard', 'PolicyCard', 'RulesSection', 'SignersCard', 'FundingSources', 'ApprovalChannelCard', 'AlertsCard', 'OperatingControls', 'AboutCard']) assert.match(page, new RegExp(`<${part}\\b`), part);
  for (const id of ['team', 'rules', 'signers', 'funding', 'approvals', 'alerts', 'controls', 'about']) {
    assert.match(page, new RegExp(`\\{ id: '${id}', label:`), `a link to #${id}`);
    assert.match(page + read('components/settings/TeamCard.tsx') + read('components/settings/RulesSection.tsx') + read('components/settings/OperatingControls.tsx') + read('components/settings/AboutCard.tsx') + read('components/wallet/SignersCard.tsx'), new RegExp(`id="${id}"`), `a section with id ${id}`);
  }
  assert.match(page, /href=\{`#\$\{s\.id\}`\}/);
  assert.match(page, /aria-label="Settings sections"/);
  const route = read('app/dashboard/settings/page.tsx');
  assert.match(route, /<SettingsPage\b/);
  assert.match(route, /readGovernanceBannerForSession/);
  assert.doesNotMatch(route, /'use client'/, 'the route is a server component: it reads the person’s own alerts and the billing switch');
});

test('billing is built behind its switch and not shown while it is off', () => {
  const route = read('app/dashboard/settings/page.tsx');
  assert.match(route, /subscriptionBillingEnabled\(\)/);
  const page = read('components/settings/SettingsPage.tsx');
  assert.match(page, /billingOn \? <BillingCard/);
  const billing = code(read('components/settings/BillingCard.tsx'));
  assert.match(billing, /\/api\/wallet\/subscription/);
  assert.match(billing, /\/api\/billing\/plans/);
  assert.match(billing, /Revoke any time/);
  // Nothing else in Settings reaches the billing routes.
  for (const [name, text] of settingsFiles()) if (!name.endsWith('BillingCard.tsx')) assert.doesNotMatch(code(text), /\/api\/wallet\/subscription|\/api\/billing/, name);
});

test('every change an owner makes opens a signing request for the owners, and nothing is signed until the device has decoded it', () => {
  const flow = read('components/settings/SignFlow.tsx');
  assert.match(flow, /<SignPanel/);
  assert.match(flow, /answer\.body\?\.request|answer\.body\.request/);
  const rules = code(read('components/settings/RulesSection.tsx'));
  for (const call of ["'/api/wallet/spending-rules'", '/api/wallet/spending-rules/${', "/api/wallet/spending-rules/orphaned", "/api/wallet/spending-rules/reissue"]) assert.ok(rules.includes(call), call);
  assert.match(rules, /method: 'PUT'/);
  assert.match(rules, /method: 'DELETE'/);
  const policy = code(read('components/settings/PolicyCard.tsx'));
  assert.match(policy, /\/api\/wallet\/spending-rules\/policy/);
  assert.match(policy, /method: 'PATCH'/);
  assert.match(policy, /\/api\/wallet\/spending-rules\/recipients/);
});

test('taking a rule back asks first, says what stops, and a change says what it keeps', () => {
  const rules = read('components/settings/RulesSection.tsx');
  // The words are lib/team-rules/states.ts's revokeWords (tested in spending-rules-screens.test.mjs); the sheet shows them.
  assert.match(rules, /revokeWords\(/);
  assert.match(read('lib/team-rules/states.ts'), /Take back this rule\?/);
  assert.match(read('lib/team-rules/states.ts'), /Their open payments stop at once/);
  assert.match(read('components/settings/RuleForm.tsx'), /What was spent so far carries over/);
});

test('only an owner is offered a change, and no one is offered what the server would refuse', () => {
  for (const file of ['RulesSection', 'PolicyCard', 'TeamCard']) {
    const text = code(read(`components/settings/${file}.tsx`));
    assert.match(text, /owner/, `${file} knows who is an owner`);
  }
  assert.match(code(read('components/settings/RulesSection.tsx')), /owner \?/);
  // Sky, 31 Oct: the owners run the team here. The card offers each person only what rowControls says the server accepts from the signed-in manager.
  const team = read('components/settings/TeamCard.tsx');
  assert.match(code(team), /rowControls\(/, 'what is offered comes from the one function that mirrors the server');
  assert.match(code(team), /manager/, 'who manages the team decides what is offered');
  assert.doesNotMatch(team, /ask Splash support/i, 'a role is no longer a Splash support request');
});

test('every call is to the signed-in person’s own business, and none names a business, a wallet or an address of the page’s own choosing', () => {
  const joined = settingsFiles().map(([, t]) => code(t)).join('\n');
  const urls = [...joined.matchAll(/(?:call|useLoad|fetch)(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]);
  // A load that waits for the wallet is `useLoad(manage ? '/api/...' : null, ...)`: those addresses are read too.
  urls.push(...[...joined.matchAll(/\?\s*['"`](\/api\/[^'"`]+)['"`]\s*:\s*null/g)].map((m) => m[1]));
  assert.ok(urls.length >= 10, `found ${urls.length}`);
  for (const url of urls) assert.match(url, /^\/api\/(wallet|settings|approvals|billing|team)\b|^\/api\/recipients$/, url);
  assert.doesNotMatch(joined, /orgId|accountId|businessWallet|\?(org|orgId|account|wallet)=/);
});

test('every control has a visible label, one height and a name; none is made by hand', () => {
  for (const name of ['RuleForm', 'PolicyCard', 'TeamCard', 'RulesSection']) {
    const text = code(read(`components/settings/${name}.tsx`));
    assert.doesNotMatch(text, /<select\b|<textarea\b/, `${name}: a select made by hand`);
    assert.doesNotMatch(text, /<input\b(?![^>]*type="checkbox")/, `${name}: an input made by hand`);
  }
  assert.match(read('components/settings/RuleForm.tsx'), /<Field /);
});

test('no coral, Demo, Coming soon, testnet, grid, unsigned partner name or licence claim on any Settings file, and the copy rules hold', () => {
  const all = [...settingsFiles(), ['app/dashboard/settings/page.tsx', read('app/dashboard/settings/page.tsx')]];
  for (const [name, text] of all) {
    const body = code(text);
    assert.doesNotMatch(body, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|bg-grid|grid-background/i, name);
    assert.doesNotMatch(body, /\b(Hata|Fiuu|PDAX|DurianPay|Halliday|Stripe|TransFi|Bridge|Elliptic|Chainalysis|Sumsub)\b/, `${name} names a partner that is not signed`);
    assert.doesNotMatch(body, /Labuan|regulator-ready|Recipient ladder/, name);
    assert.deepEqual(copyViolations(name, text), [], name);
  }
});

test('the wallet’s rules card now points an owner to where a rule is given, changed and taken back', () => {
  const card = code(read('components/wallet/RulesCard.tsx'));
  assert.match(card, /href="\/dashboard\/settings#rules"/);
  assert.doesNotMatch(card, /Ask Splash support to (reissue|take)/);
});

test('the old spending-rules link lands on Team & rules in Settings', () => {
  assert.match(read('app/dashboard/settings/spending-rules/page.tsx'), /redirect\('\/dashboard\/settings#rules'\)/);
});
