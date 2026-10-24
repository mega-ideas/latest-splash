import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildZekeDeskSnapshot,
  deskSubtitle,
  firstNameOf,
  zekeGreeting,
} from '../lib/agent/zeke-desk.ts';

/**
 * v2 brief 5.3: the Zeke page, the floating Zeke and /queue.
 *
 * The page and the widget now open with real numbers about the reader's own
 * workspace: how many payments wait for a decision, when the soonest window
 * closes, what Zeke prepared lately. Those numbers come from one server
 * snapshot, built from the proposal store for the session's workspace only.
 * The store holds every tenant's proposals, so the first thing tested is that
 * nobody else's ever reach the count.
 */

const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const source = async (file) => code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

const NOW = new Date('2026-10-25T09:00:00Z');
const minutes = (n) => new Date(NOW.getTime() + n * 60_000).toISOString();

function proposal(overrides = {}) {
  return {
    id: 'prop_1',
    orgId: 'org_acme',
    status: 'PENDING_APPROVAL',
    kind: 'PAYMENT',
    createdBy: 'OXWAL',
    createdAt: minutes(-30),
    expiresAt: minutes(60 * 20),
    approvals: [],
    explain: { recommendation: 'Pay Luzon Components for INV-0142', requiredApprovers: 1 },
    ...overrides,
  };
}

// ── The snapshot ────────────────────────────────────────────────────────────

test('another workspace’s proposals never reach the count, the drafts or the recent list', () => {
  const snapshot = buildZekeDeskSnapshot({
    proposals: [
      proposal({ id: 'mine' }),
      proposal({ id: 'theirs_1', orgId: 'org_other' }),
      proposal({ id: 'theirs_2', orgId: 'org_other', status: 'SETTLED' }),
    ],
    orgId: 'org_acme',
    now: NOW,
    displayName: 'Nadia Rahman',
  });
  assert.equal(snapshot.known, true);
  assert.equal(snapshot.waiting, 1);
  assert.equal(snapshot.drafts, 1);
  assert.deepEqual(snapshot.recent.map((item) => item.id), ['mine']);
});

test('no workspace means nothing is known, and nothing is counted', () => {
  const snapshot = buildZekeDeskSnapshot({ proposals: [proposal()], orgId: null, now: NOW, displayName: 'Nadia' });
  assert.equal(snapshot.known, false);
  assert.equal(snapshot.waiting, 0);
  assert.equal(snapshot.drafts, 0);
  assert.equal(snapshot.soonestCloseMs, null);
  assert.deepEqual(snapshot.recent, []);
  // Not even a blank org id matches a proposal stored without one.
  const blank = buildZekeDeskSnapshot({ proposals: [proposal({ orgId: '' })], orgId: '', now: NOW, displayName: null });
  assert.equal(blank.known, false);
  assert.equal(blank.waiting, 0);
});

test('waiting counts open proposals from every maker; drafts are only the ones Zeke prepared', () => {
  const snapshot = buildZekeDeskSnapshot({
    proposals: [
      proposal({ id: 'zeke_open' }),
      proposal({ id: 'staff_open', createdBy: 'usr_ben' }),
      proposal({ id: 'simulated', status: 'SIMULATED' }),
      proposal({ id: 'lapsed', expiresAt: minutes(-1) }),
      proposal({ id: 'approved', status: 'APPROVED' }),
      proposal({ id: 'settled', status: 'SETTLED' }),
    ],
    orgId: 'org_acme',
    now: NOW,
    displayName: null,
  });
  assert.equal(snapshot.waiting, 3, 'zeke_open, staff_open and simulated; a lapsed window is not waiting');
  assert.equal(snapshot.drafts, 2, 'zeke_open and simulated');
});

test('the soonest window is measured from now, and only over what is still open', () => {
  const snapshot = buildZekeDeskSnapshot({
    proposals: [
      proposal({ id: 'a', expiresAt: minutes(45) }),
      proposal({ id: 'b', expiresAt: minutes(3) }),
      proposal({ id: 'gone', expiresAt: minutes(-5) }),
      proposal({ id: 'done', status: 'SETTLED', expiresAt: minutes(1) }),
    ],
    orgId: 'org_acme',
    now: NOW,
    displayName: null,
  });
  assert.equal(snapshot.soonestCloseMs, 3 * 60_000);
});

test('recent is what Zeke prepared, newest first, three at most, each with where it stands', () => {
  const rows = [
    proposal({ id: 'old', createdAt: minutes(-600), status: 'SETTLED' }),
    proposal({ id: 'newest', createdAt: minutes(-1) }),
    proposal({ id: 'staff', createdAt: minutes(-2), createdBy: 'usr_ben' }),
    proposal({ id: 'rejected', createdAt: minutes(-3), status: 'REJECTED' }),
    proposal({ id: 'lapsed', createdAt: minutes(-4), expiresAt: minutes(-1) }),
  ];
  const snapshot = buildZekeDeskSnapshot({ proposals: rows, orgId: 'org_acme', now: NOW, displayName: null });
  assert.deepEqual(snapshot.recent.map((item) => [item.id, item.state, item.label]), [
    ['newest', 'waiting', 'Waiting for approval'],
    ['rejected', 'rejected', 'Rejected'],
    ['lapsed', 'expired', 'Expired'],
  ]);
  assert.equal(snapshot.recent[0].title, 'Pay Luzon Components for INV-0142');

  const states = (status) =>
    buildZekeDeskSnapshot({ proposals: [proposal({ status })], orgId: 'org_acme', now: NOW, displayName: null }).recent[0].label;
  assert.equal(states('SETTLED'), 'Sent');
  assert.equal(states('SUBMITTED'), 'Sent');
  assert.equal(states('APPROVED'), 'Approved, not sent');
  assert.equal(states('FAILED'), 'Not sent');
});

test('the snapshot carries labels and counts only: no amounts, payees’ accounts or transaction bytes', () => {
  const snapshot = buildZekeDeskSnapshot({
    proposals: [proposal({ unsignedTxBytes: 'dW5zaWduZWQ=', approvalHash: 'hash_1' })],
    orgId: 'org_acme',
    now: NOW,
    displayName: 'Nadia',
  });
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, /dW5zaWduZWQ=|hash_1|org_acme|unsignedTxBytes/);
});

test('the first name is the first word of the display name, and never an email address', () => {
  assert.equal(firstNameOf('Nadia Rahman'), 'Nadia');
  assert.equal(firstNameOf('  Priya  '), 'Priya');
  assert.equal(firstNameOf('nadia@acme.test'), null);
  assert.equal(firstNameOf(''), null);
  assert.equal(firstNameOf(undefined), null);
  assert.equal(firstNameOf('A'.repeat(60)), null, 'a name that long is not a first name');
});

// ── What the page and the widget say ────────────────────────────────────────

const snap = (overrides = {}) => ({ known: true, firstName: 'Nadia', waiting: 0, drafts: 0, soonestCloseMs: null, recent: [], ...overrides });

test('the floating greeting says what is waiting, and when the soonest closes, from the snapshot', () => {
  assert.equal(
    zekeGreeting(snap({ waiting: 2, soonestCloseMs: 3 * 60_000 })),
    'Hi Nadia. 2 payments are waiting for approval, and one closes in 3 minutes. What would you like to look at?',
  );
  assert.equal(
    zekeGreeting(snap({ waiting: 1, soonestCloseMs: 5 * 60 * 60_000 })),
    'Hi Nadia. 1 payment is waiting for approval. What would you like to look at?',
  );
  assert.equal(zekeGreeting(snap()), 'Hi Nadia. Nothing is waiting for your approval. What would you like to look at?');
  assert.equal(zekeGreeting(snap({ firstName: null, waiting: 1, soonestCloseMs: 60_000 })), 'Hi. 1 payment is waiting for approval, and it closes in 1 minute. What would you like to look at?');
});

test('with no snapshot the greeting states no number at all', () => {
  assert.equal(zekeGreeting(null), 'Hi. What would you like to look at?');
  assert.equal(zekeGreeting(snap({ known: false, waiting: 0 })), 'Hi Nadia. What would you like to look at?');
});

test('the page line under the question states the queue and the wallet only when they were read', () => {
  assert.equal(
    deskSubtitle(snap({ waiting: 2 }), '48,250.00'),
    '2 payments are waiting for approval. Your wallet holds 48,250.00 USDC.',
  );
  assert.equal(deskSubtitle(snap({ waiting: 0 }), null), 'Nothing is waiting for your approval.');
  assert.equal(deskSubtitle(null, '10.00'), 'Your wallet holds 10.00 USDC.');
  assert.equal(deskSubtitle(null, null), 'Ask about your money, prepare a payment for approval, or check what needs a decision.');
});

// ── The route ───────────────────────────────────────────────────────────────

test('the desk snapshot route is signed-in, scoped to the session’s workspace and never cached', async () => {
  const route = await source('app/api/oxwal/desk/route.ts');
  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /await requireCustomerRequest\(request\)/);
  assert.match(route, /if \(auth\.response\) return auth\.response;/);
  assert.match(route, /await requireSessionAccount\(auth\.session\)/);
  assert.match(route, /orgId: account\.orgId/);
  assert.match(route, /ensureProposalStoreHydrated\(/);
  assert.match(route, /'Cache-Control': 'no-store'/);
  // The workspace comes from the session and nowhere else.
  assert.doesNotMatch(route, /searchParams|request\.json\(\)|headers\.get\('x-org/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, 'a read, nothing else');
});

// ── The floating Zeke (board "Floating Zeke") ───────────────────────────────

test('the floating Zeke opens with a greeting whose chips are inside the first message', async () => {
  const floating = await source('components/FloatingCopilot.tsx');
  assert.doesNotMatch(floating, /Reads state · prepares proposals · cannot send/);
  assert.match(floating, /<ZekeGreeting/);
  // The greeting is the first row of the conversation, not a row above it.
  const threadAt = floating.indexOf('ref={threadRef}');
  const greetingAt = floating.indexOf('<ZekeGreeting');
  const rowsAt = floating.indexOf('thread.map(');
  assert.ok(threadAt > 0 && threadAt < greetingAt && greetingAt < rowsAt);
  // No fixed chip row under the composer.
  assert.match(floating, /chips=\{\[\]\}/);
  for (const label of ['Approvals', 'Balances', 'Receipts', 'Treasury']) {
    assert.match(floating, new RegExp(`label: '${label}'`));
  }
  assert.match(floating, /useZekeDesk\(/);
  assert.match(floating, /zekeGreeting\(/);
  // Still no approving from a floating panel, and the AI marker stays.
  assert.match(floating, /allowInlineApproval: false/);
  assert.match(floating, /<Sparkles size=\{9\} \/> AI/);

  const greeting = await source('components/oxwal/ZekeGreeting.tsx');
  assert.match(greeting, /BotAvatar/);
  assert.match(greeting, /chips\.map\(/);
});

test('the desk snapshot hook reads the route and treats a refusal as unknown, not as zero', async () => {
  const hook = await source('lib/oxwal/use-zeke-desk.ts');
  assert.match(hook, /fetch\('\/api\/oxwal\/desk'/);
  assert.match(hook, /cache: 'no-store'/);
  assert.match(hook, /if \(!response\.ok\)/);
  assert.match(hook, /setSnapshot\(null\)/);
});

// ── The Zeke page (boards "Zeke page · start" and "asking to pay") ─────────

test('the Zeke page has the larger composer with "Zeke can see", starter cards and recent work', async () => {
  const page = await source('app/dashboard/zeke/page.tsx');
  assert.match(page, /variant="desk"/);
  assert.match(page, /canSee=\{/);
  for (const can of ['Wallet', 'Recipients', 'Invoices', 'Treasury']) assert.match(page, new RegExp(`'${can}'`));
  for (const starter of ['Review an invoice', 'Prepare a payment', 'Build a batch', 'Plan idle cash']) {
    assert.match(page, new RegExp(starter));
  }
  assert.match(page, /Review my latest invoice/);
  assert.match(page, /<ZekeRecent /);
  assert.match(page, /deskSubtitle\(/);
  assert.match(page, /useZekeDesk\(/);
  // In a conversation, the reply composer and a way to start over.
  assert.match(page, /variant="reply"/);
  assert.match(page, /New conversation/);
  assert.match(page, /resetThread/);

  const composer = await source('components/oxwal/OxWalComposer.tsx');
  assert.match(composer, /variant\?: 'bar' \| 'desk' \| 'reply'/);
  assert.match(composer, /<textarea/);
  assert.match(composer, /Zeke can see/);
  assert.match(composer, /Ask Zeke/);
});

test('the Zeke page’s side column: remembers, can do, approvals, what MemWal stores and quick links', async () => {
  const page = await source('app/dashboard/zeke/page.tsx');
  const cards = await source('components/oxwal/ZekeDeskCards.tsx');
  for (const name of ['<MemWalBehaviorCard', '<ZekeCanDo', '<ZekeApprovals', '<MemWalStores', '<ZekeQuickLinks']) {
    assert.match(page, new RegExp(name));
  }
  assert.match(cards, /What Zeke can do/);
  assert.match(cards, /Approve or send money/);
  assert.match(cards, /Never/);
  assert.match(cards, /What MemWal stores/);
  assert.match(cards, /Never stored/);
  assert.match(cards, /href="\/queue"/);
  assert.match(cards, /Open approvals/);
  for (const href of ['/dashboard/batch', '/dashboard/treasury', '/dashboard/history']) {
    assert.match(cards, new RegExp(`href: '${href}'`));
  }
  // The approvals card is the snapshot's count, never a typed number.
  assert.match(cards, /snapshot\.waiting/);
  // Recent work shows an empty state that says what fills it.
  assert.match(cards, /Nothing yet/);
});

test('Zeke’s identity accents are teal; gold stays for actions and coral is gone', async () => {
  for (const file of ['app/dashboard/zeke/page.tsx', 'components/oxwal/ZekeDeskCards.tsx', 'components/oxwal/ZekeGreeting.tsx', 'components/FloatingCopilot.tsx']) {
    const text = await source(file);
    assert.doesNotMatch(text, /E39774|coral/i, `${file} uses coral`);
    assert.doesNotMatch(text, /#9A4A2D/i, `${file} uses the old coral ink`);
  }
  const page = await source('app/dashboard/zeke/page.tsx');
  assert.match(page, /Zeke online/i);
  assert.match(page, /bg-\[#0d6370\]/, 'the online chip is teal');
});

// ── /queue ──────────────────────────────────────────────────────────────────

test('/queue: the code card, then "Waiting for your decision", with the examples last and collapsed', async () => {
  const page = await source('app/queue/page.tsx');
  const cardAt = page.indexOf('<ApprovalCodeCard');
  const boardAt = page.indexOf('<ApprovalQueueBoard');
  const readyAt = page.indexOf('<ReadyToSendLane');
  const examplesAt = page.indexOf('<QueueExamples');
  assert.ok(cardAt > 0 && cardAt < boardAt && boardAt < readyAt && readyAt < examplesAt);

  const board = await source('components/queue/ApprovalQueueBoard.tsx');
  assert.doesNotMatch(board, /examples/i, 'the live board carries no examples');

  const examples = await source('components/queue/QueueExamples.tsx');
  assert.match(examples, /<details/);
  assert.doesNotMatch(examples, /<details[^>]*\bopen\b/, 'collapsed by default');
  assert.match(examples, /Examples \(not your payments\)/);
  // Lanes as compact cards, and nothing in them can be approved.
  assert.match(examples, /grid-cols-2/);
  assert.doesNotMatch(examples, /decide\(|Approve<|submitPath/);
});
