import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MEMWAL_NEVER_STORED, MEMWAL_STORED } from '../lib/agent/memwal-disclosure.ts';
import { buildHistory, failureNote, mergeLists } from '../lib/history-page/entries.ts';
import { actionsFor, buildEntries, policyHolds, removeWords, stateOf } from '../lib/recipients-page/view.ts';
import { refusalLogLine } from '../lib/server/wallet-refusal.ts';
import { ABOUT } from '../lib/settings-page/about.ts';
import { canEditControls, CONTROLS_SCOPE_NOTE } from '../lib/settings-page/controls.ts';
import { loadView } from '../lib/settings-page/load-state.ts';
import { expiryField } from '../lib/team-rules/form.ts';
import { housekeeping } from '../lib/team-rules/view.ts';

/**
 * v2 Phase 3, brief 5.9, independent review of the Recipients, History,
 * Settings and Setup pages. Each test is one finding a person would meet:
 *
 *  - Removing a wallet that is on the spending policy left it allowed on the
 *    chain, and the confirmation said nothing of it.
 *  - Approving a recipient for payment was one press on a shortened address.
 *  - History showed a shorter list as if it were complete, and one failed
 *    refresh dropped rows.
 *  - Settings said Zeke never remembers recipients, while Zeke's own disclosure
 *    lists vendor names.
 *  - And the smaller ones: a flash of an empty alert, a rule's end date reset,
 *    controls that look editable to a role the server refuses, a receipt link a
 *    viewer cannot open, an older bank entry called verified, radio buttons that
 *    do not behave like radio buttons, a card that says the same thing twice.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sui = (b) => `0x${b.repeat(32)}`;

const base = { id: 'r1', name: 'Dela Cruz Trading', country: 'PH', bank: '', account: '', kybStatus: 'none', createdAt: '2026-10-20T00:00:00.000Z', screeningVerdict: 'CLEAR', approvedAt: '2026-10-21T00:00:00.000Z', savedByYou: false, hasEmail: true };
const wallet = (over = {}) => ({ ...base, payoutMethod: 'WALLET', walletAddress: sui('77'), delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'proven' }, ...over });
const exchange = (over = {}) => ({ ...base, id: 'r2', name: 'Maria Exchange Ltd', payoutMethod: 'WALLET', walletAddress: sui('66'), delivery: { deliveryKind: 'EXCHANGE', exchangeId: 'pdax', depositNetwork: 'SUI', destinationAddress: sui('66') }, ...over });
const legacyBank = (over = {}) => ({ ...base, id: 'r4', name: 'PT Maju', country: 'ID', bank: 'BCA', account: '1234567890', payoutMethod: 'BANK', delivery: { deliveryKind: 'BANK' }, ...over });
const entryOf = (r) => buildEntries({ saved: [r], beneficiaries: [], transfers: [] })[0];

/* Recipients: Remove -------------------------------------------------------------- */

test('a wallet on the spending policy is found by its address, however the address is cased', () => {
  const policy = { recipients: [{ address: sui('77').toUpperCase().replace('0X', '0x'), tag: 'wallet' }] };
  assert.equal(policyHolds(policy, sui('77')), true);
  assert.equal(policyHolds(policy, sui('66')), false);
  assert.equal(policyHolds(null, sui('77')), false, 'with no policy nothing is allowed');
  assert.equal(policyHolds(policy, ''), false);
});

test('the entry carries the whole address, so a person can read it before they decide', () => {
  assert.equal(entryOf(wallet()).address, sui('77'));
  assert.equal(entryOf(exchange()).address, sui('66'));
  assert.equal(entryOf(legacyBank()).address, '');
});

test('Remove says when the wallet stays allowed on the chain, and where to stop that', () => {
  const entry = entryOf(wallet());
  const on = removeWords(entry, true);
  assert.match(on, /spending policy/i);
  assert.match(on, /Stop allowing/);
  assert.match(on, /still pay|stays allowed|stay allowed/i);
  const unknown = removeWords(entry, null);
  assert.match(unknown, /Stop allowing/, 'when the policy could not be read, it says what to check');
  const off = removeWords(entry, false);
  assert.doesNotMatch(off, /Stop allowing/);
  assert.match(off, /taken off your list/);
  assert.doesNotMatch(removeWords(entryOf(legacyBank()), null), /Stop allowing/, 'a bank entry is never on the wallet policy');
});

test('the Remove step offers the way to Stop allowing in Settings', () => {
  const card = code(read('components/recipients/RecipientCard.tsx'));
  assert.match(card, /removeWords\(/);
  assert.match(card, /\/dashboard\/settings#policy/);
  const page = code(read('components/recipients/RecipientsPage.tsx'));
  assert.match(page, /\/api\/wallet\/spending-rules/, 'the page reads the policy to know which recipients are on it');
  assert.match(page, /policyHolds\(/);
});

/* Recipients: Approve ------------------------------------------------------------- */

test('Approve is offered only once the address has been screened clean, and for a wallet once it is proven', () => {
  const unscreened = entryOf(wallet({ approvedAt: null, screeningVerdict: null }));
  assert.equal(actionsFor(unscreened, 'OWNER').includes('approve'), false);
  const failed = entryOf(wallet({ approvedAt: null, screeningVerdict: 'ERROR' }));
  assert.equal(actionsFor(failed, 'OWNER').includes('approve'), false);
  const unproven = entryOf(wallet({ approvedAt: null, delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } }));
  assert.equal(actionsFor(unproven, 'OWNER').includes('approve'), false);
  assert.equal(actionsFor(entryOf(exchange({ approvedAt: null })), 'OWNER').includes('approve'), true);
  assert.equal(actionsFor(entryOf(wallet({ approvedAt: null })), 'OWNER').includes('approve'), true);
});

test('approving for payment asks first, with the whole address, the name, the type and the screening', () => {
  const card = code(read('components/recipients/RecipientCard.tsx'));
  assert.match(card, /'approve'/);
  assert.match(card, /confirming === 'approve'/);
  assert.match(card, /<Address value=\{entry\.address\}/);
  assert.match(card, /CopyButton value=\{entry\.address\}/);
  assert.match(card, /Screening/);
  // It is no longer a single press: Approve opens the step, it does not post.
  assert.match(card, /if \(action === 'remove' \|\| action === 'withdraw_proof' \|\| action === 'approve'\) setConfirming/);
});

/* Recipients: smaller ------------------------------------------------------------- */

test('an older bank entry is not called verified, whatever its business check says', () => {
  for (const kybStatus of ['full', 'none']) {
    const s = stateOf(legacyBank({ kybStatus }));
    assert.notEqual(s.tone, 'ok', 'it cannot be paid, so it is not a success');
    assert.doesNotMatch(s.label, /^(Business )?verified/i);
  }
});

test('staff are not offered a proof link when no email is on file for the supplier', () => {
  const noEmail = entryOf(wallet({ hasEmail: false, delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } }));
  assert.equal(actionsFor(noEmail, 'MAKER').includes('send_proof'), false);
  assert.equal(actionsFor(noEmail, 'OWNER').includes('send_proof'), true, 'an owner is shown the link to pass on');
  const withEmail = entryOf(wallet({ delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' } }));
  assert.equal(actionsFor(withEmail, 'MAKER').includes('send_proof'), true);
});

test('sending the proof link again says that the earlier one stops working', () => {
  assert.match(code(read('components/recipients/RecipientCard.tsx')), /earlier link stops working|replaces the (earlier|last|previous) link/i);
});

test('two Splash businesses with the same name but different wallets are two rows', () => {
  const t = (id, masked) => ({ id, paymentRef: id, payeeKind: 'splash_business', payeeName: 'Kopi Works', payeeMasked: masked, payeeCountry: 'MY', createdAt: `2026-10-0${id.slice(1)}T00:00:00Z`, status: 'settled' });
  const rows = buildEntries({ saved: [], beneficiaries: [], transfers: [t('t1', '0x1111…aaaa'), t('t2', '0x2222…bbbb'), t('t3', '0x1111…aaaa')] });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.subtitle.startsWith('2 payments')));
});

test('filters are toggle buttons, not radio buttons without radio keys, and the actions are 44px tall', () => {
  for (const file of ['components/recipients/RecipientsPage.tsx', 'components/history/HistoryPage.tsx']) {
    const src = code(read(file));
    assert.doesNotMatch(src, /role="radiogroup"|role="radio"/, file);
    assert.match(src, /aria-pressed=\{on\}/, file);
    assert.match(src, /min-h-11/, file);
  }
  const card = code(read('components/recipients/RecipientCard.tsx'));
  assert.doesNotMatch(card, /!h-10/, 'an action button is at least 44px tall');
});

test('the spend bar is dark enough to see against its track', () => {
  const rules = code(read('components/settings/RulesSection.tsx'));
  assert.doesNotMatch(rules, /bg-\[#5C9EAD\]/);
  assert.match(rules, /role="progressbar"[\s\S]*bg-\[#0d6370\]/);
});

/* History --------------------------------------------------------------------------- */

const ok = (items) => ({ ok: true, status: 200, items });
const bad = (status = 502) => ({ ok: false, status, items: [] });
const T = { id: 't1', paymentRef: 'p1', status: 'on_the_way', payeeKind: 'splash_business', payeeName: 'Kopi Works', payeeMasked: null, payeeCountry: 'MY', amountMinor: '1000000', reference: null, createdAt: '2026-10-05T00:00:00Z' };
const B = { id: 'b1', label: null, status: 'settled', rowCount: 3, totalMinor: '3000000', createdAt: '2026-10-04T00:00:00Z' };
const W = { id: 'w1', status: 'paid_out', destination: { label: 'Maybank', last4: '1234' }, amountMinor: '500000', currency: 'MYR', createdAt: '2026-10-03T00:00:00Z' };

test('one list that fails is named, and the rest is still shown', () => {
  const merged = mergeLists(null, { transfers: bad(502), batches: ok([B]), withdrawals: ok([]), earlier: ok([]) });
  assert.deepEqual(merged.failed, ['payments']);
  assert.equal(merged.lists.batches.length, 1);
  assert.equal(failureNote(merged.failed, merged.missing), 'Payments could not be loaded, so they are missing from the counts and the list below.');
});

test('a failed refresh keeps what was loaded before, so a payment in progress does not vanish', () => {
  const first = mergeLists(null, { transfers: ok([T]), batches: ok([B]), withdrawals: ok([W]), earlier: ok([]) });
  assert.deepEqual(first.failed, []);
  const again = mergeLists(first.lists, { transfers: bad(500), batches: ok([B]), withdrawals: ok([W]), earlier: ok([]) });
  assert.deepEqual(again.lists.transfers, [T], 'the list that failed keeps its earlier rows');
  assert.deepEqual(again.failed, ['payments']);
  const down = mergeLists(first.lists, { transfers: bad(), batches: bad(), withdrawals: bad(), earlier: bad(429) });
  assert.equal(down.lists, first.lists, 'when everything fails the earlier lists stay');
  assert.equal(down.failed.length, 4);
  assert.match(failureNote(down.failed, down.missing), /could not be refreshed/i);
});

test('when nothing has ever loaded and every list fails, there is no list at all', () => {
  const merged = mergeLists(null, { transfers: bad(), batches: bad(), withdrawals: bad(), earlier: bad() });
  assert.equal(merged.lists, null);
});

test('a viewer’s 403 is not a failure: the page says what they cannot see', () => {
  const merged = mergeLists(null, { transfers: bad(403), batches: bad(403), withdrawals: ok([W]), earlier: ok([]) });
  assert.deepEqual(merged.failed, []);
  assert.equal(merged.lists.restricted, true);
  assert.equal(merged.lists.withdrawals.length, 1);
});

test('the empty-state sentence is shown only when every list answered', () => {
  const page = code(read('components/history/HistoryPage.tsx'));
  assert.match(page, /mergeLists\(/);
  assert.match(page, /failureNote\(/);
  assert.match(page, /entries\.length === 0 && failed \? null/, 'with nothing shown and a list missing, the page says what failed and not that there is nothing');
});

test('a viewer is not given a receipt link they cannot open, and is told why', () => {
  const rows = buildHistory({ transfers: [], batches: [], withdrawals: [W], earlier: [], restricted: true });
  assert.equal(rows[0].href, null);
  assert.match(rows[0].noReceipt, /owner or a staff member/);
  const open = buildHistory({ transfers: [], batches: [], withdrawals: [W], earlier: [], restricted: false });
  assert.match(open[0].href, /\/dashboard\/history\//);
  assert.equal(open[0].noReceipt, null);
  assert.match(code(read('components/history/HistoryPage.tsx')), /but not open their receipts|cannot open their receipts/);
});

/* Settings ------------------------------------------------------------------------- */

test('the Settings privacy line is built from what Zeke’s own disclosure says it stores', () => {
  const line = ABOUT.find((a) => a.label === 'Records and privacy').text;
  const lower = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  for (const stored of MEMWAL_STORED) assert.ok(line.includes(lower(stored.label)), `names: ${stored.label}`);
  for (const never of MEMWAL_NEVER_STORED) assert.ok(line.includes(lower(never)), `says never: ${never}`);
  assert.doesNotMatch(line, /never balances or recipients/);
});

test('a load that has no address yet is loading, not a finished empty answer', () => {
  assert.deepEqual(loadView({ url: null, data: null, error: null }, 'https://x/y'), { data: null, error: null, loading: true });
  assert.equal(loadView({ url: 'https://x/y', data: { a: 1 }, error: null }, 'https://x/y').loading, false);
  assert.deepEqual(loadView({ url: 'https://x/old', data: { a: 1 }, error: null }, 'https://x/new'), { data: null, error: null, loading: true });
  assert.equal(loadView({ url: null, data: null, error: null }, null).loading, false, 'a load that is switched off is not loading');
  const parts = code(read('components/wallet/parts.tsx'));
  assert.match(parts, /loadView\(/);
  const team = code(read('components/settings/TeamCard.tsx'));
  assert.match(team, /!people\.data && !people\.error|!team\.data && !team\.error|team\.data === null && team\.error === null/);
});

test('changing a rule starts from the end date it has now', () => {
  const day = 86_400_000;
  assert.equal(expiryField(String(Date.UTC(2027, 0, 15) + day), new Date('2026-10-31T00:00:00Z')), '2027-01-15');
  assert.equal(expiryField(null, new Date('2026-10-31T00:00:00Z')), undefined);
  assert.equal(expiryField(String(Date.UTC(2026, 0, 15) + day), new Date('2026-10-31T00:00:00Z')), undefined, 'an end date already past is not kept');
  const rules = code(read('components/settings/RulesSection.tsx'));
  // The Change sheet opens from the rule read as a whole (a bridge's end date is not the rule's).
  assert.match(rules, /changeInitial\(raw, now\)/);
  assert.match(read('lib/team-rules/terms.ts'), /expiryField\(t\.expiresAtMs, now\)/);
});

test('only an owner or a finance admin sees editable operating controls', () => {
  assert.equal(canEditControls('OWNER'), true);
  assert.equal(canEditControls('FINANCE_ADMIN'), true);
  for (const role of ['MAKER', 'APPROVER', 'VIEWER', undefined, '']) assert.equal(canEditControls(role), false, String(role));
  assert.match(CONTROLS_SCOPE_NOTE, /spending policy/i);
  assert.match(CONTROLS_SCOPE_NOTE, /USDC/);
  const controls = code(read('components/settings/OperatingControls.tsx'));
  assert.match(controls, /editable/);
  assert.match(controls, /CONTROLS_SCOPE_NOTE/);
  assert.match(code(read('components/settings/SettingsPage.tsx')), /canEditControls\(/);
});

test('the near-threshold condition is said once: the alert cards replace the line above them', () => {
  const view = { reissueNeeded: false, nearThreshold: [{}] };
  assert.equal(housekeeping(view).some((a) => a.id === 'near_threshold'), true);
  assert.equal(housekeeping(view, { alertsShown: true }).some((a) => a.id === 'near_threshold'), false);
  assert.match(code(read('components/settings/RulesSection.tsx')), /alertsShown/);
});

test('the policy copy does not promise a check the add-recipient route does not make', () => {
  const policy = code(read('components/settings/PolicyCard.tsx'));
  assert.doesNotMatch(policy, /can be allowed/);
  assert.match(policy, /only while/);
});

test('the Setup rail marks the optional step as optional', () => {
  assert.match(code(read('components/onboarding/SetupStepper.tsx')), /'Optional'/);
});

/* Server log ------------------------------------------------------------------------ */

test('a refusal is logged once per business in a while, and never with an address in it', () => {
  const t0 = 1_000_000;
  const first = refusalLogLine('org_1', 'RPC https://fullnode.example.io:443/key=abc refused', t0);
  assert.match(first, /org_1/);
  assert.doesNotMatch(first, /https?:|fullnode|key=abc/);
  assert.equal(refusalLogLine('org_1', 'RPC https://fullnode.example.io:443/key=abc refused', t0 + 1000), null, 'the same business, a moment later');
  assert.match(refusalLogLine('org_2', 'x', t0 + 1000), /org_2/, 'another business is its own line');
  assert.match(refusalLogLine('org_1', 'x', t0 + 11 * 60_000), /org_1/, 'and again after the interval');
  assert.match(code(read('lib/server/wallet-route.ts')), /refusalLogLine\(/);
  assert.match(code(read('lib/server/bill-payment-flow-live.ts')), /refusalLogLine\(/);
});

test('a read-only switch stays readable: it is marked aria-disabled, not dimmed to half by the disabled attribute', () => {
  const controls = code(read('components/settings/OperatingControls.tsx'));
  assert.match(controls, /aria-disabled=\{disabled\}/);
  assert.doesNotMatch(controls, /role="switch"[^>]*\sdisabled=\{disabled\}/);
});

/* The pages around them: adding a recipient and the receipts ----------------------- */

test('adding a recipient uses toggle buttons and a 44px Close, as the other filters do', () => {
  const src = code(read('components/recipients/NewRecipient.tsx'));
  assert.doesNotMatch(src, /role="radiogroup"|role="radio"/);
  assert.match(src, /aria-pressed=\{on\}/);
  assert.doesNotMatch(src, /!h-10/);
});

test('a receipt that cannot be read can be asked for again, and one not yet final is not polled from a hidden tab', () => {
  const single = code(read('components/transfer/StepReceipt.tsx'));
  assert.match(single, /visibilityState === 'visible'/);
  assert.match(single, /Try again/);
  assert.doesNotMatch(single, /Add the country in Recipients/, 'Recipients has no way to edit a country, so the copy does not send a person there');
  const batch = code(read('components/batch/StepReceipts.tsx'));
  assert.match(batch, /Try again/);
  assert.match(batch, /Check again/);
});
