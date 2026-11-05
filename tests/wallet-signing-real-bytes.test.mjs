/**
 * The signing screen's wording, run over commands decoded from real
 * transaction bytes (the spend-rules world builds and decodes them), not over
 * hand-written actions: nothing the decoder returns for a policy or a rule
 * is unworded, and the spender, the amounts and the window are all there.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fromBase64 } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { spendWorld } from './fixtures/spend-world.mjs';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { issueSpendingRule, startSpendPolicy } from '../lib/server/spend-rules.ts';
import { signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { signingItems } from '../lib/wallet-page/actions.ts';

const USDC_1 = 1_000_000n;

test('a real policy request and a real rule request are worded in full from their decoded commands', async () => {
  const w = await spendWorld();
  const signBy = async (view, ...who) => {
    let last;
    for (const n of who) {
      const sig = (await w.keys[n].keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
      last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: n === 'founder' ? 'u-founder' : `u-${n}`, id: view.id, signature: sig, digest: view.digest });
      assert.equal(last.ok, true, JSON.stringify(last));
    }
    return last.request;
  };
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  await signBy(started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(register, 'two', 'three')).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };

  const policy = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, perPaymentMaxMinor: 20_000n * USDC_1 });
  assert.equal(policy.ok, true, JSON.stringify(policy));
  const policyItems = signingItems(policy.request.description.actions);
  assert.ok(policyItems.length > 0 && policyItems.every((i) => !i.unknown), 'every policy command is worded');
  assert.match(policyItems.map((i) => i.line).join(' '), /20,000\.00 USDC/);
  assert.equal((await signBy(policy.request, 'founder', 'two')).status, 'executed');

  const staff = softPasskey();
  const rule = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: { spender: staff.address, perPaymentMaxMinor: 2_000n * USDC_1, cap: { period: 'month', limitMinor: 15_000n * USDC_1 }, expiresAtMs: BigInt(Date.now()) + 90n * 86_400_000n } });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  const items = signingItems(rule.request.description.actions);
  assert.deepEqual(rule.request.description.actions.map((a) => a.type), ['add_spender', 'rate_limit', 'wrap_rate_limit', 'propose_allowance', 'accept_allowance']);
  assert.equal(items.length, 5, 'one item per decoded command, none folded into a generic line');
  assert.ok(items.every((i) => !i.unknown), 'nothing is left unworded');
  const shown = items.flatMap((i) => i.fields.map((f) => f.value));
  assert.ok(shown.includes(staff.address), 'the spender address is shown in full');
  const text = items.map((i) => `${i.line} ${i.fields.map((f) => `${f.label} ${f.value}`).join(' ')}`).join('\n');
  assert.match(text, /2,000\.00 USDC/);
  assert.match(text, /15,000\.00 USDC each calendar month/);
  assert.doesNotMatch(text, /Change your spending rules/);
  await w.client.close();
});
