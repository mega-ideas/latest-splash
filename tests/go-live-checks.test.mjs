import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  checkFeeAddress,
  checkPasskeyDomain,
  checkPeg,
  checkScreening,
  checkTwilio,
  checkUsdyPrice,
} from '../lib/server/go-live-checks.ts';

/**
 * The setup a person does by hand, as checks `npm run doctor` and
 * /api/health report: not done is 'skipped', set and wrong is 'fail', and
 * every detail says what to do. No network here: every fetch is stubbed.
 */

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const consistent = (check) => assert.equal(check.ok, check.status !== 'fail', `ok must match status: ${JSON.stringify(check)}`);

const TWILIO = {
  TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  TWILIO_AUTH_TOKEN: 'super-secret-token',
  TWILIO_WHATSAPP_FROM: '+14155238886',
};

test('the fee wallet: not set is skipped, a non-Sui address fails, an object id fails, a wallet opens the lane', async () => {
  const wallet = async () => false;
  const unset = await checkFeeAddress({}, wallet);
  assert.equal(unset.status, 'skipped');
  assert.match(unset.detail, /USDC wallet transfers stay closed/);
  assert.equal((await checkFeeAddress({ SPLASH_FEE_ADDRESS_MAINNET: '0x52908400098527886E0F7030069857D2E4169EE7' }, wallet)).status, 'fail');

  const set = await checkFeeAddress({ SPLASH_FEE_ADDRESS_MAINNET: `0x${'ab'.repeat(32)}` }, wallet);
  assert.equal(set.status, 'ok');
  assert.match(set.detail, /0\.80% fee goes to 0xabab…abab, a wallet address on mainnet/);

  // A coin id copied from an explorer looks exactly like an address.
  const object = await checkFeeAddress({ SPLASH_FEE_ADDRESS_MAINNET: `0x${'cd'.repeat(32)}` }, async () => true);
  assert.equal(object.status, 'fail');
  assert.match(object.detail, /is an object on mainnet, not a wallet/);

  const unreachable = await checkFeeAddress({ SPLASH_FEE_ADDRESS_MAINNET: `0x${'ab'.repeat(32)}` }, async () => { throw new Error('connection reset'); });
  assert.equal(unreachable.status, 'fail');
  for (const c of [unset, set, object, unreachable]) consistent(c);
});

test('.env.example keeps the fee address blank: it is a template, and the app never reads it', () => {
  // 2026-09-26: the real address was typed into .env.example, where the app
  // did not see it (the lane stayed closed) and a commit would have published it.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^SPLASH_FEE_ADDRESS_MAINNET=\s*$/m);
});

test('without WhatsApp delivery, production refuses WhatsApp approvals instead of locking the workspace', async () => {
  const { whatsappDeliveryMissing } = await import('../lib/server/whatsapp.ts');
  assert.equal(whatsappDeliveryMissing({ NODE_ENV: 'production' }), true, 'Twilio dropped: no codes can be sent');
  assert.equal(whatsappDeliveryMissing({ NODE_ENV: 'production', ...TWILIO }), false);
  assert.equal(whatsappDeliveryMissing({ NODE_ENV: 'development' }), false, 'locally the code goes to the server log');

  // Asked first — before the main admin, the number or the passkey — for
  // switching on AND for approving in a workspace already switched on.
  const gate = readFileSync(new URL('../lib/server/step-up-gate.ts', import.meta.url), 'utf8');
  const fn = gate.slice(gate.indexOf('export async function whatsappApprovalsReady('));
  const asked = fn.indexOf('if (whatsappDeliveryMissing())');
  assert.ok(asked > 0 && asked < fn.indexOf('mainAdmin('), 'delivery is checked before anything else');
  assert.match(fn, /cannot be switched on\. Payments are approved by click until it is\./);
  assert.match(fn, /switch this workspace to click approvals/);
});

test('Twilio: proven by an account lookup that sends nothing, and the token never printed', async () => {
  assert.equal((await checkTwilio({})).status, 'skipped');
  const partial = await checkTwilio({ TWILIO_ACCOUNT_SID: TWILIO.TWILIO_ACCOUNT_SID });
  assert.equal(partial.status, 'fail');
  assert.match(partial.detail, /TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM not set/);

  const calls = [];
  const accepted = await checkTwilio(TWILIO, async (url, init) => {
    calls.push({ url: String(url), init });
    return json({ status: 'active', type: 'Trial' });
  });
  assert.equal(accepted.status, 'ok');
  assert.match(accepted.detail, /credentials accepted \(Trial account\); sending from \+14155238886/);
  assert.match(accepted.detail, /free text, which WhatsApp delivers only within 24 hours/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.json');
  assert.equal(calls[0].init.method, undefined, 'a GET: nothing is sent');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${TWILIO.TWILIO_ACCOUNT_SID}:${TWILIO.TWILIO_AUTH_TOKEN}`).toString('base64')}`);

  const templated = await checkTwilio({ ...TWILIO, TWILIO_WHATSAPP_CODE_CONTENT_SID: 'HX123' }, async () => json({ status: 'active', type: 'Full' }));
  assert.match(templated.detail, /verification template, so they arrive at any time/);

  const rejected = await checkTwilio(TWILIO, async () => json({ message: 'Authenticate' }, 401));
  assert.equal(rejected.status, 'fail');
  assert.match(rejected.detail, /rejected the Account SID and Auth Token/);
  const suspended = await checkTwilio(TWILIO, async () => json({ status: 'suspended', type: 'Full' }));
  assert.equal(suspended.status, 'fail');

  for (const c of [partial, accepted, templated, rejected, suspended]) {
    consistent(c);
    assert.doesNotMatch(c.detail, /super-secret-token/);
  }
});

test('the passkey domain: the browser only offers a passkey where it was made', () => {
  assert.equal(checkPasskeyDomain({}).status, 'ok', 'localhost in development');
  const root = checkPasskeyDomain({ PASSKEY_RP_ID: 'splashz.xyz', NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz', NODE_ENV: 'production' });
  assert.equal(root.status, 'ok');
  assert.match(root.detail, /bound to splashz\.xyz \(from PASSKEY_RP_ID\)/);

  const mismatch = checkPasskeyDomain({ PASSKEY_RP_ID: 'other.example', NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz' });
  assert.equal(mismatch.status, 'fail');
  assert.match(mismatch.detail, /the app runs on "v1\.splashz\.xyz", where browsers refuse them/);
  assert.equal(checkPasskeyDomain({ PASSKEY_RP_ID: 'splashz.xyz.evil', NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz' }).status, 'fail');

  const inferred = checkPasskeyDomain({ NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz', NODE_ENV: 'production' });
  assert.equal(inferred.status, 'ok');
  assert.match(inferred.detail, /Set PASSKEY_RP_ID to your root domain/);

  assert.equal(checkPasskeyDomain({ PASSKEY_RP_ID: 'localhost', NODE_ENV: 'production' }).status, 'fail');
  for (const c of [root, mismatch, inferred]) consistent(c);
});

test('wallet screening: a key Chainalysis accepts, rejects, or none at all', async () => {
  assert.equal((await checkScreening({})).status, 'skipped');
  const env = { CHAINALYSIS_SANCTIONS_API_KEY: 'chain-key' };
  const calls = [];
  const good = await checkScreening(env, async (url, init) => {
    calls.push({ url: String(url), key: init.headers['X-API-Key'] });
    return json({ identifications: [] });
  });
  assert.equal(good.status, 'ok');
  assert.match(calls[0].url, /^https:\/\/public\.chainalysis\.com\/api\/v1\/address\/0x0{64}$/);
  const bad = await checkScreening(env, async () => json({}, 403));
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /rejected CHAINALYSIS_SANCTIONS_API_KEY/);
  for (const c of [good, bad]) {
    consistent(c);
    assert.doesNotMatch(c.detail, /chain-key/);
  }
});

test('USDY price: Ondo’s oracle, or a failure that says what the preview does instead', async () => {
  assert.equal((await checkUsdyPrice({ USDY_ORACLE: 'off' })).status, 'skipped');
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const now = Math.floor(Date.now() / 1000);
  const good = await checkUsdyPrice({}, async () => json({ jsonrpc: '2.0', id: 1, result: `0x${word(1_147_300_010_000_000_000n)}${word(now)}` }));
  assert.equal(good.status, 'ok');
  assert.match(good.detail, /^\$1\.147300 from Ondo's oracle via ethereum-rpc\.publicnode\.com/);
  const down = await checkUsdyPrice({}, async () => new Response('bad gateway', { status: 502 }));
  assert.equal(down.status, 'fail');
  assert.match(down.detail, /falls back to USDY_REDEMPTION_USD/);
  for (const c of [good, down]) consistent(c);
});

test('the peg: DeepBook’s reading, or payouts paused, said plainly', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => json([{ trading_pairs: 'USDSUI_USDC', last_price: 1, highest_bid: 0.9999, lowest_ask: 1.0001, base_volume: 500_000 }]);
    const good = await checkPeg({});
    assert.equal(good.status, 'ok');
    assert.match(good.detail, /^USDSUI_USDC mid 1\.0000, 0 bps from 1/);

    globalThis.fetch = async () => new Response('down', { status: 503 });
    const none = await checkPeg({});
    assert.equal(none.status, 'fail');
    assert.match(none.detail, /payouts pause \(peg_unverified\)/);

    globalThis.fetch = async () => json([{ trading_pairs: 'USDSUI_USDC', last_price: 0.97, highest_bid: 0.9690, lowest_ask: 0.9700, base_volume: 500_000 }]);
    const broken = await checkPeg({});
    assert.equal(broken.status, 'fail');
    assert.match(broken.detail, /past the tolerance/);
    for (const c of [good, none, broken]) consistent(c);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('doctor and /api/health both show every go-live check, by name', () => {
  const health = readFileSync(new URL('../lib/server/health-checks.ts', import.meta.url), 'utf8');
  const doctor = readFileSync(new URL('../scripts/doctor.mjs', import.meta.url), 'utf8');
  for (const key of ['laneNode', 'peg', 'usdyPrice', 'feeAddress', 'twilio', 'passkeyDomain', 'screening']) {
    assert.match(health, new RegExp(`\\b${key}\\b`), `${key} in the health report`);
    assert.match(doctor, new RegExp(`\\b${key}: '`), `${key} named in doctor`);
  }
});

test('the admin Go-live page shows every check in the report, staff-only, and never by colour alone', () => {
  const page = readFileSync(new URL('../app/admin/(console)/go-live/page.tsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../components/admin/GoLiveView.tsx', import.meta.url), 'utf8');
  const health = readFileSync(new URL('../lib/server/health-checks.ts', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../app/admin/(console)/layout.tsx', import.meta.url), 'utf8');
  // Every key the report carries has a row, so a new check cannot go unseen.
  const block = health.slice(health.indexOf('checks: {'), health.indexOf('};', health.indexOf('checks: {')));
  const keys = [...block.matchAll(/\b([a-zA-Z]+): Check\b/g)].map((m) => m[1]);
  assert.ok(keys.length >= 12, `found ${keys.length} report keys`);
  for (const key of keys) assert.match(view, new RegExp(`key: '${key}'`), `${key} has a row on the page`);
  // The same module as doctor and /api/health.
  assert.match(page, /runHealthChecks\(\)/);
  // Under (console), whose layout redirects anyone without a staff session.
  assert.match(layout, /if \(!session\) \{\s*redirect\(/);
  assert.match(layout, /label: 'Go-live', href: '\/admin\/go-live'/);
  // Each status has a word next to its colour.
  for (const word of ["word: 'Working'", "word: 'Not set up'", "word: 'Failing'"]) assert.ok(view.includes(word), word);
});
