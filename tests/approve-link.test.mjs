/**
 * v2 Phase 3, brief 5.10 (Sky's decision): the signing message links to
 * /dashboard/approve/[id].
 *
 * What the link may be, and what it may not be:
 *
 *   - It carries no secret and signs nothing. It is the business's own address
 *     plus the request's id (an identifier, not a credential: reading the
 *     request still needs the person's session and their own business).
 *     No query string, no fragment, no token, no transaction bytes.
 *   - Opening it only shows the Approve screen. Nothing executes until an
 *     approver signs with their own passkey (the service-level tests are in
 *     approve-link-service.test.mjs).
 *   - It never replaces the transaction code: the message still carries the
 *     code, and the screen still asks the person to compare it.
 *   - It fails closed: in production a link is made only on https; anything
 *     else sends the message without a link, never a plain-http one.
 *   - A person who is signed out is taken to sign in and then back to that one
 *     screen. The way back is an allowlist of exactly one shape; anything else
 *     (another site, another path, a query) is Home.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { approveLink, approvePath, safeApproveReturn, RETURN_HEADER } from '../lib/approve/link.ts';

const ID = 'wsr_0b9c1f52-6c1e-4d0e-9d0b-0a1b2c3d4e5f';
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/* ── The address ──────────────────────────────────────────────────────── */

test('the link is the business’s own address plus the request id, and nothing else', () => {
  assert.equal(approvePath(ID), `/dashboard/approve/${ID}`);
  const link = approveLink('https://app.splash.example', ID, { NODE_ENV: 'production' });
  assert.equal(link, `https://app.splash.example/dashboard/approve/${ID}`);
  const url = new URL(link);
  assert.equal(url.search, '', 'no query string');
  assert.equal(url.hash, '', 'no fragment');
  assert.equal(url.username + url.password, '', 'no credentials in the address');
});

test('a configured address with a path, query, fragment or credentials is cut back to its origin', () => {
  const link = approveLink('https://user:pw@app.splash.example/some/path?token=abc#frag', ID, { NODE_ENV: 'production' });
  assert.equal(link, `https://app.splash.example/dashboard/approve/${ID}`);
});

test('an id that is not a plain identifier makes no link: a slash, a dot-dot, a query, a space, nothing', () => {
  for (const bad of ['', '../x', 'a/b', 'wsr_x?y=1', 'wsr x', 'wsr_x#y', 'a'.repeat(200), '%2e%2e', 'http://evil.example']) {
    assert.equal(approvePath(bad), null, `${JSON.stringify(bad)} has no path`);
    assert.equal(approveLink('https://app.splash.example', bad, { NODE_ENV: 'production' }), null, `${JSON.stringify(bad)} has no link`);
  }
});

test('production fails closed: no link on plain http, on a missing or unreadable address, or on localhost', () => {
  const prod = { NODE_ENV: 'production' };
  assert.equal(approveLink('http://app.splash.example', ID, prod), null);
  assert.equal(approveLink(undefined, ID, prod), null);
  assert.equal(approveLink('', ID, prod), null);
  assert.equal(approveLink('not a url', ID, prod), null);
  assert.equal(approveLink('https://localhost:3000', ID, prod), null);
  assert.equal(approveLink('https://127.0.0.1', ID, prod), null);
  assert.equal(approveLink('javascript:alert(1)', ID, prod), null);
  // A local build may use its own address.
  assert.equal(approveLink('http://localhost:3000', ID, { NODE_ENV: 'development' }), `http://localhost:3000/dashboard/approve/${ID}`);
});

/* ── The way back after signing in ────────────────────────────────────── */

test('the way back after signing in is one shape: the Approve screen of one request', () => {
  assert.equal(safeApproveReturn(`/dashboard/approve/${ID}`), `/dashboard/approve/${ID}`);
  for (const bad of [
    undefined,
    null,
    42,
    '',
    '/',
    '/dashboard',
    '/dashboard/approve',
    '/dashboard/approve/',
    `/dashboard/approve/${ID}/extra`,
    `/dashboard/approve/${ID}?next=https://evil.example`,
    `/dashboard/approve/${ID}#x`,
    `//evil.example/dashboard/approve/${ID}`,
    `https://evil.example/dashboard/approve/${ID}`,
    `/\\evil.example`,
    `/dashboard/approve/../wallet`,
    `/dashboard/approve/%2e%2e`,
    `/dashboard/approve/${ID}\n`,
    `/dashboard/settings`,
    `/api/wallet/signing-requests/${ID}`,
  ]) {
    assert.equal(safeApproveReturn(bad), null, `${JSON.stringify(bad)} goes Home`);
  }
});

/* ── The message ──────────────────────────────────────────────────────── */

async function registration() {
  const { nominateAndOpen } = await import('./helpers/approve-link.mjs');
  return nominateAndOpen();
}

test('the signing message carries the link once, says it signs nothing, and keeps the transaction code as the second check', async () => {
  const { walletSignatureMessage } = await import('../lib/server/approval-requests.ts');
  const { w, register } = await registration();
  const link = approveLink('https://app.splash.example', register.id, { NODE_ENV: 'production' });
  const text = walletSignatureMessage({
    orgName: 'Acme Trading',
    purpose: 'register_wallet',
    description: register.description,
    threshold: 2,
    signerCount: 3,
    expiresAt: new Date(register.expiresAt),
    now: new Date('2026-10-25T08:00:00Z'),
    link,
  });
  assert.equal(text.split(link).length - 1, 1, 'the link appears once');
  assert.deepEqual(text.match(/https?:\/\/\S+/g), [link], 'it is the only address in the message');
  assert.match(text, /only opens the review/i);
  assert.match(text, /signs nothing/i);
  assert.match(text, /passkey/i);
  // The code is still there to compare, in four groups of four of the hash.
  assert.match(text, new RegExp(register.bytesHash.slice(0, 16).match(/.{4}/g).join(' ')));
  assert.match(text, /transaction code/i);
  // Still says what the bytes do, and still carries no bytes and no secret.
  assert.match(text, /register the business wallet 0x[0-9a-f]{4}…[0-9a-f]{4}: 2 of 3 owners sign/);
  assert.ok(!text.includes(register.transactionBytes.slice(0, 24)), 'no transaction bytes');
  assert.ok(!/[?#]/.test(link), 'no query string or fragment on the link');
  assert.doesNotMatch(text, /token=|secret=|password/i);
  assert.match(text, /expires in 24 hours/);
  await w.client.close();
});

test('with no link (production without an https address) the message is the old one: open Splash, check the code, sign', async () => {
  const { walletSignatureMessage } = await import('../lib/server/approval-requests.ts');
  const { w, register } = await registration();
  const text = walletSignatureMessage({
    orgName: 'Acme Trading',
    purpose: 'register_wallet',
    description: register.description,
    threshold: 2,
    signerCount: 3,
    expiresAt: new Date(register.expiresAt),
    now: new Date('2026-10-25T08:00:00Z'),
    link: null,
  });
  assert.doesNotMatch(text, /https?:\/\//);
  assert.match(text, /Open Splash, check the details and the transaction code/);
  assert.match(text, new RegExp(register.bytesHash.slice(0, 16).match(/.{4}/g).join(' ')));
  await w.client.close();
});

test('the notifier sends the link to each signer who can be reached, keeps the code, and sends none in production on plain http', async () => {
  const { walletSigningNotifier } = await import('../lib/server/approval-requests.ts');
  const { w, register, stored } = await registration();
  const sent = [];
  const make = (appUrl, env) =>
    walletSigningNotifier({
      orgName: async () => 'Acme Trading',
      channels: async () => [
        { userId: 'u-two', email: 'two@acme.example', role: 'OWNER', whatsappE164: '+60102651678' },
        { userId: 'u-three', email: 'three@acme.example', role: 'OWNER', whatsappE164: null },
      ],
      settings: async () => ({ whatsappEnabled: true }),
      configured: () => true,
      send: async (to, body) => {
        sent.push({ to, body });
        return { sent: true, providerRef: 'x' };
      },
      appUrl,
      env,
    });
  const input = { orgId: 'acme', request: stored, description: register.description, userIds: ['u-two', 'u-three'], now: new Date('2026-10-25T08:00:00Z') };

  const ok = await make('https://app.splash.example', { NODE_ENV: 'production' }).notify(input);
  assert.deepEqual(ok.delivered, ['u-two']);
  assert.deepEqual(ok.unreachable, ['u-three'], 'no verified number: told in the app only');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+60102651678');
  assert.ok(sent[0].body.includes(`https://app.splash.example/dashboard/approve/${stored.id}`));
  assert.match(sent[0].body, new RegExp(register.bytesHash.slice(0, 16).match(/.{4}/g).join(' ')));

  sent.length = 0;
  const plain = await make('http://app.splash.example', { NODE_ENV: 'production' }).notify(input);
  assert.deepEqual(plain.delivered, ['u-two'], 'the message still goes: the inbox and the code do not depend on the link');
  assert.doesNotMatch(sent[0].body, /https?:\/\//, 'never a plain-http link in production');
  assert.match(sent[0].body, /Open Splash, check the details and the transaction code/);
  await w.client.close();
});

test('every message that asks someone to sign is built by walletSignatureMessage: no second wording to drift', async () => {
  const { readdir } = await import('node:fs/promises');
  const hits = [];
  for (const dir of ['lib', 'app', 'components']) {
    const walk = async (path) => {
      for (const entry of await readdir(new URL(`../${path}`, import.meta.url), { withFileTypes: true })) {
        const next = `${path}/${entry.name}`;
        if (entry.isDirectory()) await walk(next);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = await read(next);
          if (/your signature is needed/i.test(source)) hits.push(next);
        }
      }
    };
    await walk(dir);
  }
  assert.deepEqual(hits, ['lib/server/approval-requests.ts'], 'one place words the signing message (no email or push sender builds its own)');
});

/* ── Signed out, and the screen itself ────────────────────────────────── */

test('the proxy hands the layout the Approve address, only for that path, and drops a header the browser sent', async () => {
  const { NextRequest } = await import('next/server');
  const { proxy } = await import('../proxy.ts');
  const asked = (path, headers = {}) => proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
  const passed = (response) => response.headers.get(`x-middleware-request-${RETURN_HEADER}`);

  assert.equal(passed(asked(`/dashboard/approve/${ID}`)), `/dashboard/approve/${ID}`);
  assert.equal(passed(asked('/dashboard')), null);
  assert.equal(passed(asked('/dashboard/approve')), null);
  assert.equal(passed(asked(`/dashboard/approve/${ID}/more`)), null);
  // A spoofed header on another page, or on this one with another value, is not passed on.
  assert.equal(passed(asked('/dashboard', { [RETURN_HEADER]: 'https://evil.example' })), null);
  assert.equal(passed(asked(`/dashboard/approve/${ID}`, { [RETURN_HEADER]: 'https://evil.example' })), `/dashboard/approve/${ID}`);
});

test('a signed-out visit to the link goes to sign in and back, and only through the allowlist', async () => {
  const layout = await read('app/dashboard/layout.tsx');
  assert.match(layout, /safeApproveReturn/);
  assert.match(layout, /RETURN_HEADER/);
  assert.match(layout, /redirect\(`\/login\?next=\$\{encodeURIComponent\(/);
  const login = await read('app/login/page.tsx');
  assert.match(login, /safeApproveReturn\(/);
  assert.match(login, /router\.push\(returnTo \?\? '\/dashboard'\)/);
  // zkLogin keeps landing on Home (Sky's decision).
  const zk = await read('components/auth/ZkLoginButton.tsx');
  assert.doesNotMatch(zk, /safeApproveReturn|next=/);
});

test('opening the screen executes nothing: the page reads once and only the passkey button sends a signature', async () => {
  const detail = await read('components/approve/ApproveDetail.tsx');
  const loads = detail.match(/call<[^>]*>\(`\/api\/wallet\/signing-requests\/\$\{encodeURIComponent\(id\)\}`(?:, \{ method: '(\w+)' \})?\)/g) ?? [];
  assert.equal(loads.filter((c) => !/method/.test(c)).length, 1, 'one plain read on open');
  assert.deepEqual(loads.filter((c) => /method/.test(c)), [loads.find((c) => /DELETE/.test(c))].filter(Boolean), 'the only write the page itself makes is the confirmed decline or withdraw');
  assert.doesNotMatch(detail, /\/signatures/, 'the page sends no signature: SignPanel does, on the button');
  const route = await read('app/api/wallet/signing-requests/[id]/route.ts');
  assert.match(route, /export async function GET/);
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function DELETE'));
  assert.doesNotMatch(get, /submitPartialSignature|cancelSigningRequest|execute\(/, 'GET reads and nothing else');
});

test('the screen tells the person the link signed nothing, beside the transaction code, on both layouts', async () => {
  for (const path of ['components/approve/ApproveScreen.tsx', 'components/transfer/SignPanel.tsx']) {
    const source = await read(path);
    assert.match(source, /If your WhatsApp message shows a different code, do not sign\./, `${path} keeps the code check`);
    assert.match(source, /Opening this page from a link signs nothing; only your passkey does\./, `${path} says what the link is`);
  }
});

test('the link module reads no secret and no environment of its own', async () => {
  const source = await read('lib/approve/link.ts');
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /SECRET|TOKEN|PASSWORD/);
});
