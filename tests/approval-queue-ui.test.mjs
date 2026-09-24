import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { readyToSend } from '../lib/queue/ready-to-send.ts';

/**
 * The approval channels had a server and no way in.
 *
 * `code` is the default channel and its WhatsApp message says "Enter it in
 * Splash to approve" — and nothing in the product posted to
 * /api/approvals/code. A unanimous WhatsApp reply stops at APPROVED, because a
 * reply cannot send money, and /queue listed only proposals still collecting
 * approvals, so a fully approved payment vanished at the moment a signed-in
 * approver had to send it.
 */

const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const source = async (file) => code(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

// ── What "ready to send" contains ───────────────────────────────────────────

const NOW = new Date('2026-09-24T12:00:00Z');

function approved(overrides = {}) {
  return {
    id: overrides.id ?? 'prop_ready',
    orgId: 'acme',
    status: 'APPROVED',
    kind: 'PAYMENT',
    createdBy: 'usr_ben',
    expiresAt: '2026-09-25T06:00:00Z',
    approvals: [
      { userId: 'usr_priya', role: 'APPROVER', signedAt: NOW.toISOString() },
      { userId: 'usr_nadia', role: 'OWNER', signedAt: NOW.toISOString() },
    ],
    explain: { recommendation: 'Pay 25000 USD to Manila Parts Supply in PHP.', requiredApprovers: 2 },
    ...overrides,
  };
}

const priya = { orgId: 'acme', userId: 'usr_priya', role: 'APPROVER' };

test('ready to send is the approved, unsent payments of the viewer’s own workspace', () => {
  const proposals = [
    approved({ id: 'prop_late', expiresAt: '2026-09-25T09:00:00Z' }),
    approved({ id: 'prop_soon', expiresAt: '2026-09-24T18:00:00Z' }),
    // Another tenant's approved payment: never listed, never hinted at.
    approved({ id: 'prop_northwind', orgId: 'northwind' }),
    // Still collecting, already sent, or closed: other lanes, or none.
    approved({ id: 'prop_pending', status: 'PENDING_APPROVAL' }),
    approved({ id: 'prop_submitted', status: 'SUBMITTED' }),
    approved({ id: 'prop_rejected', status: 'REJECTED' }),
  ];
  const ready = readyToSend(proposals, priya, NOW);
  assert.deepEqual(ready.map((r) => r.proposal.id), ['prop_soon', 'prop_late'], 'soonest to expire first');
  assert.ok(ready.every((r) => r.blockedReason === null));

  // No membership means no workspace, and nothing to show.
  assert.deepEqual(readyToSend(proposals, null, NOW), []);
});

test('it says in advance who cannot send, as the release rule will', () => {
  const [mine] = readyToSend([approved()], { orgId: 'acme', userId: 'usr_ben', role: 'OWNER' }, NOW);
  assert.equal(mine.blockedReason, 'You asked for this payment, so another approver sends it.');

  for (const role of ['VIEWER', 'MAKER']) {
    const [row] = readyToSend([approved()], { orgId: 'acme', userId: 'usr_tom', role }, NOW);
    assert.equal(row.blockedReason, 'Only an approver can send it.', role);
  }
  const [finance] = readyToSend([approved()], { orgId: 'acme', userId: 'usr_fin', role: 'FINANCE_ADMIN' }, NOW);
  assert.equal(finance.blockedReason, null, 'a finance admin may send');

  const [expired] = readyToSend([approved({ expiresAt: '2026-09-24T11:59:00Z' })], priya, NOW);
  assert.equal(expired.blockedReason, 'Its approval window has closed, so it has to be requested again.');
});

// ── The code entry ──────────────────────────────────────────────────────────

test('the code card posts the code in the body to the code route, never in a URL', async () => {
  const card = await source('components/queue/ApprovalCodeCard.tsx');
  assert.match(card, /^'use client';/);
  assert.match(
    card,
    /fetch\('\/api\/approvals\/code', \{\s*method: 'POST',\s*headers: \{ 'Content-Type': 'application\/json' \},\s*body: JSON\.stringify\(\{ code: digits, decision \}\),/,
  );
  assert.equal(card.match(/fetch\(/g).length, 1, 'one request, to one route');
  assert.doesNotMatch(card, /\?code=|searchParams|localStorage|sessionStorage/, 'a code is never stored or put in a URL');
});

test('the code card offers both answers, confirms a rejection, and shows what the server said', async () => {
  const card = await source('components/queue/ApprovalCodeCard.tsx');
  assert.match(card, /void answer\('APPROVE'\)/);
  assert.match(card, /void answer\('REJECT'\)/);
  // One rejection stops it for everyone and cannot be undone, so it asks.
  const rejectAt = card.indexOf("decision === 'REJECT' &&");
  const confirmAt = card.indexOf('window.confirm(', rejectAt);
  const fetchAt = card.indexOf("fetch('/api/approvals/code'");
  assert.ok(rejectAt > 0 && confirmAt > rejectAt && confirmAt < fetchAt, 'confirmed before anything is sent');

  // The server's own words, and the vote as it stands.
  assert.match(card, /message: body\.message \?\? 'Recorded\.'/);
  assert.match(card, /tally: body\.tally/);
  assert.match(card, /<TallyMarks tally=\{result\.tally\} \/>/);
  assert.match(card, /if \(body\?\.error\) return sentence\(body\.error\);/);
  // A vote can move a payment into Ready to send.
  assert.match(card, /router\.refresh\(\)/);
});

test('the code field is labelled, numeric, and quiet while a request is out', async () => {
  const card = await source('components/queue/ApprovalCodeCard.tsx');
  assert.match(card, /<label htmlFor=\{inputId\}/);
  assert.match(card, /inputMode="numeric"/);
  assert.match(card, /autoComplete="one-time-code"/);
  assert.match(card, /aria-describedby=\{helpId\}/);
  assert.match(card, /aria-live="polite"/);
  assert.match(card, /disabled=\{!canAnswer\}/);
  assert.match(card, /const canAnswer = digits\.length >= 4 && busy === null;/);
  // A spent code does not linger in the field.
  assert.match(card, /setCode\(''\)/);
});

// ── Ready to send ───────────────────────────────────────────────────────────

test('Send goes through the submit route, bound to the payment as shown', async () => {
  const lane = await source('components/queue/ReadyToSendLane.tsx');
  assert.match(lane, /^'use client';/);
  assert.match(lane, /fetch\(`\/api\/proposals\/\$\{encodeURIComponent\(item\.id\)\}\/submit`, \{\s*method: 'POST'/);
  assert.match(lane, /signatureRef: `sig_queue_\$\{item\.id\}`/);
  // The canonical hash the page rendered: a proposal changed since is refused.
  assert.match(lane, /item\.approvalHash \? \{ approvalHash: item\.approvalHash \} : \{\}/);
  assert.equal(lane.match(/fetch\(/g).length, 1);

  // Money moves on this click, so it asks first.
  const confirmAt = lane.indexOf('window.confirm(');
  const fetchAt = lane.indexOf('fetch(`/api/proposals/');
  assert.ok(confirmAt > 0 && confirmAt < fetchAt);
  assert.match(lane, /router\.refresh\(\)/);
});

test('Send reports what happened, and is off when this viewer could not send', async () => {
  const lane = await source('components/queue/ReadyToSendLane.tsx');
  // Sent only when the payment route carried it out; anything else is said.
  assert.match(lane, /if \(state === 'EXECUTED'\) return \{ sent: true/);
  assert.match(lane, /Not sent: \$\{detail\}/);
  assert.match(lane, /body\?\.error \?\?/);
  // The reason is shown beside a disabled button, not discovered by a refusal.
  assert.match(lane, /disabled=\{item\.blockedReason !== null \|\| sending !== null\}/);
  assert.match(lane, /aria-describedby=\{item\.blockedReason \? `\$\{item\.id\}-blocked` : undefined\}/);
  assert.match(lane, /aria-live="polite"/);
  // It says why it exists: a reply cannot send.
  assert.match(lane, /A signed-in approver sends it; a WhatsApp reply cannot\./);
});

// ── The queue page ──────────────────────────────────────────────────────────

test('the queue lists ready-to-send for the viewer’s workspace and offers the code entry', async () => {
  const page = await source('app/queue/page.tsx');
  assert.match(page, /const ctx = await resolveAuthorityForSession\(session\);/);
  assert.match(page, /viewer = \{ orgId: ctx\.orgId, userId: ctx\.userId, role: ctx\.role \};/);
  assert.match(page, /if \(!\(error instanceof UnauthorizedError\)\) throw error;/);
  assert.match(page, /readyToSend\(proposalStore\.list\(\), viewer, now\)/);
  assert.match(page, /approvalHash: proposal\.approvalHash \?\? null/);
  assert.match(page, /<ApprovalCodeCard \/>/);
  assert.match(page, /<ReadyToSendLane items=\{readyItems\} \/>/);

  // The code entry and the lane come before the board, where the eye lands.
  const cardAt = page.indexOf('<ApprovalCodeCard />');
  const laneAt = page.indexOf('<ReadyToSendLane');
  const boardAt = page.indexOf('<ApprovalQueueBoard');
  assert.ok(cardAt > 0 && cardAt < laneAt && laneAt < boardAt);
});
