import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createCustomerSessionFromIdentity,
  createCustomerSessionToken,
  readCustomerSessionToken,
  stampLastSeen,
  timingSafeStrEqual,
} from '../lib/auth/customer-session.ts';
import { customerRequestOriginAllowed } from '../lib/auth/customer-request.ts';
import { IDLE_TIMEOUT_MS, evaluateIdle } from '../lib/auth/idle-timeout.ts';

const secret = 'test-secret-with-enough-entropy-for-hmac-signing';
const now = Date.parse('2026-07-03T12:00:00.000Z');

test('customer session tokens round-trip normalized identity fields', () => {
  const session = createCustomerSessionFromIdentity({
    email: ' Ops.Team+Demo@Example.COM ',
    organization: ' Acme Treasury ',
    now: new Date(now),
    ttlSeconds: 60,
  });
  const token = createCustomerSessionToken(session, secret, now);
  const decoded = readCustomerSessionToken(token, secret, now + 1_000);

  assert.equal(decoded?.email, 'ops.team+demo@example.com');
  assert.equal(decoded?.name, 'Ops Team+Demo');
  assert.equal(decoded?.organization, 'Acme Treasury');
  assert.equal(decoded?.role, 'business_admin');
});

test('customer session tokens reject tampered signatures', () => {
  const session = createCustomerSessionFromIdentity({
    email: 'finance@example.com',
    now: new Date(now),
    ttlSeconds: 60,
  });
  const token = createCustomerSessionToken(session, secret, now);
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

  assert.equal(readCustomerSessionToken(tampered, secret, now), null);
});

test('customer session tokens reject expired payloads', () => {
  const session = createCustomerSessionFromIdentity({
    email: 'finance@example.com',
    now: new Date(now),
    ttlSeconds: 1,
  });
  const token = createCustomerSessionToken(session, secret, now);

  assert.equal(readCustomerSessionToken(token, secret, now + 2_000), null);
});

test('timing-safe string comparison handles equal and unequal lengths', () => {
  assert.equal(timingSafeStrEqual('same-value', 'same-value'), true);
  assert.equal(timingSafeStrEqual('same-value', 'same-value-extra'), false);
});

test('customer request origin guard allows safe reads and same-origin writes', () => {
  assert.equal(customerRequestOriginAllowed(new Request('https://app.example.test/api/recipients')), true);
  assert.equal(
    customerRequestOriginAllowed(new Request('https://app.example.test/api/recipients', {
      method: 'POST',
      headers: { origin: 'https://app.example.test' },
    })),
    true,
  );
});

test('customer request origin guard rejects cross-site writes', () => {
  assert.equal(
    customerRequestOriginAllowed(new Request('https://app.example.test/api/recipients', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })),
    false,
  );
  assert.equal(
    customerRequestOriginAllowed(new Request('https://app.example.test/api/recipients', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site' },
    })),
    false,
  );
});

test('customer request origin guard falls back to referer when origin is absent', () => {
  assert.equal(
    customerRequestOriginAllowed(new Request('https://app.example.test/api/settings', {
      method: 'PUT',
      headers: { referer: 'https://app.example.test/dashboard/settings' },
    })),
    true,
  );
  assert.equal(
    customerRequestOriginAllowed(new Request('https://app.example.test/api/settings', {
      method: 'PUT',
      headers: { referer: 'https://evil.example/page' },
    })),
    false,
  );
});

/* ── The idle clock ────────────────────────────────────────────────────── */

test('the idle clock survives the cookie round trip, so an abandoned browser actually logs out', () => {
  // Phase 4 stamps lastSeenAt on the cookie and evaluates it on every read.
  // The stamp is inside the signed payload, so it survives the signature —
  // but readCustomerSessionToken rebuilds the session field by field, and a
  // field it does not copy is silently gone. Before the fix, lastSeenAt was
  // never copied: every read saw "no stamp", evaluateIdle treated that as
  // "active, stamp now", and the fifteen-minute idle logout could not fire
  // for anyone, ever.
  const twentyMinutesAgo = new Date(now - 20 * 60 * 1000);
  const session = createCustomerSessionFromIdentity({
    email: 'finance@example.com',
    now: new Date(now),
    ttlSeconds: 60 * 60 * 12,
    lastSeenAt: twentyMinutesAgo,
  });
  assert.equal(session.lastSeenAt, twentyMinutesAgo.toISOString());

  const decoded = readCustomerSessionToken(createCustomerSessionToken(session, secret, now), secret, now);
  assert.equal(decoded?.lastSeenAt, twentyMinutesAgo.toISOString(), 'the stamp must survive the read');

  const verdict = evaluateIdle(Date.parse(decoded.lastSeenAt), now);
  assert.equal(verdict.state, 'expired');
  assert.ok(verdict.idleMs >= IDLE_TIMEOUT_MS);
});

test('re-stamping the idle clock never moves the session expiry', () => {
  const session = createCustomerSessionFromIdentity({
    email: 'finance@example.com',
    now: new Date(now),
    ttlSeconds: 60 * 60,
    lastSeenAt: new Date(now - 5 * 60 * 1000),
  });
  const later = now + 5 * 60 * 1000;

  const stamped = stampLastSeen(session, new Date(later));
  assert.equal(stamped.lastSeenAt, new Date(later).toISOString());
  assert.equal(stamped.expiresAt, session.expiresAt, 'the absolute expiry is not a sliding window');
  assert.equal(stamped.issuedAt, session.issuedAt);
  assert.equal(stamped.email, session.email);

  const decoded = readCustomerSessionToken(createCustomerSessionToken(stamped, secret, later), secret, later);
  assert.equal(decoded?.expiresAt, session.expiresAt);
  assert.equal(decoded?.lastSeenAt, stamped.lastSeenAt);
});
test('the route-handler entry re-stamps the clock; a bare read never writes a cookie', async () => {
  const source = (await readFile(new URL('../lib/server/customer-auth.ts', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  // Every authenticated API call comes through requireCustomerRequest, and
  // that is the one place the stamp may move.
  assert.match(source, /read\.refresh[\s\S]{0,300}touchCustomerSessionCookie\(/);

  // A page render reads the session and may not set cookies, so
  // getCustomerSession must stay a pure read.
  const getter = source.slice(
    source.indexOf('export async function getCustomerSession'),
    source.indexOf('async function readSession'),
  );
  assert.ok(getter.length > 0);
  assert.doesNotMatch(getter, /cookieStore\.set|touchCustomerSessionCookie/);

  // And the touch keeps the token's own expiry rather than minting a new one.
  const touch = source.slice(
    source.indexOf('export async function touchCustomerSessionCookie'),
    source.indexOf('export async function clearCustomerSessionCookie'),
  );
  assert.match(touch, /stampLastSeen\(session\)/);
  assert.doesNotMatch(touch, /sessionFromIdentity|createCustomerSessionFromIdentity/);
});
