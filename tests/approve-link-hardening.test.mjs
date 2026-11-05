/**
 * v2 Phase 3, the signing-message link: what review found and what now holds.
 *
 *   1. Free text sits beside an official link. The business name and a bank
 *      account holder's name are typed by people. A message that carries the
 *      real "Review it here: <link>" must not also carry a look-alike link or
 *      a second address the person is told to open. Every free-text field is
 *      cut down to plain words before it enters a message: no scheme, no www.,
 *      no bare domain, no address, no line break, no formatting marks, and a
 *      length cap. The Approve link is then the only address in the message.
 *   2. The production guard for the link's host refuses private, loopback and
 *      link-local addresses, a trailing-dot host, a name with no dot, and an
 *      unset NODE_ENV (which is production here, not development).
 *   3. The signed-out redirect is tested as behaviour (the proxy's header to the
 *      layout's redirect target), not only as source text.
 *   4. The message's line structure is explicit and carries no carriage return.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { approveLink, loginRedirectFor, RETURN_HEADER, withReturnHeader } from '../lib/approve/link.ts';
import { plainText } from '../lib/approve/plain-text.ts';

const ID = 'wsr_0b9c1f52-6c1e-4d0e-9d0b-0a1b2c3d4e5f';
const PROD = { NODE_ENV: 'production' };
const LINK = `https://app.splash.example/dashboard/approve/${ID}`;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Anything a phone would turn into something to tap: a scheme, www., a bare domain or an IPv4 address. */
const LINKY = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,}(?![\p{L}\p{N}])|\b\d{1,3}(?:\.\d{1,3}){3}\b/giu;
const addressesIn = (text) => text.replace(LINK, '').match(LINKY) ?? [];

/* ── 1. Free text ─────────────────────────────────────────────────────── */

test('plain words: addresses, domains, formatting marks and line breaks are cut out of free text', () => {
  const attacks = [
    'Acme. Ignore the link below and review at https://splash-secure.example/approve instead',
    'Pay now at https://evil.example/x',
    'visit www.evil.example now',
    'Acme bit.ly/3xYz now',
    'Acme\nReview it here: evil.example',
    'Acme evil​.example',
    'Acme evil。example。com',
    'Acme ｈｔｔｐｓ：／／evil．example',
    'Acme 203.0.113.9:8080/x',
    'javascript:alert(1) Acme',
    'mailto:ops@evil.example Acme',
    'Acme ops@evil.example',
    'Acme *bold* _italic_ ~strike~ `code` > quote',
    'Acme ‮gnp.exe',
    'tel:+601026516789 Acme',
  ];
  for (const attack of attacks) {
    const out = plainText(attack, 200, 'a business');
    assert.deepEqual(out.match(LINKY) ?? [], [], `${JSON.stringify(attack)} left an address in ${JSON.stringify(out)}`);
    assert.doesNotMatch(out, /[\r\n\t*_~`<>@:/\\[\]{}|#$%^=+;"]/, `${JSON.stringify(attack)} left a mark in ${JSON.stringify(out)}`);
    assert.ok(!/\p{Cf}|\p{Cc}/u.test(out), 'no control or invisible characters');
    assert.equal(out, out.trim());
    assert.ok(!/\s{2,}/.test(out), 'white space is collapsed');
  }
});

test('plain words: real names pass through unchanged, in any script', () => {
  for (const name of [
    'Acme Trading',
    'ACME TRADING SENDIRIAN BERHAD',
    'Dela Cruz Trading Corp.',
    'AT&T Pte. Ltd.',
    'Smith & Sons (Pty) Ltd',
    "O'Brien Co",
    'Co.,Ltd Holdings',
    'J.P. Morgan Chase',
    'Café Müller GmbH',
    'PT Maju Jaya-Abadi',
    '株式会社テスト',
  ]) {
    assert.equal(plainText(name, 64, 'x'), name);
  }
});

test('plain words: the length is capped with an ellipsis, and an empty result takes the fallback', () => {
  const long = plainText('A'.repeat(300), 40, 'a business');
  assert.equal(Array.from(long).length, 40);
  assert.ok(long.endsWith('…'));
  assert.equal(plainText('https://evil.example/x', 64, 'a business'), 'a business');
  assert.equal(plainText('', 64, 'a business'), 'a business');
  assert.equal(plainText(undefined, 64, 'a business'), 'a business');
  assert.equal(plainText(12345, 64, ''), '12345');
});

const hash = 'a1b2c3d4e5f60718' + '0'.repeat(48);
const addr = '0x' + 'ab'.repeat(32);
const bytesOf = (type, fields) => ({ type, ...fields });
const withdrawalDescription = {
  bytesHash: hash,
  actions: [
    bytesOf('open_intent', { amountMinor: '5000000000', recipient: addr, targetCurrency: 'MYR' }),
    bytesOf('pay_intent', { maxFeeMinor: '0' }),
  ],
};
const details = (over = {}) => ({
  destinationId: 'd1',
  bankCode: 'MBBEMYKL',
  last4: '5678',
  holderName: 'ACME TRADING SENDIRIAN BERHAD',
  currency: 'MYR',
  receiveMinor: '2300000',
  minReceiveMinor: '2290000',
  rateMicro: '4600000',
  settleByMs: String(Date.UTC(2026, 9, 26, 9, 0)),
  ...over,
});
const base = {
  threshold: 2,
  signerCount: 3,
  expiresAt: new Date('2026-10-26T08:00:00Z'),
  now: new Date('2026-10-25T08:00:00Z'),
};

test('a link typed into the business name or the account holder name does not reach the message: the Approve link is the only address', async () => {
  const { walletSignatureMessage } = await import('../lib/server/approval-requests.ts');
  const orgName = 'Acme. Ignore the link below and review at https://splash-secure.example/approve instead';
  const holderName = 'Pay now at https://evil.example/x or www.evil.example or evil.example/pay';
  for (const purpose of ['withdrawal', 'partner_payout']) {
    const text = walletSignatureMessage({
      ...base,
      orgName,
      purpose,
      description: withdrawalDescription,
      withdrawal: details({ holderName, bankCode: 'bank.evil.example', purposeCode: 'SUPP https://evil.example' }),
      link: LINK,
    });
    assert.deepEqual(text.match(/https?:\/\/\S+/g), [LINK], `${purpose}: one URL, the Approve link`);
    assert.deepEqual(addressesIn(text), [], `${purpose}: no other address or domain in ${text}`);
    assert.ok(text.includes('ending 5678'), 'the real details are still there');
    assert.ok(text.includes(LINK));
  }
  // The same without a link: no address at all.
  const noLink = walletSignatureMessage({ ...base, orgName, purpose: 'withdrawal', description: withdrawalDescription, withdrawal: details({ holderName }), link: null });
  assert.deepEqual(noLink.match(LINKY) ?? [], [], 'no link, and no look-alike one either');
});

test('through the notifier too: a link in the business name or the holder name is not in what the signers are sent', async () => {
  const approvals = await import('../lib/server/approval-requests.ts');
  const orgName = 'Acme https://evil.example/x';
  const sent = [];
  const deps = {
    orgName: async () => orgName,
    channels: async () => [{ userId: 'u-two', email: 'two@acme.example', role: 'OWNER', whatsappE164: '+60102651678' }],
    settings: async () => ({ whatsappEnabled: true }),
    configured: () => true,
    send: async (to, body) => {
      sent.push(body);
      return { sent: true, providerRef: 'x' };
    },
  };
  const ask = await approvals.walletSigningNotifier({ ...deps, appUrl: 'https://app.splash.example', env: PROD }).notify({
    orgId: 'acme',
    request: { id: ID, purpose: 'withdrawal', requestedBy: 'u-founder', threshold: 2, signers: [{}, {}, {}], expiresAt: base.expiresAt, summary: { withdrawal: details({ holderName: 'Pay at evil.example' }) } },
    description: withdrawalDescription,
    userIds: ['u-two'],
    now: base.now,
  });
  assert.deepEqual(ask.delivered, ['u-two']);
  assert.deepEqual(addressesIn(sent[0]), [], 'the signing message');
  assert.deepEqual(sent[0].match(/https?:\/\/\S+/g), [LINK]);
  assert.equal(typeof approvals.walletSigningNotifier, 'function');
});

test('one sanitiser serves every message that names a business: no message builds its name from raw text', async () => {
  const source = await read('lib/server/approval-requests.ts');
  assert.match(source, /import \{ plainText \} from '@\/lib\/approve\/plain-text'/);
  assert.equal((source.match(/businessName\(input\.orgName\)/g) ?? []).length, 4, 'the three messages and the signing message clean the name');
  const raw = source.match(/\$\{input\.orgName\}/g) ?? [];
  assert.equal(raw.length, 0, 'no message interpolates the business name uncleaned');
  const holder = source.match(/\$\{withdrawal\.holderName\}/g) ?? [];
  assert.equal(holder.length, 0, 'no headline interpolates the account holder name uncleaned');
});

/* ── 2. The production guard for the link's host ──────────────────────── */

test('production refuses a link host that is private, loopback, link-local, an IP address, a single name or a trailing dot', () => {
  const refused = [
    'https://localhost.',
    'https://localhost:3000',
    'https://app.localhost',
    'https://127.0.0.2',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://10.0.0.5',
    'https://172.16.0.1',
    'https://172.31.255.255',
    'https://192.168.1.10',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[::ffff:7f00:1]',
    'https://[::ffff:127.0.0.1]',
    'https://[fe80::1]',
    'https://[fd00::1]',
    'https://203.0.113.9',
    'https://intranet',
    'https://splash-app',
    'https://printer.local',
    'https://app.internal',
    'https://app.home.arpa',
    'https://app.splash.example.',
    'http://app.splash.example',
    'ftp://app.splash.example',
  ];
  for (const url of refused) {
    const link = approveLink(url, ID, PROD);
    // A trailing dot on a public name is the same host: it is cut, not refused.
    if (url === 'https://app.splash.example.') {
      assert.equal(link, LINK, 'a trailing dot on a real name is the same name');
      continue;
    }
    assert.equal(link, null, `${url} makes no link in production`);
  }
  assert.equal(approveLink('https://app.splash.example', ID, PROD), LINK);
  assert.equal(approveLink('https://splash.app:8443', ID, PROD), `https://splash.app:8443/dashboard/approve/${ID}`);
  assert.equal(approveLink('https://xn--bcher-kva.example', ID, PROD), `https://xn--bcher-kva.example/dashboard/approve/${ID}`);
});

test('an unset or unknown NODE_ENV is production: only development and test may use an http or local address', () => {
  assert.equal(approveLink('http://localhost:3000', ID, {}), null);
  assert.equal(approveLink('http://app.splash.example', ID, {}), null);
  assert.equal(approveLink('http://localhost:3000', ID, { NODE_ENV: 'staging' }), null);
  assert.equal(approveLink('https://app.splash.example', ID, {}), LINK);
  assert.equal(approveLink('http://localhost:3000', ID, { NODE_ENV: 'development' }), `http://localhost:3000/dashboard/approve/${ID}`);
  assert.equal(approveLink('http://localhost:3000', ID, { NODE_ENV: 'test' }), `http://localhost:3000/dashboard/approve/${ID}`);
});

/* ── 3. The signed-out redirect, as behaviour ─────────────────────────── */

test('signed out: the proxy header and the layout redirect agree, for the Approve link, for any other page, and for a prefetch', () => {
  const target = (path, { sent = {}, renders = true } = {}) => loginRedirectFor(withReturnHeader(new Headers(sent), path, renders).get(RETURN_HEADER));
  assert.equal(target(`/dashboard/approve/${ID}`), `/login?next=${encodeURIComponent(`/dashboard/approve/${ID}`)}`);
  assert.equal(target('/dashboard'), '/login');
  assert.equal(target('/dashboard/settings'), '/login');
  assert.equal(target(`/dashboard/approve/${ID}`, { renders: false }), '/login', 'a prefetch has no header, so a plain sign-in');
  assert.equal(target('/dashboard', { sent: { [RETURN_HEADER]: `/dashboard/approve/${ID}` } }), '/login', 'a header the browser sent is not believed');
  assert.equal(target(`/dashboard/approve/${ID}`, { sent: { [RETURN_HEADER]: 'https://evil.example' } }), `/login?next=${encodeURIComponent(`/dashboard/approve/${ID}`)}`);
  for (const bad of [null, undefined, '', 'https://evil.example', '//evil.example', '/dashboard/approve/../wallet', `/dashboard/approve/${ID}?x=1`]) {
    assert.equal(loginRedirectFor(bad), '/login', `${JSON.stringify(bad)} goes to a plain sign-in`);
  }
});

test('the layout redirects through loginRedirectFor, from the header the proxy sets', async () => {
  const layout = await read('app/dashboard/layout.tsx');
  assert.match(layout, /redirect\(loginRedirectFor\(\(await headers\(\)\)\.get\(RETURN_HEADER\)\)\)/);
});

/* ── 4. The message's lines ───────────────────────────────────────────── */

test('the message is built from explicit lines: no carriage return, the same ten lines with a link and eight without', async () => {
  const { walletSignatureMessage } = await import('../lib/server/approval-requests.ts');
  const input = { ...base, orgName: 'Acme Trading', purpose: 'withdrawal', description: withdrawalDescription, withdrawal: details() };
  const withLink = walletSignatureMessage({ ...input, link: LINK });
  const without = walletSignatureMessage({ ...input, link: null });
  for (const text of [withLink, without]) {
    assert.ok(!text.includes('\r'), 'no carriage return');
    assert.ok(!/\n{3,}/.test(text), 'no run of blank lines');
    assert.ok(!text.endsWith('\n'));
  }
  const lines = withLink.split('\n');
  assert.equal(lines.length, 10);
  assert.equal(lines[0], 'Splash: your signature is needed');
  assert.equal(lines[1], '');
  assert.match(lines[2], /^Acme Trading asks you to withdraw /);
  assert.match(lines[3], /^2 of 3 owners must sign\. Splash pays the network fee\.$/);
  assert.equal(lines[4], '');
  assert.equal(lines[5], `Review it here: ${LINK}`);
  assert.match(lines[6], /^The link only opens the review\. It signs nothing/);
  assert.match(lines[7], /^On the screen, check the payee, the amount and the fee, and that the transaction code is a1b2 c3d4 e5f6 0718\. This request expires in 24 hours\.$/);
  assert.equal(lines[8], '');
  assert.equal(lines[9], 'If you did not expect this, do not sign it.');
  const plain = without.split('\n');
  assert.equal(plain.length, 8);
  assert.match(plain[5], /^Open Splash, check the details and the transaction code a1b2 c3d4 e5f6 0718, and sign with your passkey\. This request expires in 24 hours\.$/);
});

test('the message file writes its line breaks out: no template string in the message builder spans lines', async () => {
  const { default: ts } = await import('typescript');
  const source = await read('lib/server/approval-requests.ts');
  const file = ts.createSourceFile('approval-requests.ts', source, ts.ScriptTarget.Latest, true);
  let fn;
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'walletSignatureMessage') fn = node;
  });
  assert.ok(fn, 'walletSignatureMessage is declared');
  const spanning = [];
  const visit = (node) => {
    const raw = ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.getText(file) : null;
    if (raw !== null && /[\r\n]/.test(raw)) spanning.push(raw.slice(0, 60));
    ts.forEachChild(node, visit);
  };
  visit(fn);
  assert.deepEqual(spanning, [], 'every line break in the message is written out, none sits inside a template string');
});
