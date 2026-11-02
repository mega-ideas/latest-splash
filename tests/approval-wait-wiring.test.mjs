/**
 * When nobody who can approve answers (v2 Phase 3, p3-no-approver): that everything is wired the way the
 * ladder needs it, and that the words on the screens are the ones Sky asked for. These read the sources
 * and the migration; tests/approval-wait-ladder.test.mjs runs the behaviour on a real database.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const WAIT = read('lib/approve/wait.ts');
const SERVER = read('lib/server/approval-wait.ts');

test('the timing of the ladder is written in one place', () => {
  assert.match(WAIT, /afterMs: 10 \* MINUTE_MS/);
  assert.match(WAIT, /afterMs: HOUR_MS/);
  assert.match(WAIT, /afterMs: 4 \* HOUR_MS/);
  for (const file of ['lib/server/approval-wait.ts', 'app/api/cron/wallet-signing/route.ts', 'app/api/approvals/waiting/route.ts', 'app/api/approvals/waiting/[kind]/[id]/remind/route.ts', 'components/approve/WaitingForOthers.tsx', 'components/team/FewApprovers.tsx']) {
    const code = strip(read(file));
    assert.doesNotMatch(code, /HOUR_MS|4 \* |setTimeout|setInterval/, `${file} has no timing of its own and no timer`);
    assert.doesNotMatch(code, /'reminder_(10m|1h|4h)'/, `${file} does not name a step of the ladder`);
  }
  // No long-lived timer anywhere in the ladder: the existing cron drives it.
  assert.doesNotMatch(strip(SERVER), /setTimeout|setInterval/);
});

test('the existing cron runs the ladder and answers 502 when it could not tell someone', () => {
  const cron = read('app/api/cron/wallet-signing/route.ts');
  assert.match(cron, /sweepApprovalWaitsForStaff/);
  assert.match(cron, /waits\.errors > 0/);
  assert.match(cron, /authorization/i);
  assert.match(cron, /CRON_SECRET/);
});

test('a request made through the live wallet tells its approvers at once, and so does an ask', () => {
  assert.match(read('lib/server/wallet-deps.ts'), /withApprovalLadder\(walletSigningNotifier/);
  assert.match(read('lib/server/wallet-deps.ts'), /approvalWaitNotifier\(db\)\.notify\(input\)/);
  assert.match(read('app/api/wallet/approval-asks/route.ts'), /tellApproversNow\(db, \{ orgId, kind: 'ask', id: ask\.id \}\)/);
  assert.match(read('lib/server/wallet-transfers-deps.ts'), /tellApproversNow\(db, \{ orgId, kind: 'ask', id: ask\.id \}\)/);
});

test('the routes take the business and the person from the session, and ask nothing of the request but which request', () => {
  const routes = ['app/api/approvals/waiting/route.ts', 'app/api/approvals/waiting/[kind]/[id]/remind/route.ts', 'app/api/team/approvers/route.ts'];
  for (const file of routes) {
    const code = strip(read(file));
    assert.match(code, /teamRoute\(request\)/, `${file} opens with the session gate`);
    assert.doesNotMatch(code, /searchParams|request\.json|readJsonBody|body\.org|body\.user|headers\.get\('x-/, `${file} reads nothing from the request`);
  }
  const remind = read('app/api/approvals/waiting/[kind]/[id]/remind/route.ts');
  assert.match(remind, /export async function POST/);
  assert.doesNotMatch(remind, /export async function (GET|PUT|DELETE)/);
  assert.match(remind, /kind !== 'signing' && kind !== 'ask'/);
  assert.match(remind, /Retry-After/);
  const waiting = read('app/api/approvals/waiting/route.ts');
  assert.match(waiting, /export async function GET/);
  assert.doesNotMatch(waiting, /export async function (POST|PUT|DELETE)/);
  const approvers = read('app/api/team/approvers/route.ts');
  assert.match(approvers, /memberRole\(db, orgId, authority\.userId\)\) !== 'admin'/);
  assert.match(approvers, /count: null/);
});

test('Limits and Team show the warning to owners, with a one-tap link that opens the add-a-person form', () => {
  const limits = read('components/settings/LimitsCard.tsx');
  const team = read('components/settings/TeamCard.tsx');
  assert.match(limits, /import FewApprovers from '@\/components\/team\/FewApprovers'/);
  assert.match(limits, /data\.canAsk \? <FewApprovers \/> : null/);
  assert.match(team, /manager === 'owner' \? <FewApprovers \/> : null/);
  assert.match(team, /id="add-person"/);
  const component = read('components/team/FewApprovers.tsx');
  assert.match(component, /href=\{ADD_APPROVER_PATH\}/);
  assert.match(component, /Add another approver/);
  assert.match(component, /role="status"/);
  assert.match(WAIT, /ADD_APPROVER_PATH = '\/dashboard\/settings#add-person'/);
  // It blocks nothing: no disabled state, no gate, and a count is only ever read.
  assert.doesNotMatch(strip(component), /disabled|preventDefault|onClick/);
});

test('the Approve page lists what waits for others, with Remind them now and Cancel this request, and nothing else', () => {
  assert.match(read('components/approve/ApproveInbox.tsx'), /<WaitingForOthers \/>/);
  const card = read('components/approve/WaitingForOthers.tsx');
  assert.match(card, /Remind them now/);
  assert.match(card, /Cancel this request/);
  assert.match(card, /Nobody has answered yet\./);
  // Cancelling is the existing withdraw, for the person who asked only; reminding is the new route.
  assert.match(card, /method: 'DELETE'/);
  assert.match(card, /action: 'withdraw'/);
  assert.match(card, /\/api\/approvals\/waiting\/\$\{item\.kind\}/);
  assert.match(card, /item\.canCancel \? \(/);
  // It confirms before cancelling, and says nothing was paid.
  assert.match(card, /Cancel this request\? Nothing has been paid\./);
  assert.match(card, /aria-live="polite"/);
  // Nothing on this page can approve: it never touches a signature.
  assert.doesNotMatch(strip(card), /signatures|submitPartialSignature|signature/i);
});

test('the lapse sentence is the one Sky asked for, and a late approval gets it', () => {
  assert.match(WAIT, /LAPSE_WORDS = 'Nobody approved in time\. Nothing was paid\. Ask again\.'/);
  assert.match(read('lib/server/wallet-signing.ts'), /fail\(410, 'expired', LAPSE_WORDS\)/);
  assert.match(read('lib/server/wallet-signing.ts'), /closedWords\('request', request\.status\)/);
  assert.match(read('lib/server/payment-approval-asks.ts'), /closedWords\('ask', current\.status\)/);
  assert.match(read('lib/schedule/rules.ts'), /LAPSED_REASON = `\$\{LAPSE_WORDS\} There is no late fee or penalty\.`/);
});

test('nothing in the ladder can approve, sign or pay', () => {
  const code = strip(SERVER);
  assert.doesNotMatch(code, /submitPartialSignature|recordPartialSignature|combine|execute\(|status: 'executed'|walletBatches|settleApprovalAsks|sendWhatsApp/);
  // It only ever closes nothing: no update of a signing request or an ask.
  assert.doesNotMatch(code, /\.update\(walletSigningRequests\)|\.update\(walletApprovalAsks\)|\.update\(walletSigningSigners\)/);
});

test('migration 0087 is journalled and re-lists the trail CHECK in full', () => {
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  assert.ok(journal.entries.some((e) => e.tag === '0087_approval_wait_ladder' && e.idx === 87));
  const files = readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  assert.equal(files[files.length - 1], '0087_approval_wait_ladder.sql', 'the next free number');
  const sql = read('drizzle/0087_approval_wait_ladder.sql');
  const listed = (text) => new Set([...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const check = sql.slice(sql.indexOf('wallet_authority_events_action_check" CHECK'));
  const inMigration = listed(check);
  const union = read('lib/server/wallet-authority.ts');
  const type = union.slice(union.indexOf('export type AuthorityAction'), union.indexOf('export type AuthorityFailure'));
  const inType = new Set([...type.matchAll(/\| '([a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...inType].sort(), [...inMigration].sort(), 'the CHECK and the type name the same actions');
  assert.ok(inMigration.has('approval_lapsed') && inMigration.has('approval_reminded'));
  assert.ok(inMigration.has('limit_request_first_approved') && inMigration.has('member_title_changed'), 'every earlier action is still allowed');
  // Applied migrations are not edited: 0086 still ends its own list the way it did.
  assert.doesNotMatch(read('drizzle/0086_limit_starts_and_two_approvals.sql'), /approval_lapsed/);
});

test('what the screens and notices say follows the copy rules', () => {
  for (const file of ['lib/approve/wait.ts', 'components/approve/WaitingForOthers.tsx', 'components/team/FewApprovers.tsx']) {
    const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(text, /coming soon|\bdemo\b|testnet|non-custodial|licen[cs]ed|coral/i, file);
    assert.doesNotMatch(text, /[–—]/, `${file} has no dash used as punctuation`);
  }
  assert.match(WAIT, /Only \$\{count\} \$\{count === 1 \? 'person' : 'people'\} can approve payments\. If they are all away, payments wait\. Add another approver\./);
});

test('the deploy notes say the one cron carries the ladder', () => {
  const deploy = read('docs/DEPLOY-DIGITALOCEAN.md');
  assert.match(deploy, /wallet-signing/);
  assert.match(deploy, /10 minutes, 1 hour and 4 hours/);
});
