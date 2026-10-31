import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64 } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { T0 } from './fixtures/wallet-world.mjs';
import { spendWorld } from './fixtures/spend-world.mjs';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { changeSpendingRule, issueSpendingRule, readSpendingRules, revokeSpendingRule, startSpendPolicy } from '../lib/server/spend-rules.ts';
import { memberRole } from '../lib/server/wallet-authority.ts';
import { liveSpendContext } from '../lib/server/spend-rules-deps.ts';
import { signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import * as schema from '../lib/db/schema.ts';

/**
 * v2 Phase 3, brief 4.2: the spending-rule screens call the §4.2 routes. What
 * the screens rely on, proven on the model chain and the real database:
 *
 *   replay       the same ask while one waits opens no second request (409
 *                request_open), a signature sent twice moves nothing twice,
 *                and a rule asked for twice becomes one rule
 *   tenancy      a person of another business, or a viewer, can be given no
 *                rule by an owner of this one
 *   fail closed  without splash_spend's ids nothing is read or built (503),
 *                and a failure is never a made-up empty list
 */

const DAY = 86_400_000n;
const USDC_1 = 1_000_000n;
const t0 = BigInt(T0.getTime());
const staffKey = softPasskey();
const STAFF = staffKey.address;

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function signBy(w, view, ...who) {
  let last;
  for (const name of who) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: name === 'founder' ? 'u-founder' : `u-${name}`, id: view.id, signature: await sign(w.keys[name], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}

async function withPolicy(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(w, register, 'two', 'three')).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const opened = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, perPaymentMaxMinor: 20_000n * USDC_1 });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal((await signBy(w, opened.request, 'founder', 'two')).status, 'executed');
  return members;
}

const rule = (over = {}) => ({ spender: STAFF, perPaymentMaxMinor: 2_000n * USDC_1, cap: { period: 'month', limitMinor: 15_000n * USDC_1 }, expiresAtMs: t0 + 90n * DAY, ...over });
const ask = (w, members, r = rule()) => issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: r });

test('asking twice for the same rule while the first waits opens one request; the second is refused, not duplicated', async () => {
  const w = await spendWorld();
  const members = await withPolicy(w);
  const first = await ask(w, members);
  assert.equal(first.ok, true, JSON.stringify(first));
  const again = await ask(w, members);
  assert.deepEqual([again.ok, again.status, again.code], [false, 409, 'request_open']);
  // A change or a take-back for the same person is the same open slot: one request at a time per person.
  const change = await changeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule({ cap: { period: 'day', limitMinor: 100n * USDC_1 } }) });
  assert.equal(change.ok, false);
  const revoke = await revokeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, spender: STAFF });
  assert.equal(revoke.ok, false);
  assert.equal([...w.spend.caps.values()].length, 0, 'nothing moved before anyone signed');
  await w.client.close();
});

test('a signature sent twice, and a rule asked for after it was given, move nothing a second time', async () => {
  const w = await spendWorld();
  const members = await withPolicy(w);
  const first = await ask(w, members);
  const signed = await signBy(w, first.request, 'two', 'three');
  assert.equal(signed.status, 'executed');
  assert.equal([...w.spend.caps.values()].length, 1);
  // The same signature again, after execution: refused, and the chain is as it was.
  const replay = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: first.request.id, signature: await sign(w.keys.two, first.request), digest: first.request.digest });
  assert.equal(replay.ok, false);
  assert.equal([...w.spend.caps.values()].length, 1);
  // Asking again is "change it instead", and nothing is opened.
  assert.equal((await ask(w, members)).code, 'rule_exists');
  // Taking it back twice: the second finds nothing to take back.
  const revoked = await revokeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, spender: STAFF });
  await signBy(w, revoked.request, 'founder', 'two');
  assert.equal((await revokeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, spender: STAFF })).code, 'no_rule');
  assert.equal((await changeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule() })).code, 'no_rule');
  assert.equal((await readSpendingRules(w.sc)).view.rules.length, 0);
  await w.client.close();
});

test('an owner cannot give a rule to a person of another business or to a viewer, and learns nothing about either', async () => {
  const { readFile } = await import('node:fs/promises');
  const w = await spendWorld();
  await w.db.insert(schema.users).values({ id: 'u-view', email: 'view@acme.test', name: 'u-view' });
  await w.db.insert(schema.memberships).values({ id: 'm-u-view', userId: 'u-view', orgId: 'acme', role: 'viewer' });
  // staffSpender asks memberRole(db, the session's org, the person): another business's person, and nobody, are both null.
  assert.equal(await memberRole(w.db, 'acme', 'u-north-staff'), null, 'another business’s staff member is not found here');
  assert.equal(await memberRole(w.db, 'acme', 'u-nobody'), null);
  assert.equal(await memberRole(w.db, 'northwind', 'u-staff'), null, 'and from northwind’s side the acme staff member is just as absent');
  assert.equal(await memberRole(w.db, 'acme', 'u-view'), 'viewer');
  assert.equal(await memberRole(w.db, 'acme', 'u-staff'), 'maker');
  const front = await readFile(new URL('../lib/server/spend-rules-route.ts', import.meta.url), 'utf8');
  const at = front.indexOf('export async function staffSpender');
  const body = front.slice(at, front.indexOf('\n}\n', at));
  assert.match(body, /role === null\) return \{ address: null, response: refusal\(404, 'No such member of this business\.'\) \}/, 'one answer for a stranger and for nobody');
  assert.match(body, /role === 'viewer'\) return \{ address: null, response: refusal\(400/);
  assert.match(body, /refusal\(409, 'This member has no passkey/);
  await w.client.close();
});

test('without splash_spend’s ids nothing is read or built: 503, in production or anywhere', async () => {
  const keep = { pkg: process.env.SPLASH_SPEND_PACKAGE_ID, reg: process.env.SPLASH_SPEND_POLICY_REGISTRY_ID, mode: process.env.USE_MOCK_APIS };
  delete process.env.SPLASH_SPEND_PACKAGE_ID;
  delete process.env.SPLASH_SPEND_POLICY_REGISTRY_ID;
  try {
    for (const mock of ['true', 'false']) {
      process.env.USE_MOCK_APIS = mock;
      const live = await liveSpendContext({ ctx: {}, db: {}, orgId: 'acme' });
      assert.equal(live.ok, false);
      assert.equal(live.status, 503);
      assert.match(live.error, /SPLASH_SPEND_PACKAGE_ID/, 'the server says exactly what is missing; the screen words it for the customer');
    }
  } finally {
    for (const [k, v] of [['SPLASH_SPEND_PACKAGE_ID', keep.pkg], ['SPLASH_SPEND_POLICY_REGISTRY_ID', keep.reg], ['USE_MOCK_APIS', keep.mode]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the rules routes never answer a failure with an empty list', async () => {
  const { readFile } = await import('node:fs/promises');
  const get = await readFile(new URL('../app/api/wallet/spending-rules/route.ts', import.meta.url), 'utf8');
  assert.match(get, /if \(gate\.response\) return gate\.response;/);
  assert.match(get, /if \(!result\.ok\) return asResponse\(result\);/);
});
