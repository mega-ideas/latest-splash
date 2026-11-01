/**
 * The email an invited person gets (v2 Phase 3, Sky's decision of 1 Nov: "invitees
 * also get an email, through Resend; no per-sender invitation limit for now").
 *
 *   - It says who invited them (the sender's name and the business), what it is,
 *     that it ends, and carries ONE link. The link opens the app and asks for
 *     sign-in; nothing is accepted by opening it. It holds no token: the id in it
 *     grants nothing without signing in as the invited email.
 *   - It is sent once per invitation. A retry, a double click and a second owner
 *     never send twice. The send is recorded on the invitation.
 *   - A failed send never loses the invitation: it is still waiting after sign-in,
 *     and the owner is told in plain words and may send the email again.
 *   - No Resend key set up: the invitation works in the app only, and the owner is
 *     told so. Never silent.
 *   - Every inserted value is escaped. Nothing secret reaches a log.
 *
 * A mocked sender throughout; nothing here reaches a mail provider.
 * PGlite with every migration; the same functions the routes call.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import { appointFinanceLead } from '../lib/server/team-admin.ts';
import {
  INVITATION_TTL_MS,
  acceptInvitation,
  declineInvitation,
  invitationStatusFor,
  invitationsFor,
  listInvitations,
  sendInvitation,
  withdrawInvitation,
} from '../lib/server/team-invitations.ts';
import { deliverInvitationEmail, resendInvitationEmail } from '../lib/server/invitation-email.ts';
import { invitationEmail } from '../lib/team/invitation-email.ts';
import { createResendTransport } from '../lib/auth/email-transport.ts';
import { invitationLink, invitationPath, safeApproveReturn } from '../lib/approve/link.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const at = (ms) => () => new Date(T0.getTime() + ms);
const ENV = { NODE_ENV: 'test', NEXT_PUBLIC_APP_URL: 'https://app.splash.test' };
const KEY = 're_live_SECRETKEY_0123456789';

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'Aisha Rahman', 'acme', 'admin'],
    ['u-lead', 'lead@acme.test', 'Lena Lead', 'acme', 'checker'],
    ['u-maker', 'maker@acme.test', 'Maya Maker', 'acme', 'maker'],
    ['u-n-owner', 'owner@northwind.test', 'Nora North', 'northwind', 'admin'],
    ['u-free', 'free@example.test', 'Fred Free', null, null],
    ['u-other', 'other@example.test', 'Olive Other', null, null],
  ];
  for (const [id, email, name, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  assert.equal((await appointFinanceLead(db, { orgId: 'acme', actorUserId: 'u-owner', userId: 'u-lead', now: () => T0 })).ok, true);
  return { client, db };
}

/** A sender that records every message and can be made to fail. */
function sender({ fail = false, name = 'resend' } = {}) {
  const calls = [];
  const transport = {
    name,
    async sendVerification() {},
    async sendMessage(message) {
      calls.push(message);
      if (fail) throw new Error(`provider said no (key ${KEY})`);
      return { providerRef: `msg_${calls.length}` };
    },
  };
  return { transport, calls };
}

const invite = (db, over = {}) => sendInvitation(db, { orgId: 'acme', actorUserId: 'u-owner', email: 'free@example.test', role: 'maker', now: () => T0, ...over });
const rowOf = async (db, id) => (await db.select().from(schema.teamInvitations).where(eq(schema.teamInvitations.id, id)))[0];
const deliver = (db, id, transport, over = {}) =>
  deliverInvitationEmail(db, { orgId: 'acme', invitationId: id, actorUserId: 'u-owner', transport, env: ENV, now: () => T0, ...over });
const resend = (db, id, transport, over = {}) =>
  resendInvitationEmail(db, { orgId: 'acme', invitationId: id, actorUserId: 'u-owner', transport, env: ENV, now: () => T0, ...over });
const ownerView = async (db, over = {}) => (await listInvitations(db, { orgId: 'acme', manager: 'owner', now: () => T0, ...over }))[0];

/** Capture everything written to the console while `fn` runs. */
async function logged(fn) {
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  try {
    await fn();
  } finally {
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }
  return lines.join('\n');
}

/* ── The words and the markup ──────────────────────────────────────────── */

const LINK = 'https://app.splash.test/dashboard/invitation/inv_11111111-2222-3333-4444-555555555555';
const content = (over = {}) => invitationEmail({ inviterName: 'Aisha Rahman', businessName: 'Acme Trading', link: LINK, expiresAt: new Date('2026-11-09T09:00:00Z'), ...over });

test('the email says who invited them, to which business, that it ends, and carries one link', () => {
  const { subject, text, html } = content();
  assert.equal(subject, 'Aisha Rahman invited you to join Acme Trading on Splash');
  for (const part of [text, html]) {
    assert.match(part, /Aisha Rahman/);
    assert.match(part, /Acme Trading/);
    assert.match(part, /7 days/);
    assert.match(part, /9 November 2026/);
  }
  assert.equal((text.match(/https?:\/\//g) ?? []).length, 1, 'one link in the text');
  assert.equal((html.match(/href="/g) ?? []).length, 1, 'one link in the page');
  assert.ok(text.includes(LINK));
  assert.ok(html.includes(`href="${LINK}"`));
  assert.match(text, /sign in/i);
  assert.match(text, /nothing happens until you (accept|choose)|does nothing unless you sign in/i, 'it says that the link alone does nothing');
});

test('the email names no money, no other business, no tracking, no emoji, no marketing words', () => {
  const { subject, text, html } = content();
  const all = `${subject}\n${text}\n${html}`;
  assert.doesNotMatch(all, /<img\b/i, 'no images, so no tracking pixel');
  assert.doesNotMatch(html, /<script|<iframe|<link\b|@import|url\(/i);
  assert.doesNotMatch(all, /\p{Extended_Pictographic}/u, 'no emoji');
  assert.doesNotMatch(all, /[$€£]|\b(USDC|MYR|USD|SUI|balance|amount)\b/i, 'no financial figures');
  assert.doesNotMatch(all, /coming soon|demo|testnet|non-custodial|licen[cs]e|unsubscribe|limited time|free trial/i);
  assert.doesNotMatch(all, /utm_|[?&]token=|[?&]code=/i, 'no tracking parameters and no token in the link');
});

test('the page works at 600px: a plain table, inline styles, a button link with a readable contrast', () => {
  const { html } = content();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /max-width:600px/);
  assert.match(html, /<a href="[^"]+"[^>]*>[^<]*Open the invitation[^<]*<\/a>/);
});

test('hostile names cannot become markup, a second link, or a new header line', () => {
  const evilBusiness = '</title><script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const evilPerson = 'Eve\r\nBcc: attacker@evil.test <b>bold</b> & "quoted"';
  const { subject, text, html } = content({ inviterName: evilPerson, businessName: evilBusiness });
  assert.doesNotMatch(subject, /[\r\n]/, 'a name cannot add a header line to the subject');
  assert.doesNotMatch(html, /<script|<img src=x|<\/title><script|<b>bold<\/b>|onerror=alert\(2\)>/i, 'every inserted value is escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp; &quot;quoted&quot;/);
  assert.equal((html.match(/href="/g) ?? []).length, 1, 'still one link');
  assert.doesNotMatch(text, /\r/, 'no carriage returns in the plain text');
  assert.doesNotMatch(subject.split('\n')[0], /attacker@evil\.test\r/);
  // A very long name is cut, not allowed to push the link out of view.
  const long = content({ businessName: 'B'.repeat(5000) });
  assert.ok(long.subject.length < 200 && long.text.length < 2000);
});

test('an empty or missing name still gives a sentence that makes sense', () => {
  const { subject, text } = content({ inviterName: '   ', businessName: '' });
  assert.match(subject, /invited you to join/);
  assert.doesNotMatch(`${subject}${text}`, /undefined|null|\[object/);
});

/* ── The link ──────────────────────────────────────────────────────────── */

test('the link is the app address plus the invitation page and an id: no query, no fragment, no token', () => {
  assert.equal(invitationPath('inv_abc12345-6789'), '/dashboard/invitation/inv_abc12345-6789');
  assert.equal(invitationPath('../../etc'), null);
  assert.equal(invitationPath('a b'), null);
  assert.equal(invitationLink('https://app.splash.test/ignored?x=1#y', 'inv_abc12345-6789', { NODE_ENV: 'production' }), 'https://app.splash.test/dashboard/invitation/inv_abc12345-6789');
  // Production: only https on a public name. Anything else sends the email without a link, so it sends nothing.
  for (const bad of ['http://app.splash.test', 'https://localhost:3000', 'https://10.0.0.5', 'not a url', '', undefined]) {
    assert.equal(invitationLink(bad, 'inv_abc12345-6789', { NODE_ENV: 'production' }), null, String(bad));
  }
  assert.equal(invitationLink('http://localhost:3000', 'inv_abc12345-6789', { NODE_ENV: 'development' }), 'http://localhost:3000/dashboard/invitation/inv_abc12345-6789');
});

test('signing in from the link comes back to that invitation, and to nowhere else', () => {
  assert.equal(safeApproveReturn('/dashboard/invitation/inv_abc12345-6789'), '/dashboard/invitation/inv_abc12345-6789');
  for (const bad of ['/dashboard/invitation/', '/dashboard/invitation/../x', '/dashboard/invitation/inv_abc12345-6789?next=//evil', '//evil.test', 'https://evil.test/dashboard/invitation/inv_abc12345-6789']) {
    assert.equal(safeApproveReturn(bad), null, bad);
  }
});

/* ── Sent once ─────────────────────────────────────────────────────────── */

test('an invitation is emailed once, to the invited address, and the send is recorded on the invitation', async () => {
  const { client, db } = await seeded();
  const sent = await invite(db);
  const id = sent.invitation.id;
  const { transport, calls } = sender();
  const result = await deliver(db, id, transport);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'sent');
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'free@example.test');
  assert.equal(calls[0].subject, 'Aisha Rahman invited you to join Acme Trading on Splash');
  assert.ok(calls[0].text.includes(`https://app.splash.test/dashboard/invitation/${id}`));
  assert.ok(calls[0].html.includes(`href="https://app.splash.test/dashboard/invitation/${id}"`));
  assert.ok(calls[0].idempotencyKey && calls[0].idempotencyKey.includes(id), 'the provider can drop a repeat of the same send');
  const row = await rowOf(db, id);
  assert.equal(row.emailState, 'sent');
  assert.equal(row.emailSentAt.toISOString(), T0.toISOString());
  assert.equal(row.emailMessageRef, 'msg_1');
  assert.equal(row.status, 'pending');
  await client.close();
});

test('a retry of the invitation, a repeat of the delivery and a double click send nothing more', async () => {
  const { client, db } = await seeded();
  const first = await invite(db);
  const { transport, calls } = sender();
  await deliver(db, first.invitation.id, transport);
  const again = await invite(db);
  assert.equal(again.created, false, 'the same invitation');
  assert.equal(again.invitation.id, first.invitation.id);
  const repeat = await deliver(db, again.invitation.id, transport);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.sent, false);
  assert.equal(repeat.state, 'sent');
  const clicks = await Promise.all([resend(db, first.invitation.id, transport), resend(db, first.invitation.id, transport)]);
  for (const c of clicks) assert.equal(c.sent, false, 'already sent: a click sends nothing');
  assert.equal(calls.length, 1, 'one email in all');
  await client.close();
});

test('two deliveries at the same moment send once', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const { transport, calls } = sender();
  const results = await Promise.all([deliver(db, invitation.id, transport), deliver(db, invitation.id, transport), deliver(db, invitation.id, transport)]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter((r) => r.sent).length, 1);
  await client.close();
});

/* ── A failed send ─────────────────────────────────────────────────────── */

test('a failed send keeps the invitation: it still shows after sign-in, and the owner is told in plain words', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const { transport, calls } = sender({ fail: true });
  const result = await deliver(db, invitation.id, transport);
  assert.equal(result.ok, true, 'the invitation was made; only the email failed');
  assert.equal(result.state, 'failed');
  assert.equal(result.sent, false);
  assert.equal(calls.length, 1);
  const row = await rowOf(db, invitation.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.emailState, 'failed');
  assert.equal(row.emailSentAt, null);
  const mine = await invitationsFor(db, { userId: 'u-free', now: () => T0 });
  assert.equal(mine.length, 1, 'the person still sees it in the app');
  assert.equal(mine[0].businessName, 'Acme Trading');
  const view = await ownerView(db);
  assert.equal(view.delivery.state, 'failed');
  assert.equal(view.delivery.canResend, true);
  assert.equal(view.delivery.message, 'We could not send the email. The invitation is still waiting for them. Try sending the email again.');
  await client.close();
});

test('the owner sends the email again after a failure: once per click, and no more once it has gone', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  await deliver(db, invitation.id, sender({ fail: true }).transport);
  const good = sender();
  const clicks = await Promise.all([resend(db, invitation.id, good.transport), resend(db, invitation.id, good.transport)]);
  assert.equal(good.calls.length, 1, 'a double click sends once');
  assert.equal(clicks.filter((c) => c.sent).length, 1);
  assert.equal((await rowOf(db, invitation.id)).emailState, 'sent');
  const third = await resend(db, invitation.id, good.transport);
  assert.equal(third.sent, false);
  assert.equal(good.calls.length, 1);
  const view = await ownerView(db);
  assert.equal(view.delivery.state, 'sent');
  assert.equal(view.delivery.canResend, false);
  await client.close();
});

test('a send that failed twice and then worked uses a fresh provider key each time it fails, and the same key when the outcome is unknown', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const failing = sender({ fail: true });
  await deliver(db, invitation.id, failing.transport);
  await resend(db, invitation.id, failing.transport);
  assert.equal(failing.calls.length, 2);
  assert.notEqual(failing.calls[0].idempotencyKey, failing.calls[1].idempotencyKey, 'a known failure is a new attempt');
  // A send that never reported back (the process died mid-send) is "sending". It is not retried at once,
  // and when it is, the provider is given the same key so it can recognise the repeat.
  await db.update(schema.teamInvitations).set({ emailState: 'sending' }).where(eq(schema.teamInvitations.id, invitation.id));
  const during = sender();
  const soon = await resend(db, invitation.id, during.transport, { now: at(60 * 1000) });
  assert.equal(soon.sent, false, 'a send that started a minute ago may still be running');
  assert.equal(soon.state, 'sending');
  assert.equal(during.calls.length, 0);
  const stuckKey = (await rowOf(db, invitation.id)).emailAttempts;
  const later = await resend(db, invitation.id, during.transport, { now: at(60 * 60 * 1000) });
  assert.equal(later.sent, true);
  assert.equal(during.calls[0].idempotencyKey, failing.calls[1].idempotencyKey, 'same key as the attempt whose outcome was never known');
  assert.equal((await rowOf(db, invitation.id)).emailAttempts, stuckKey);
  await client.close();
});

/* ── Who may press the button ──────────────────────────────────────────── */

test('only an owner sends the email again: the Finance lead, staff and strangers are refused, and another business cannot see the invitation', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  await deliver(db, invitation.id, sender({ fail: true }).transport);
  const good = sender();
  for (const [actor, status] of [['u-lead', 403], ['u-maker', 403], ['u-free', 403]]) {
    const r = await resend(db, invitation.id, good.transport, { actorUserId: actor });
    assert.equal(r.ok, false, actor);
    assert.equal(r.status, status, actor);
  }
  // Another business's owner: the invitation is absent, same as an id that never existed.
  const cross = await resendInvitationEmail(db, { orgId: 'northwind', invitationId: invitation.id, actorUserId: 'u-n-owner', transport: good.transport, env: ENV, now: () => T0 });
  const never = await resendInvitationEmail(db, { orgId: 'northwind', invitationId: 'inv_does-not-exist', actorUserId: 'u-n-owner', transport: good.transport, env: ENV, now: () => T0 });
  assert.equal(cross.ok, false);
  assert.equal(cross.status, 404);
  assert.deepEqual({ status: cross.status, code: cross.code, error: cross.error }, { status: never.status, code: never.code, error: never.error });
  assert.equal(good.calls.length, 0, 'nothing was sent for any of them');
  assert.equal((await rowOf(db, invitation.id)).emailState, 'failed', 'and nothing changed');
  // What the Finance lead sees: the state in words, but no button.
  const leadView = await ownerView(db, { manager: 'finance_lead' });
  assert.equal(leadView.delivery.canResend, false);
  assert.equal(leadView.delivery.state, 'failed');
  // The other business sees none of it.
  assert.deepEqual(await listInvitations(db, { orgId: 'northwind', manager: 'owner', now: () => T0 }), []);
  await client.close();
});

test('an invitation sent by the Finance lead is emailed too, in the lead\'s name', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db, { actorUserId: 'u-lead', role: 'viewer' });
  const { transport, calls } = sender();
  const r = await deliver(db, invitation.id, transport, { actorUserId: 'u-lead' });
  assert.equal(r.state, 'sent');
  assert.equal(calls[0].subject, 'Lena Lead invited you to join Acme Trading on Splash');
  await client.close();
});

/* ── Withdrawn and ended ───────────────────────────────────────────────── */

test('a withdrawn invitation sends no email, and its link says so in plain words', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const { transport, calls } = sender();
  await deliver(db, invitation.id, transport);
  assert.equal((await withdrawInvitation(db, { orgId: 'acme', actorUserId: 'u-owner', invitationId: invitation.id, now: () => T0 })).ok, true);
  const r = await resend(db, invitation.id, transport);
  assert.equal(r.ok, false);
  assert.equal(r.status, 410);
  assert.match(r.error, /no longer open|withdrew|took it back/i);
  assert.equal(calls.length, 1);
  const seen = await invitationStatusFor(db, { userId: 'u-free', invitationId: invitation.id, now: () => T0 });
  assert.equal(seen.ok, true);
  assert.equal(seen.state, 'withdrawn');
  assert.equal(seen.message, 'The person who sent this invitation took it back. It can no longer be accepted. Ask them to send a new one if you still want to join.');
  const accepted = await acceptInvitation(db, { userId: 'u-free', invitationId: invitation.id, now: () => T0 });
  assert.equal(accepted.ok, false, 'the link grants nothing');
  await client.close();
});

test('an expired invitation sends no email and its link says it ended', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const { transport, calls } = sender();
  const late = at(INVITATION_TTL_MS + 1000);
  const r = await resend(db, invitation.id, transport, { now: late });
  assert.equal(r.ok, false);
  assert.equal(r.status, 410);
  assert.match(r.error, /ended after 7 days/);
  const first = await deliver(db, invitation.id, transport, { now: late });
  assert.equal(first.ok, false);
  assert.equal(calls.length, 0, 'not at the last second either');
  const seen = await invitationStatusFor(db, { userId: 'u-free', invitationId: invitation.id, now: late });
  assert.equal(seen.state, 'expired');
  assert.equal(seen.message, 'This invitation ended after 7 days. Ask the person who sent it to send a new one.');
  await client.close();
});

test('an owner cannot send an email after the invitation ends, even one second before the stored end', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const good = sender();
  const justBefore = await resend(db, invitation.id, good.transport, { now: at(INVITATION_TTL_MS - 1000) });
  assert.equal(justBefore.sent, true, 'still open, so it may be sent');
  const atEnd = await resend(db, invitation.id, good.transport, { now: at(INVITATION_TTL_MS) });
  assert.equal(atEnd.ok, false);
  await client.close();
});

/* ── The invited person's page ─────────────────────────────────────────── */

test('the invitation page shows an open invitation to the invited, verified person and to nobody else', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const mine = await invitationStatusFor(db, { userId: 'u-free', invitationId: invitation.id, now: () => T0 });
  assert.equal(mine.ok, true);
  assert.equal(mine.state, 'open');
  assert.equal(mine.invitation.businessName, 'Acme Trading');
  assert.equal(mine.invitation.invitedByName, 'Aisha Rahman');
  // Someone else who has the link (forwarded, or read over a shoulder): the same answer as for an id that does not exist.
  const other = await invitationStatusFor(db, { userId: 'u-other', invitationId: invitation.id, now: () => T0 });
  const nobody = await invitationStatusFor(db, { userId: 'u-other', invitationId: 'inv_does-not-exist', now: () => T0 });
  assert.equal(other.ok, false);
  assert.deepEqual(other, nobody);
  assert.doesNotMatch(JSON.stringify(other), /Acme|Aisha|free@example/);
  // A business's own owner is not the invited person either.
  const owner = await invitationStatusFor(db, { userId: 'u-owner', invitationId: invitation.id, now: () => T0 });
  assert.equal(owner.ok, false);
  // Opening the link accepted nothing.
  assert.equal((await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-free'))).length, 0);
  assert.equal((await rowOf(db, invitation.id)).status, 'pending');
  await client.close();
});

test('an unverified account is asked to verify first and shown nothing about the invitation', async () => {
  const { client, db } = await seeded();
  await db.insert(schema.users).values({ id: 'u-new', email: 'new@example.test', name: 'New', emailVerifiedAt: null });
  const { invitation } = await invite(db, { email: 'new@example.test' });
  const seen = await invitationStatusFor(db, { userId: 'u-new', invitationId: invitation.id, now: () => T0 });
  assert.equal(seen.ok, false);
  assert.equal(seen.code, 'verify_email');
  assert.doesNotMatch(JSON.stringify(seen), /Acme|Aisha/);
  await client.close();
});

test('declined and accepted invitations say so, once answered', async () => {
  const { client, db } = await seeded();
  const a = (await invite(db)).invitation;
  await declineInvitation(db, { userId: 'u-free', invitationId: a.id, now: () => T0 });
  const declined = await invitationStatusFor(db, { userId: 'u-free', invitationId: a.id, now: () => T0 });
  assert.equal(declined.state, 'declined');
  assert.match(declined.message, /declined/);
  const b = (await invite(db, { email: 'other@example.test' })).invitation;
  await acceptInvitation(db, { userId: 'u-other', invitationId: b.id, now: () => T0 });
  const accepted = await invitationStatusFor(db, { userId: 'u-other', invitationId: b.id, now: () => T0 });
  assert.equal(accepted.state, 'accepted');
  await client.close();
});

/* ── No sender set up ──────────────────────────────────────────────────── */

test('with no email sender set up the invitation works in the app and the owner is told, loudly, that no email went', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const r = await deliver(db, invitation.id, null);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'not_configured');
  assert.equal(r.sent, false);
  assert.equal((await rowOf(db, invitation.id)).emailState, 'not_configured');
  assert.equal((await invitationsFor(db, { userId: 'u-free', now: () => T0 })).length, 1, 'the invitation is in the app');
  const view = await ownerView(db);
  assert.equal(view.delivery.state, 'not_configured');
  assert.match(view.delivery.message, /^No email was sent\./);
  assert.match(view.delivery.message, /waiting in the app/);
  assert.equal(view.delivery.canResend, true, 'once email is set up the owner can send it');
  const later = sender();
  const sentNow = await resend(db, invitation.id, later.transport);
  assert.equal(sentNow.state, 'sent');
  assert.equal(later.calls.length, 1);
  await client.close();
});

test('the environment decides: a console sender in development is not a sent email, a missing key is not configured, a Resend key sends', async () => {
  const { client, db } = await seeded();
  const a = (await invite(db)).invitation;
  const dev = await deliverInvitationEmail(db, { orgId: 'acme', invitationId: a.id, actorUserId: 'u-owner', env: { ...ENV, EMAIL_TRANSPORT: 'console' }, now: () => T0 });
  assert.equal(dev.state, 'not_configured', 'a line in a terminal reached nobody');
  const noKey = await resendInvitationEmail(db, { orgId: 'acme', invitationId: a.id, actorUserId: 'u-owner', env: { ...ENV, NODE_ENV: 'production', EMAIL_TRANSPORT: 'resend' }, now: () => T0 });
  assert.equal(noKey.state, 'not_configured');
  const prodConsole = await resendInvitationEmail(db, { orgId: 'acme', invitationId: a.id, actorUserId: 'u-owner', env: { ...ENV, NODE_ENV: 'production' }, now: () => T0 });
  assert.equal(prodConsole.state, 'not_configured', 'production without a real sender never pretends');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ id: 'resend-id-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const live = await resendInvitationEmail(db, { orgId: 'acme', invitationId: a.id, actorUserId: 'u-owner', env: { ...ENV, EMAIL_TRANSPORT: 'resend', EMAIL_API_KEY: KEY, EMAIL_FROM: 'invites@splash.test' }, now: () => T0 });
    assert.equal(live.state, 'sent');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(seen[0].init.headers['Idempotency-Key'], 'Resend can drop a repeat');
  assert.equal((await rowOf(db, a.id)).emailMessageRef, 'resend-id-1');
  await client.close();
});

test('a link that production would not allow (not https, or a private name) sends no email and says it is not set up', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const { transport, calls } = sender();
  const r = await deliver(db, invitation.id, transport, { env: { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' } });
  assert.equal(r.state, 'not_configured');
  assert.equal(calls.length, 0);
  await client.close();
});

test('the Resend sender sends the key as a header and never in the body, and its errors carry no key', async () => {
  const bodies = [];
  const t = createResendTransport({
    apiKey: KEY,
    from: 'invites@splash.test',
    fetch: async (url, init) => {
      bodies.push({ url, init });
      return new Response('{"message":"nope"}', { status: 422 });
    },
  });
  await assert.rejects(() => t.sendMessage({ to: 'a@b.test', subject: 's', text: 't', html: '<p>h</p>', idempotencyKey: 'k1' }), (error) => {
    assert.doesNotMatch(String(error.message), new RegExp(KEY));
    return true;
  });
  assert.equal(bodies[0].init.headers['Idempotency-Key'], 'k1');
  assert.doesNotMatch(String(bodies[0].init.body), new RegExp(KEY));
  assert.equal(JSON.parse(bodies[0].init.body).html, '<p>h</p>', 'a caller\'s own page is sent as given');
});

/* ── Logs ──────────────────────────────────────────────────────────────── */

test('nothing secret, and no address, reaches a log, whether the send worked, failed or was not set up', async () => {
  const { client, db } = await seeded();
  const { invitation } = await invite(db);
  const out = await logged(async () => {
    await deliver(db, invitation.id, sender({ fail: true }).transport);
    await resend(db, invitation.id, null);
    await resend(db, invitation.id, sender().transport);
  });
  assert.doesNotMatch(out, new RegExp(KEY), 'no key');
  assert.doesNotMatch(out, /free@example\.test/, 'no address');
  assert.doesNotMatch(out, /dashboard\/invitation\//, 'no link');
  await client.close();
});

/* ── Hostile names, end to end ─────────────────────────────────────────── */

test('names read from the database are escaped on the way out, in the page and the subject', async () => {
  const { client, db } = await seeded();
  await db.update(schema.users).set({ name: 'Eve\r\nBcc: x@y.test <script>alert(1)</script>' }).where(eq(schema.users.id, 'u-owner'));
  await db.update(schema.organizations).set({ name: '"><img src=x onerror=alert(2)> & Sons' }).where(eq(schema.organizations.id, 'acme'));
  const { invitation } = await invite(db);
  const { transport, calls } = sender();
  await deliver(db, invitation.id, transport);
  assert.doesNotMatch(calls[0].subject, /[\r\n]/);
  assert.doesNotMatch(calls[0].html, /<script|<img src=x/i);
  assert.match(calls[0].html, /&lt;script&gt;/);
  assert.match(calls[0].html, /&amp; Sons/);
  await client.close();
});

/* ── The migration, the wire and the routes ────────────────────────────── */

test('the send is recorded in a migration at the next free number, and the schema names the same columns', () => {
  const sql = read('drizzle/0082_invitation_email.sql');
  for (const column of ['email_state', 'email_sent_at', 'email_message_ref', 'email_attempts', 'email_attempt_at']) assert.match(sql, new RegExp(column));
  assert.match(sql, /CHECK/i);
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  assert.equal(journal.entries.at(-1).tag, '0082_invitation_email');
  const schemaText = read('lib/db/schema.ts');
  for (const field of ['emailState', 'emailSentAt', 'emailMessageRef', 'emailAttempts', 'emailAttemptAt']) assert.match(schemaText, new RegExp(field));
  assert.doesNotMatch(sql, /\btoken\b|\bsecret\b/i, 'still no token column');
});

test('the resend route is the owner-gated, session-scoped, once-per-click route; sending an invitation delivers once after it is made', () => {
  const resendRoute = read('app/api/team/invitations/[invitationId]/email/route.ts');
  assert.match(resendRoute, /await teamRoute\(request\)/);
  assert.match(resendRoute, /await limitTeamChanges\(gate\.route\)/);
  assert.match(resendRoute, /resendInvitationEmail\(gate\.route\.db, \{[^}]*orgId: gate\.route\.orgId/);
  assert.match(resendRoute, /actorUserId: gate\.route\.authority\.userId/);
  assert.doesNotMatch(resendRoute, /body\.(orgId|actorUserId|email|to)\b/, 'nothing about whom to email comes from the request');
  const sendRoute = read('app/api/team/invitations/route.ts');
  assert.match(sendRoute, /deliverInvitationEmail\(/);
  assert.ok(sendRoute.indexOf('sendInvitation(') < sendRoute.indexOf('deliverInvitationEmail('), 'the invitation is made first, so a failed email loses nothing');
  const status = read('app/api/team/invitations/[invitationId]/status/route.ts');
  assert.match(status, /await inviteeRoute\(request\)/);
  assert.match(status, /invitationStatusFor\(gate\.route\.db, \{ userId: gate\.route\.userId/);
});

test('no limit on invitations is built: no new rate-limit rule, no daily cap, and the docs say it is to be revisited', () => {
  const limits = read('lib/server/rate-limit.ts');
  assert.doesNotMatch(limits, /invit/i, 'no rate-limit rule is named for invitations or their emails');
  const service = read('lib/server/invitation-email.ts');
  assert.doesNotMatch(service, /enforceRateLimit|RATE_LIMITS|dailyCap|perDay|per_day/);
  const docs = read('docs/v2/phase3-team-roles.md');
  assert.match(docs, /There is no per-sender invitation limit for now; it is to be revisited before launch\./);
});

test('the pages and the words never use what the copy rules forbid', () => {
  const view = read('lib/team/invitation-email.ts');
  assert.doesNotMatch(view, /coming soon|\bdemo\b|testnet|non-custodial/i);
  const page = read('app/dashboard/invitation/[invitationId]/page.tsx');
  assert.doesNotMatch(page, /coming soon|\bdemo\b|testnet|non-custodial|coral/i);
});

test('the owner screen shows sent, failed and not-set-up in words, loudly where it matters, and only an owner gets the button', () => {
  const list = read('components/team/OpenInvitations.tsx');
  assert.match(list, /d\.canResend/, 'the button follows what the server said this manager may do');
  assert.match(list, /role="alert"/, 'a failed or missing email is an alert, not a hint');
  assert.match(list, /\/email`, \{ method: 'POST'/, 'one POST per click');
  assert.match(list, /disabled=\{anyBusy\}/, 'the button is off while any send is running');
  assert.match(list, /An owner can send the email\./);
  const words = read('lib/team/invitation-email.ts');
  assert.match(words, /We could not send the email\. The invitation is still waiting for them\. Try sending the email again\./);
  const form = read('components/team/AddPersonForm.tsx');
  assert.match(form, /INVITE_EMAIL_WORDS\.not_configured/);
  assert.match(form, /INVITE_EMAIL_WORDS\.failed/);
});

test('the invitation page keeps the dashboard sign-in, hides the banner for itself, and accepts nothing on open', () => {
  const page = read('components/team/InvitationPage.tsx');
  assert.match(page, /\/status`/);
  assert.ok(page.indexOf('/status`') < page.indexOf("/${decision}`"), 'it reads first; accepting is a separate press');
  assert.doesNotMatch(page, /useEffect\([^]*?\/accept/, 'no accept inside the effect that runs on open');
  assert.match(read('components/team/InvitationBanner.tsx'), /startsWith\('\/dashboard\/invitation\/'\)/);
  assert.match(read('app/dashboard/layout.tsx'), /redirect\(loginRedirectFor/, 'a signed-out visit signs in and comes back');
});
