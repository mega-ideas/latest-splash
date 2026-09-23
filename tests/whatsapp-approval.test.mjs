import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normaliseE164,
  readReplyIntent,
  verifyTwilioSignature,
  whatsappConfigured,
} from '../lib/server/whatsapp.ts';

/**
 * Approving a payment from WhatsApp.
 *
 * WhatsApp authenticates a HANDSET. It says "a message arrived from this
 * number" and nothing else — not who held the phone, not whether they work
 * here, not whether they may release money.
 *
 * Two things make reply-approval defensible anyway:
 *
 *   Unanimous consent with any single rejection terminal. Ask what a stolen
 *   phone can do: refuse payments, which is noisy and reversible. It cannot
 *   release one, because that needs every other approver's phone too. A
 *   majority rule would not have this property.
 *
 *   The number is bound to a user, and the approval is recorded against that
 *   USER. The handset never appears in the audit trail as an identity.
 */

// ── The signature is the only defence the webhook has ──────────────────────

function sign(url, params, token) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

test('a genuine Twilio signature verifies', () => {
  const url = 'https://splash.example/api/webhooks/whatsapp';
  const params = { From: 'whatsapp:+60102651678', Body: 'APPROVE' };
  const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'secret', TWILIO_WHATSAPP_FROM: '+1' };

  assert.equal(
    verifyTwilioSignature({ url, params, signature: sign(url, params, 'secret'), env }),
    true,
  );
});

test('a forged or altered request does not', () => {
  const url = 'https://splash.example/api/webhooks/whatsapp';
  const params = { From: 'whatsapp:+60102651678', Body: 'APPROVE' };
  const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'secret', TWILIO_WHATSAPP_FROM: '+1' };
  const good = sign(url, params, 'secret');

  // Someone who knows the URL but not the token.
  assert.equal(verifyTwilioSignature({ url, params, signature: sign(url, params, 'guess'), env }), false);
  // The body changed after signing — REJECT swapped for APPROVE.
  assert.equal(
    verifyTwilioSignature({ url, params: { ...params, Body: 'REJECT' }, signature: good, env }),
    false,
  );
  // No signature at all.
  assert.equal(verifyTwilioSignature({ url, params, signature: null, env }), false);
});

test('unconfigured means unverifiable means refused', () => {
  const url = 'https://splash.example/api/webhooks/whatsapp';
  const params = { Body: 'APPROVE' };
  // "We could not check" must never behave like "it is fine".
  assert.equal(verifyTwilioSignature({ url, params, signature: 'anything', env: {} }), false);
  assert.equal(whatsappConfigured({}), false);
  // All three are needed together — a half-configured sender fails at the
  // moment an approval is requested.
  assert.equal(whatsappConfigured({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }), false);
});

// ── Reading a reply ────────────────────────────────────────────────────────

test('only an explicit approval approves', () => {
  assert.equal(readReplyIntent('APPROVE'), 'APPROVE');
  assert.equal(readReplyIntent('approve'), 'APPROVE');
  assert.equal(readReplyIntent('Approved, thanks'), 'APPROVE');

  // A person replying conversationally must not release money by accident.
  for (const casual of ['yes', 'ok', 'sure', 'go ahead', '👍', 'y']) {
    assert.equal(readReplyIntent(casual), 'UNKNOWN', `"${casual}" must not approve`);
  }
});

test('refusal is read more generously than approval', () => {
  // The asymmetry is the safe direction: over-reading a refusal costs a
  // re-send, over-reading an approval costs the money.
  for (const no of ['REJECT', 'no', 'STOP', 'deny', 'cancel']) {
    assert.equal(readReplyIntent(no), 'REJECT', `"${no}" must stop the payment`);
  }
});

// ── One number, one shape ──────────────────────────────────────────────────

test('a number is stored in exactly one form', () => {
  // Three strings, one number. A lookup that misses silently means an approval
  // request that goes nowhere, or a reply that matches nobody.
  assert.equal(normaliseE164('+60102651678'), '+60102651678');
  assert.equal(normaliseE164('+60 10-265 1678'), '+60102651678');
  assert.equal(normaliseE164('whatsapp:+60102651678'.replace('whatsapp:', '')), '+60102651678');

  assert.equal(normaliseE164(''), null);
  assert.equal(normaliseE164('not a number'), null);
  // A country code cannot start with zero.
  assert.equal(normaliseE164('+0102651678'), null);
});

// ── The rules that make it safe ────────────────────────────────────────────

test('consent is unanimous and a rejection is terminal', async () => {
  const source = await readFile(
    new URL('../lib/server/approval-tokens.ts', import.meta.url),
    'utf8',
  );
  // Every issued ballot must approve — not "enough of them". With a majority
  // rule, two compromised handsets out of three would move money.
  assert.match(source, /unanimous: rows\.length > 0 && approved === rows\.length/);
  assert.match(source, /refused: rejected > 0/);

  const requests = await readFile(
    new URL('../lib/server/approval-requests.ts', import.meta.url),
    'utf8',
  );
  // Refusal is checked before unanimity, so one no ends it whatever else arrived.
  assert.ok(
    requests.indexOf('counted.refused') < requests.indexOf('counted.unanimous'),
    'a rejection must be evaluated before an approval tally',
  );
  assert.match(requests, /no further approvals can change that/);
});

test('each approver gets their own ballot, used once', async () => {
  const source = await readFile(
    new URL('../lib/server/approval-tokens.ts', import.meta.url),
    'utf8',
  );
  // A shared code would make "three approvers agreed" satisfiable by one person
  // entering it three times.
  assert.match(source, /approvalTokens\.proposalId, approvalTokens\.userId/);
  // Single-use enforced in the UPDATE, not by a prior read — two replies
  // arriving together would both pass a check-then-write.
  assert.match(source, /\.where\(and\(eq\(approvalTokens\.id, tokenId\), isNull\(approvalTokens\.decidedAt\)\)\)/);
  // And it expires: a code that still works next week approves a payment
  // nobody re-examined.
  assert.match(source, /expiresAt\.getTime\(\) < now\.getTime\(\)/);
});

test('the approval is recorded against a person, never a handset', async () => {
  const channels = await readFile(
    new URL('../lib/server/approver-channels.ts', import.meta.url),
    'utf8',
  );
  // Verified, bound to a user, and that user must currently hold an approving
  // role — re-checked at reply time, because a role revoked between the
  // question and the answer must not still release money.
  assert.match(channels, /if \(!row\.verifiedAt\) return \{ ok: false/);
  assert.match(channels, /APPROVING_ROLES as readonly string\[\]\)\.includes\(row\.role\)/);

  const settle = await readFile(
    new URL('../lib/server/approval-settle.ts', import.meta.url),
    'utf8',
  );
  assert.match(settle, /userId: ballot\.userId/);
  // The number must not appear as an identity in the trail.
  assert.doesNotMatch(settle, /whatsappE164.*approval|approval.*whatsappE164/);
});

test('the maker is never asked to approve their own payment', async () => {
  const requests = await readFile(
    new URL('../lib/server/approval-requests.ts', import.meta.url),
    'utf8',
  );
  assert.match(requests, /a\.userId !== input\.excludeUserId/);

  const dual = await readFile(new URL('../lib/server/dual-approval.ts', import.meta.url), 'utf8');
  assert.match(dual, /excludeUserId: input\.createdBy/);
});

test('the webhook verifies before it reads, and refuses when it cannot', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/whatsapp/route.ts', import.meta.url),
    'utf8',
  );
  // The handler body only — both names appear in the import line above it,
  // where the order says nothing about when they run.
  const handler = route.slice(route.indexOf('export async function POST'));
  const verifyAt = handler.indexOf('verifyTwilioSignature');
  const intentAt = handler.indexOf('readReplyIntent');
  assert.ok(verifyAt > 0 && intentAt > 0, 'both must be called in the handler');
  assert.ok(verifyAt < intentAt, 'the signature is checked before the body means anything');
  assert.match(route, /return new Response\('forbidden', \{ status: 403 \}\)/);
  // The webhook records a vote; it decides nothing about money.
  assert.match(route, /settleFullyApprovedProposal/);
});

test('the code channel needs a session as well as the phone', async () => {
  const route = await readFile(
    new URL('../app/api/approvals/code/route.ts', import.meta.url),
    'utf8',
  );
  // This is why `code` is the default: a stolen handset alone releases nothing,
  // because the code has nowhere to go without an authenticated session.
  assert.match(route, /requireCustomerRequest\(request\)/);
  assert.match(route, /resolveAuthorityForSession\(auth\.session\)/);
  assert.match(route, /canApprove\(dbRole\)/);
  // Scoped to the session's user — not a bearer secret. Reading somebody
  // else's code off their screen achieves nothing.
  assert.match(route, /findTokenByCode\(ctx\.userId, parsed\.data\.code, now\)/);
});

test('the default channel is the stronger one', async () => {
  const { DEFAULT_ORG_SETTINGS } = await import('../lib/server/org-settings.ts');
  assert.equal(DEFAULT_ORG_SETTINGS.approvalChannel, 'code');
  // And WhatsApp is off until someone turns it on.
  assert.equal(DEFAULT_ORG_SETTINGS.whatsappEnabled, false);
});

test('a failed notification does not fail the payment path', async () => {
  const dual = await readFile(new URL('../lib/server/dual-approval.ts', import.meta.url), 'utf8');
  // The proposal exists, the queue shows it, an approver can still act in the
  // app. WhatsApp is a faster route to the same decision, not the only one.
  assert.match(dual, /void \(async \(\) => \{/);
  assert.match(dual, /could not notify approvers/);

  const wa = await readFile(new URL('../lib/server/whatsapp.ts', import.meta.url), 'utf8');
  assert.match(wa, /return \{ sent: false, reason:/);
});
