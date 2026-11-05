/**
 * A business with a wallet, a spending policy, USDC, a verified recipient and
 * the helpers a staff-payment test needs: the model chain of spend-world.mjs
 * with software passkeys. Shared by the staff-rule tests that need a world;
 * every test makes its own.
 */
import assert from 'node:assert/strict';

import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import { LAUNCH_SCHEDULE, splashFee } from '../../lib/fees/schedule.ts';
import { buildBusinessMultisig } from '../../lib/wallet/business-multisig.ts';
import { startBusinessWallet } from '../../lib/server/business-wallet.ts';
import { changeRecipients, issueSpendingRule, startSpendPolicy } from '../../lib/server/spend-rules.ts';
import { signingInbox, submitPartialSignature } from '../../lib/server/wallet-signing.ts';
import { softPasskey } from './soft-passkey.mjs';
import { spendWorld } from './spend-world.mjs';
import { T0 } from './wallet-world.mjs';

export const U = (n) => BigInt(Math.round(n * 1_000_000));
export const DAY = 86_400_000n;
export const t0 = BigInt(T0.getTime());
export const OPERATOR = normalizeSuiAddress(`0x${'0e'.repeat(32)}`);
export const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
export const STRANGER = normalizeSuiAddress(`0x${'78'.repeat(32)}`);
export const NORTH_WALLET = normalizeSuiAddress(`0x${'99'.repeat(32)}`);
export const staffKey = softPasskey();
export const staff2Key = softPasskey();
export const STAFF = { userId: 'u-staff', role: 'MAKER' };
export const STAFF2 = { userId: 'u-staff2', role: 'MAKER' };
export const OWNER = { userId: 'u-founder', role: 'OWNER' };
export const feeFor = (principal, kind = 1) => splashFee({ kind, principalMinor: principal, discountBps: 0, schedule: LAUNCH_SCHEDULE });

export async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

export async function signBy(w, view, name) {
  let last;
  for (const who of Array.isArray(name) ? name : [name]) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: who === 'founder' ? 'u-founder' : `u-${who}`, id: view.id, signature: await sign(w.keys[who], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}

/** The staff member's own signature on their own payment, as the person signs it. */
export const signOwn = async (w, who, key, view) => submitPartialSignature(w.signing, { orgId: 'acme', userId: who, id: view.id, signature: await sign(key, view), digest: view.digest });

export async function setup(opts = {}) {
  const w = await spendWorld({ feeOf: (amount) => feeFor(amount), ...opts });
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(w, register, ['two', 'three'])).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  const members = { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
  const policy = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, perPaymentMaxMinor: U(20_000) });
  assert.equal((await signBy(w, policy.request, ['founder', 'two'])).status, 'executed');
  w.balances.set(wallet.address, { coinMinor: 0n, addressBalanceMinor: U(100_000) });

  const calls = { asks: [], records: 0 };
  const rule = (spender, over = {}) => ({ spender, perPaymentMaxMinor: U(2_000), cap: { period: 'month', limitMinor: U(15_000) }, expiresAtMs: t0 + 90n * DAY, ...over });
  const give = async (r) => {
    const opened = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: r });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal((await signBy(w, opened.request, ['two', 'three'])).status, 'executed');
  };
  const verify = async (address, tag = 'wallet') => {
    const opened = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address, tag }] } });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal((await signBy(w, opened.request, ['two', 'three'])).status, 'executed');
  };
  await w.screenClear(SUPPLIER);
  const recipientId = await w.saveRecipient(SUPPLIER);
  await verify(SUPPLIER);

  const deps = (orgId = 'acme', over = {}) => ({
    db: w.db,
    orgId,
    env: { NODE_ENV: 'test' },
    now: () => w.signing.now(),
    ctx: w.ctx,
    walletMembers: async () => (orgId === 'acme' ? { ok: true, address: wallet.address, members } : { ok: false, status: 409, code: 'no_wallet', error: 'register the business wallet first' }),
    splashAddresses: async () => [OPERATOR, w.sponsor.address],
    isBusinessWallet: async (address) => normalizeSuiAddress(address) === NORTH_WALLET,
    businessWallet: async () => null,
    searchBusinesses: async () => [],
    splashFee: async ({ kind, principalMinor }) => ({ feeMinor: feeFor(principalMinor, kind), feesOn: true }),
    paymentRecord: async () => {
      calls.records += 1;
      return { ok: true, contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-tx') };
    },
    requesterAddresses: async (userId) => (userId === 'u-staff' ? [staffKey.address] : userId === 'u-staff2' ? [staff2Key.address] : []),
    staffSigner: async (userId) => {
      const k = userId === 'u-staff' ? staffKey : userId === 'u-staff2' ? staff2Key : null;
      return k ? { publicKey: k.publicKey, address: k.address } : null;
    },
    spend: w.sc,
    notifyAsk: async (n) => calls.asks.push(n),
    ...over,
  });
  return { w, wallet, members, deps, calls, rule, give, verify, recipientId };
}

export const input = (recipientId, over = {}) => ({
  clientKey: 'tx_key_000001',
  payee: { kind: 'recipient', recipientId },
  amountMinor: U(1_000).toString(),
  maxFeeMinor: feeFor(U(1_000)).toString(),
  reference: 'INV-0042',
  ...over,
});
export const amountInput = (recipientId, usdc, over = {}) => input(recipientId, { amountMinor: U(usdc).toString(), maxFeeMinor: feeFor(U(usdc)).toString(), ...over });
