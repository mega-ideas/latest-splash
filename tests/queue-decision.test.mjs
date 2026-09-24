import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  interpretSubmitResponse,
  isFinal,
  kindLabel,
  submitPath,
  submitRequestBody,
} from '../lib/queue/queue-decision.ts';

/**
 * The approval queue's Approve and Reject, made real.
 *
 * They used to change React state and toast "Approved & queued for
 * settlement" without calling the server. The proposal stayed pending and the
 * approver walked away believing the payment had gone. The decision now goes
 * to the submit route, and the approver is told what the server says came of
 * it — and nothing claims a payment went unless the response says it did.
 */

const item = { id: 'prop_abc/1', approvalHash: 'hash_reviewed' };

test('the decision carries what the approver reviewed, and nothing about who they are', () => {
  assert.deepEqual(submitRequestBody(item, 'APPROVE'), {
    signatureRef: 'sig_queue_prop_abc/1',
    decision: 'APPROVE',
    approvalHash: 'hash_reviewed',
  });
  assert.deepEqual(submitRequestBody({ id: 'p2' }, 'REJECT'), { signatureRef: 'sig_queue_p2', decision: 'REJECT' });
  for (const field of ['userId', 'role', 'orgId', 'signedBy']) {
    assert.equal(field in submitRequestBody(item, 'APPROVE'), false, `${field} is the server's to derive`);
  }
  assert.equal(submitPath('prop_abc/1'), '/api/proposals/prop_abc%2F1/submit');
});

test('"sent" only when the server executed it', () => {
  const sent = interpretSubmitResponse(200, {
    execution: { state: 'EXECUTED', detail: 'Payment sent.', ref: 'ti_42' },
  }, 'APPROVE');
  assert.deepEqual(sent, { kind: 'executed', message: 'Approved. Payment sent.', ref: 'ti_42' });

  const failed = interpretSubmitResponse(200, {
    execution: { state: 'FAILED', detail: 'Splash balance is insufficient for this payment source' },
  }, 'APPROVE');
  assert.equal(failed.kind, 'approved-not-sent');
  assert.match(failed.message, /did not go: Splash balance is insufficient/);

  const skipped = interpretSubmitResponse(200, {
    execution: { state: 'SKIPPED', detail: 'Approved and recorded — not paid. x402 settlement is not available.' },
  }, 'APPROVE');
  assert.equal(skipped.kind, 'approved-not-sent');
  assert.match(skipped.message, /not paid/);

  // A 200 with no execution record is not a payment that went.
  const silent = interpretSubmitResponse(200, { proposal: {} }, 'APPROVE');
  assert.equal(silent.kind, 'approved-not-sent');
  assert.doesNotMatch(silent.message, /sent\.$/);
});

test('a rejection says the payment went back and nothing was sent', () => {
  const outcome = interpretSubmitResponse(200, { proposal: { status: 'REJECTED' } }, 'REJECT');
  assert.equal(outcome.kind, 'rejected');
  assert.match(outcome.message, /nothing was sent/);
});

test('one signature of two: recorded, with the count the server holds', () => {
  const outcome = interpretSubmitResponse(409, {
    error: 'Your approval is recorded — a second approver must sign from the queue before this settles.',
    proposal: {
      approvals: [{ userId: 'usr_a' }, { userId: 'usr_a' }],
      explain: { requiredApprovers: 2 },
    },
  }, 'APPROVE');
  assert.deepEqual(outcome, {
    kind: 'recorded',
    message: 'Your approval is recorded. It needs 1 more approver before anything is sent.',
    approvalsCollected: 1,
    requiredApprovers: 2,
  });
});

test('a compliance hold names the reasons, not the policy engine', () => {
  const outcome = interpretSubmitResponse(409, {
    error:
      "policy blocked at submit time: compliance hold (a payee has not been screened; a beneficiary's own verification is not complete)",
    code: 'compliance_hold',
    holdReasons: ['NOT_SCREENED', 'BENEFICIARY_KYB_INCOMPLETE'],
  }, 'APPROVE');
  assert.equal(outcome.kind, 'held');
  assert.equal(
    outcome.message,
    "Held for compliance: a payee has not been screened; a beneficiary's own verification is not complete. Nothing was approved or sent.",
  );
  assert.deepEqual(outcome.reasons, ['NOT_SCREENED', 'BENEFICIARY_KYB_INCOMPLETE']);
  assert.doesNotMatch(outcome.message, /policy blocked/);
});

test('a hold worded only by the policy engine still reads as a hold', () => {
  // The submit route answers a hold with the engine's own sentence and no
  // code; an approver should not be shown "policy blocked at submit time".
  const outcome = interpretSubmitResponse(409, { error: 'policy blocked at submit time: compliance hold' }, 'APPROVE');
  assert.equal(outcome.kind, 'held');
  assert.equal(outcome.message, 'Held for compliance. Nothing was approved or sent.');
  assert.deepEqual(outcome.reasons, []);
});

test('a proposal finished before the decision arrived is closed, in the server’s words', () => {
  const closed = interpretSubmitResponse(409, {
    error: 'This proposal is expired and takes no further decision. Propose the payment again if it is still needed.',
    code: 'PROPOSAL_CLOSED',
    proposal: { status: 'EXPIRED', approvals: [], explain: { requiredApprovers: 2 } },
  }, 'APPROVE');
  assert.deepEqual(closed, {
    kind: 'closed',
    message: 'This proposal is expired and takes no further decision. Propose the payment again if it is still needed.',
  });
  assert.equal(isFinal(closed), true, 'it leaves the queue');

  const released = interpretSubmitResponse(409, {
    error: 'This payment was already approved and is being sent, so it can no longer be rejected.',
    code: 'ALREADY_RELEASED',
  }, 'REJECT');
  assert.equal(released.kind, 'closed');
  assert.match(released.message, /can no longer be rejected/);
});

test('an approval withheld because it could not be saved is approved, not sent, and spent', () => {
  const outcome = interpretSubmitResponse(503, {
    error: 'The approval could not be saved, so the payment was not sent and nothing moved.',
    execution: {
      state: 'FAILED',
      detail: 'The approval could not be saved, so the payment was not sent and nothing moved.',
    },
  }, 'APPROVE');
  assert.equal(outcome.kind, 'approved-not-sent');
  assert.equal(
    outcome.message,
    'Approved, but the payment did not go: The approval could not be saved, so the payment was not sent and nothing moved.',
  );
  assert.equal(isFinal(outcome), true);
});

test('a proposal that changed since the page loaded is not signed unseen', () => {
  const outcome = interpretSubmitResponse(409, {
    error: 'Approval hash mismatch — the proposal changed since you reviewed it; re-approval is required',
    code: 'APPROVAL_HASH_MISMATCH',
  }, 'APPROVE');
  assert.equal(outcome.kind, 'changed');
  assert.match(outcome.message, /Reload/);
});

test('refusals say what to do, in the approver’s terms', () => {
  const cases = [
    [403, 'Maker cannot approve their own proposal', /a different approver has to sign/],
    [409, 'approval must come from a distinct approver', /already approved this payment/],
    [409, 'SIGN is not allowed from SUBMITTED', /already approved and carried out/],
    [409, 'APPROVE is not allowed from REJECTED', /closed/],
    [409, 'policy blocked at submit time: quote expired', /approval window .* has closed/],
    [409, 'circuit breaker blocks signing and submission', /circuit breaker/],
    [404, 'Proposal not found', /no longer available/],
    [403, 'This account is not part of a verified workspace yet.', /not part of a verified workspace/],
  ];
  for (const [status, error, expected] of cases) {
    const outcome = interpretSubmitResponse(status, { error }, 'APPROVE');
    assert.equal(outcome.kind, 'refused', error);
    assert.match(outcome.message, expected, error);
  }
  assert.equal(interpretSubmitResponse(401, { code: 'customer_auth_required' }, 'APPROVE').kind, 'signed-out');
});

test('no answer is not "not approved": the approver is told to check before retrying', () => {
  const outcome = interpretSubmitResponse(0, null, 'APPROVE');
  assert.equal(outcome.kind, 'unreachable');
  assert.match(outcome.message, /not known whether your decision was recorded/);
});

test('only an executed, not-sent, rejected or closed outcome takes a proposal off the queue', () => {
  const final = ['executed', 'approved-not-sent', 'rejected', 'closed'];
  for (const kind of ['executed', 'approved-not-sent', 'rejected', 'closed', 'recorded', 'held', 'changed', 'refused', 'signed-out', 'unreachable']) {
    assert.equal(isFinal({ kind, message: '' }), final.includes(kind), kind);
  }
});

test('kinds read the way an approver names them', () => {
  assert.equal(kindLabel('BATCH_PAYOUT'), 'Payroll run');
  assert.equal(kindLabel('PAYMENT'), 'Payment');
  assert.equal(kindLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
});

// ── The board and the page, as source ───────────────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('the board sends the decision to the submit route and shows the server’s answer', async () => {
  const board = code(await readFile(new URL('../components/queue/ApprovalQueueBoard.tsx', import.meta.url), 'utf8'));
  assert.match(board, /await fetch\(submitPath\(item\.id\), \{/);
  assert.match(board, /body: JSON\.stringify\(submitRequestBody\(item, decision\)\)/);
  assert.match(board, /outcome = interpretSubmitResponse\(response\.status, body, decision\)/);
  // The fake approval is gone: no success without a server answer.
  assert.doesNotMatch(board, /queued for settlement/);
  assert.doesNotMatch(board, /window\.confirm/);
  // A second click cannot send a second decision while one is in flight.
  assert.match(board, /if \(inFlight\[item\.id\]\) return;/);
  assert.match(board, /disabled=\{Boolean\(busy\)\}/);
});

test('examples are shown apart and can never be approved', async () => {
  const board = code(await readFile(new URL('../components/queue/ApprovalQueueBoard.tsx', import.meta.url), 'utf8'));
  const examples = board.slice(board.indexOf('aria-labelledby="queue-examples-heading"'));
  assert.ok(examples.length > 0);
  assert.match(examples, /cannot be approved/);
  assert.doesNotMatch(examples.slice(0, examples.indexOf('Back to Zeke')), /decide\(|onClick/);

  const page = code(await readFile(new URL('../app/queue/page.tsx', import.meta.url), 'utf8'));
  assert.match(page, /<ApprovalQueueBoard live=\{liveProposals\} examples=\{\{ pending: examplePending, lanes: exampleLanes \}\} \/>/);
  // The approver signs what they reviewed.
  assert.match(page, /approvalHash: item\.approvalHash,/);
  // Live rows are this workspace's proposals, and only those; the fixtures
  // are never mixed in with them.
  assert.match(page, /const liveProposals: QueueItem\[\] = proposalStore\s*\.list\(\)\s*\.filter\(\(item\) => item\.orgId === orgId\)/);
  assert.doesNotMatch(page, /\.\.\.liveProposals,/);
});

test('a Reject from the board cannot rewrite a payment already released', async () => {
  // The board's Reject goes to the submit route. A proposal signed and being
  // sent is past rejecting, as a WhatsApp ballot's REJECT already treats it;
  // the route used to transition it to REJECTED regardless.
  const route = code(await readFile(new URL('../app/api/proposals/[id]/submit/route.ts', import.meta.url), 'utf8'));
  const reject = route.slice(route.indexOf("parsed.data.decision === 'REJECT'"), route.indexOf('Maker cannot approve'));
  assert.match(reject, /rejectUnlessReleased\(store, id, `rejected by \$\{ctx\.userId\}`\)/);
  assert.match(reject, /code: 'ALREADY_RELEASED'/);
  assert.doesNotMatch(reject, /store\.transition\(id, \{ type: 'REJECT'/);
});
