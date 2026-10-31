/**
 * The Business Splash Wallet after its independent review (v2 §4.1).
 *
 * Each block is one finding or one missing requirement, reproduced first:
 *
 *   1  (High)   paying an existing intent blind: the bytes name only an
 *               object, so the quorum must be shown the intent's payee and
 *               amount read from the chain, and no other intent is accepted
 *   2  (Medium) a request stuck in `submitting` keeps signatures and blocks
 *               its key: the cron reconciles it
 *   3  (Medium) timeout ambiguity recorded as failed: it is `unknown`, and a
 *               transaction that landed runs its follow-up later
 *   4  (Medium) any one signer could cancel: only the requester cancels, a
 *               signer declines
 *   5  (Medium) mainnet wallets gated in code, not only by a checklist
 *   6  (Medium) the founder alone chose single-signer, and owners without a
 *               passkey were dropped silently
 *   7  (Low)    the founder guessed from grantedBy; one passkey per owner
 *   8  (Low)    migration paging, and every member's addresses detected
 *   9  (Low)    sponsor budget per org, rate limits, one bad row in the inbox
 *   10 (Low)    the device decodes the bytes itself; a 64-bit code
 *   +  members become on-chain owners before registration; rotation, its
 *      confirmation and the old wallet's funds; the current wallet is read
 *      from the chain; routes for rotation, membership and consent
 *
 * PGlite with every migration, software passkeys, and the model chain in
 * tests/fixtures/wallet-world.mjs, which refuses what splash_core refuses.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { fromBase64, normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { ACCOUNT, chainCfg, expect, T0, USDC, world } from './fixtures/wallet-world.mjs';
import * as schema from '../lib/db/schema.ts';
import { EnvValidationError, parseEnv } from '../lib/env.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { reviewOnDevice, transactionCode } from '../lib/wallet/review-on-device.ts';
import { describeWalletTransaction } from '../lib/wallet/wallet-tx-describe.ts';
import { payOpenIntentFromWalletTx } from '../lib/server/sui-v2-builders.ts';
import {
  changeWalletMembership,
  collectCoins,
  currentWalletMembers,
  planBusinessWallet,
  requestOpenIntentPayment,
  startBusinessWallet,
  startWalletRotation,
} from '../lib/server/business-wallet.ts';
import { memberWalletAddresses, pickWalletMembers } from '../lib/server/wallet-members.ts';
import { walletNetworkGate } from '../lib/server/wallet-network-gate.ts';
import {
  cancelSigningRequest,
  declineSigningRequest,
  openSigningRequest,
  readRequestForSigner,
  reconcileSigningRequestsForStaff,
  signingInbox,
  submitPartialSignature,
  SUBMISSION_LEASE_MS,
} from '../lib/server/wallet-signing.ts';
import {
  claimSubmission,
  countLingeringSignaturesForStaff,
  countStuckSubmissionsForStaff,
  readSigningRequest,
  recordSingleSignerConsent,
  singleSignerConsents,
} from '../lib/server/wallet-signing-store.ts';

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

const founderOf = (w) => ({ userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey });

async function nominate(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: founderOf(w), owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  return started.request;
}

async function nominateAndOpenRegistration(w) {
  const n = await nominate(w);
  const done = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: n.id, signature: await sign(w.keys.founder, n), digest: n.digest });
  assert.equal(done.request.status, 'executed', JSON.stringify(done));
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.ok(register, 'the registration request is open');
  return { nominate: n, register };
}

async function signBy(w, view, ...who) {
  let last;
  for (const name of who) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: name === 'founder' ? 'u-founder' : `u-${name}`, id: view.id, signature: await sign(w.keys[name], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}

async function registered(w) {
  const { register } = await nominateAndOpenRegistration(w);
  const done = await signBy(w, register, 'two', 'three');
  assert.equal(done.status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

const INTENT = normalizeSuiAddress('0x' + '99'.repeat(32));
const PAYEE = normalizeSuiAddress('0x' + '77'.repeat(32));

function staffIntent(overrides = {}) {
  return {
    id: INTENT,
    initialSharedVersion: 7,
    account: ACCOUNT,
    recipient: PAYEE,
    amountMinor: 12_500_000_000n,
    kind: 1,
    targetCurrency: 'USDC',
    fxRateUsdLocal: 1_000_000n,
    expiresAtMs: BigInt(T0.getTime() + 3 * 24 * 3600_000),
    status: 0,
    asset: USDC,
    ...overrides,
  };
}

const audit = { contentHash: new Uint8Array(32).fill(4), walrusBlobId: new TextEncoder().encode('blob-1') };

/* ── 1. Paying an existing intent ─────────────────────────────────────── */

test('1: bytes that pay an intent nobody read from the chain are refused before anyone is asked', async () => {
  // The reviewer's reproduction: an arbitrary shared intent, maxFee 0.
  const w = await world();
  const { wallet, members } = await registered(w);
  const bytes = await payOpenIntentFromWalletTx(chainCfg, {
    wallet: wallet.address,
    account: w.ctx.account,
    intent: { objectId: INTENT, initialSharedVersion: 7 },
    amountMinor: 999_000_000n,
    maxFeeMinor: 0n,
    settleByMs: BigInt(T0.getTime() + 600_000),
    ...audit,
    gas: await w.sponsor.gasFor(),
  });
  const r = await openSigningRequest(w.signing, { orgId: 'acme', requestedBy: 'u-two', purpose: 'wallet_payment', dedupeKey: 'x', transactionBytes: bytes, signer: { kind: 'multisig', ...members }, gasMode: 'sponsored' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'open_intent_unchecked');

  // Bound to another intent than the one the bytes pay: refused too.
  const other = await openSigningRequest(w.signing, {
    orgId: 'acme', requestedBy: 'u-two', purpose: 'wallet_payment', dedupeKey: 'y', transactionBytes: bytes, signer: { kind: 'multisig', ...members }, gasMode: 'sponsored',
    openIntent: { intentId: '0x' + '98'.repeat(32), recipient: PAYEE, amountMinor: '999000000', kind: 1, targetCurrency: 'USDC', fxRateUsdLocal: '1000000', expiresAtMs: String(T0.getTime() + 86_400_000), asset: USDC },
  });
  assert.equal(other.code, 'wrong_object');

  // Bound to the right intent, but withdrawing more than its principal + fee.
  const wrongAmount = await openSigningRequest(w.signing, {
    orgId: 'acme', requestedBy: 'u-two', purpose: 'wallet_payment', dedupeKey: 'z', transactionBytes: bytes, signer: { kind: 'multisig', ...members }, gasMode: 'sponsored',
    openIntent: { intentId: INTENT, recipient: PAYEE, amountMinor: '1000', kind: 1, targetCurrency: 'USDC', fxRateUsdLocal: '1000000', expiresAtMs: String(T0.getTime() + 86_400_000), asset: USDC },
  });
  assert.equal(wrongAmount.code, 'wrong_shape');
  assert.equal((await w.db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.purpose, 'wallet_payment'))).length, 0);
  await w.client.close();
});

test("1: the owners pay a staff member's intent seeing its payee, amount and rate, read from the chain", async () => {
  const w = await world();
  const { members } = await registered(w);
  w.model.addIntent(staffIntent());
  await w.screenClear(PAYEE);
  await w.saveRecipient(PAYEE);
  const opened = await requestOpenIntentPayment(w.ctx, {
    orgId: 'acme', requestedBy: 'u-two', wallet: members, intentId: INTENT, maxFeeMinor: 250_000n, settleByMs: BigInt(T0.getTime() + 5 * 60_000), ...audit,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const [withdraw, pay] = opened.request.description.actions;
  assert.equal(pay.type, 'pay_intent');
  assert.equal(pay.intent.recipient, PAYEE);
  assert.equal(pay.intent.amountMinor, '12500000000');
  assert.equal(pay.intent.fxRateUsdLocal, '1000000');
  assert.equal(withdraw.amountMinor, String(12_500_000_000n + 250_000n), 'exactly principal + max_fee');

  // The message names the payee and the amount.
  const { walletRequestHeadline } = await import('../lib/server/approval-requests.ts');
  const line = walletRequestHeadline('wallet_payment', opened.request.description);
  assert.match(line, /pay 12,500\.00 USDC to 0x7777…7777/);

  // Re-read, the stored binding still decodes the bytes (and the inbox too).
  const view = await readRequestForSigner(w.signing, { orgId: 'acme', userId: 'u-three', id: opened.request.id });
  assert.equal(view.request.valid, true);
  assert.equal(view.request.description.actions[1].intent.recipient, PAYEE);
  const done = await signBy(w, view.request, 'two', 'three');
  assert.equal(done.status, 'executed');
  assert.equal(w.model.state.intents.get(INTENT).status, 1);
  await w.client.close();
});

test("1: another org's intent reads as absent, and a spent or expired one is refused", async () => {
  const w = await world();
  const { members } = await registered(w);
  const ask = { orgId: 'acme', requestedBy: 'u-two', wallet: members, intentId: INTENT, maxFeeMinor: 0n, settleByMs: BigInt(T0.getTime() + 60_000), ...audit };
  w.model.addIntent(staffIntent({ account: '0x' + 'ad'.repeat(32) }));
  assert.equal((await requestOpenIntentPayment(w.ctx, ask)).status, 404);
  w.model.addIntent(staffIntent({ status: 1 }));
  assert.equal((await requestOpenIntentPayment(w.ctx, ask)).code, 'intent_not_open');
  w.model.addIntent(staffIntent({ expiresAtMs: BigInt(T0.getTime() - 1) }));
  assert.equal((await requestOpenIntentPayment(w.ctx, ask)).code, 'intent_expired');
  assert.equal((await requestOpenIntentPayment(w.ctx, { ...ask, intentId: '0x' + '55'.repeat(32) })).status, 404);
  await w.client.close();
});

/* ── 2. Stuck in submitting ───────────────────────────────────────────── */

test('2: a submission stuck past the lease is reconciled: signatures cleared, key held until the chain answers', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id, signature: await sign(w.keys.two, register), digest: register.digest });
  // The process that claimed the submission dies here.
  assert.equal(await claimSubmission(w.db, 'acme', register.id, T0), true);
  const later = new Date(T0.getTime() + SUBMISSION_LEASE_MS + 1);
  assert.equal(await countStuckSubmissionsForStaff(w.db, new Date(later.getTime() - SUBMISSION_LEASE_MS)), 1, 'the health check sees it');

  const tally = await reconcileSigningRequestsForStaff({ db: w.db, chain: w.chain, now: () => later });
  assert.deepEqual(tally, { executed: 0, failed: 0, unknown: 1, errors: 0 });
  const row = await readSigningRequest(w.db, 'acme', register.id);
  assert.equal(row.status, 'unknown');
  assert.equal(row.signers.filter((s) => s.signature).length, 0, 'no partial signature held');
  assert.equal(await countLingeringSignaturesForStaff(w.db), 0);
  assert.equal(await countStuckSubmissionsForStaff(w.db, new Date(later.getTime() - SUBMISSION_LEASE_MS)), 0);

  // While its outcome is unknown, nothing like it can be asked for.
  const again = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: founderOf(w), owners: w.owners });
  assert.equal(again.code, 'request_open');

  // Its ValidDuring window passes with the chain never having seen it: it
  // can never land now, so it fails and the key is free.
  w.model.state.epoch = 902n;
  const final = await reconcileSigningRequestsForStaff({ db: w.db, chain: w.chain, now: () => later });
  assert.equal(final.failed, 1);
  assert.equal((await readSigningRequest(w.db, 'acme', register.id)).status, 'failed');
  await w.client.close();
});

/* ── 3. Timeout ambiguity ─────────────────────────────────────────────── */

test('3: a timeout with no answer is unknown, not failed; when the chain shows it landed, the next step opens', async () => {
  const w = await world();
  w.model.setMode('timeout-before');
  const n = await nominate(w);
  const done = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: n.id, signature: await sign(w.keys.founder, n), digest: n.digest });
  assert.equal(done.request.status, 'unknown');
  assert.equal(done.request.executedDigest, n.digest, 'the digest is kept');
  assert.deepEqual(await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' }), []);

  // The cron, before the network answers: still unknown.
  const early = await reconcileSigningRequestsForStaff({ db: w.db, chain: w.chain, now: () => T0 });
  assert.equal(early.unknown, 1);

  // The transaction did reach the network after all.
  w.model.setMode('ok');
  const sent = w.executed.at(-1);
  await w.chain.execute(sent.bytes, sent.signatures);
  const tally = await reconcileSigningRequestsForStaff({ db: w.db, chain: w.chain, now: () => T0, onExecuted: w.signing.onExecuted });
  assert.equal(tally.executed, 1);
  assert.equal((await readSigningRequest(w.db, 'acme', n.id)).status, 'executed');
  const inbox = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal(inbox.length, 1, 'the registration opened once the nomination was found on chain');
  assert.equal(inbox[0].purpose, 'register_wallet');
  await w.client.close();
});

test('3: a timeout after landing is read back at once and counts as executed', async () => {
  const w = await world();
  w.model.setMode('timeout-after');
  const n = await nominate(w);
  const done = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-founder', id: n.id, signature: await sign(w.keys.founder, n), digest: n.digest });
  assert.equal(done.request.status, 'executed');
  await w.client.close();
});

test('3: the current wallet is the one the BusinessAccount names on chain, not the request history', async () => {
  const w = await world();
  const { wallet } = await registered(w);
  const current = await currentWalletMembers(w.ctx, w.db, 'acme');
  assert.equal(current.ok, true);
  assert.equal(current.address, wallet.address);
  // The chain names some other wallet: nothing is built for it.
  w.model.state.wallet = normalizeSuiAddress('0x' + '42'.repeat(32));
  assert.equal((await currentWalletMembers(w.ctx, w.db, 'acme')).code, 'wallet_unknown');
  w.model.state.wallet = null;
  assert.equal((await currentWalletMembers(w.ctx, w.db, 'acme')).code, 'no_wallet');
  await w.client.close();
});

/* ── 4. No single-signer veto ─────────────────────────────────────────── */

test('4: a signer who did not ask cannot cancel; they decline, and the others still sign', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  const vetoed = await cancelSigningRequest(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id });
  assert.equal(vetoed.ok, false);
  assert.equal(vetoed.code, 'not_requester');
  assert.equal((await readSigningRequest(w.db, 'acme', register.id)).status, 'collecting');

  const declined = await declineSigningRequest(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id });
  assert.deepEqual(declined, { ok: true, closed: false });
  assert.deepEqual(await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' }), [], 'gone from their inbox');
  const late = await submitPartialSignature(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id, signature: await sign(w.keys.three, register), digest: register.digest });
  assert.equal(late.code, 'declined');

  const done = await signBy(w, register, 'two', 'founder');
  assert.equal(done.status, 'executed', 'two of three still register the wallet');
  await w.client.close();
});

test('4: enough declines that the threshold cannot be reached close the request; the requester can cancel', async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  await declineSigningRequest(w.signing, { orgId: 'acme', userId: 'u-three', id: register.id });
  const second = await declineSigningRequest(w.signing, { orgId: 'acme', userId: 'u-two', id: register.id });
  assert.deepEqual(second, { ok: true, closed: true });
  assert.equal((await readSigningRequest(w.db, 'acme', register.id)).status, 'cancelled');
  await w.client.close();

  const v = await world();
  const { register: r2 } = await nominateAndOpenRegistration(v);
  assert.deepEqual(await cancelSigningRequest(v.signing, { orgId: 'acme', userId: 'u-founder', id: r2.id }), { ok: true }, 'the founder asked for it');
  assert.equal((await cancelSigningRequest(v.signing, { orgId: 'northwind', userId: 'u-north', id: r2.id })).status, 404);
  await v.client.close();
});

/* ── 5. Mainnet gated in code ─────────────────────────────────────────── */

test('5: no business wallet request on mainnet until the hardware passkey check is recorded', () => {
  assert.equal(walletNetworkGate({ SUI_NETWORK: 'testnet' }).ok, true);
  assert.equal(walletNetworkGate({ SUI_NETWORK: 'mainnet' }).ok, false);
  assert.equal(walletNetworkGate({ SUI_NETWORK: 'mainnet', WALLET_MAINNET_ENABLED: 'true' }).ok, false, 'the switch alone is not enough');
  assert.equal(walletNetworkGate({ SUI_NETWORK: 'mainnet', WALLET_MAINNET_ENABLED: 'true', WALLET_HARDWARE_CHECK_REF: 'yes' }).ok, false);
  assert.equal(
    walletNetworkGate({ SUI_NETWORK: 'mainnet', WALLET_MAINNET_ENABLED: 'true', WALLET_HARDWARE_CHECK_REF: 'docs/mainnet-checks-2026-10.md#wallet-2-of-3' }).ok,
    true,
  );
});

test('5: production on mainnet refuses to boot with wallets switched on and no evidence named', async () => {
  const OBJ = '0x' + 'ab'.repeat(32);
  const PROD = {
    NODE_ENV: 'production',
    CUSTOMER_SESSION_SECRET: 's'.repeat(32),
    ADMIN_SESSION_SECRET: 'a'.repeat(32),
    CRON_SECRET: 'c'.repeat(32),
    DATABASE_URL: 'postgresql://user:pw@db.example/splash?sslmode=require',
    SPLASH_PACKAGE_ID: OBJ,
    NEXT_PUBLIC_APP_URL: 'https://v1.splashz.xyz',
    USDC_TYPE: `${OBJ}::usdc::USDC`,
    ADMIN_PASSWORD: 'not-the-demo-value-either',
    USE_MOCK_APIS: 'true',
    NEXT_PUBLIC_DEMO_MODE: 'true',
    SUI_SETTLEMENT_MODE: 'simulate',
    EMAIL_TRANSPORT: 'resend',
    EMAIL_API_KEY: 're_test_key',
    EMAIL_FROM: 'no-reply@splash.example',
    SUI_NETWORK: 'mainnet',
  };
  assert.throws(
    () => parseEnv({ ...PROD, WALLET_MAINNET_ENABLED: 'true' }),
    (e) => e instanceof EnvValidationError && e.issues.some((i) => i.key === 'WALLET_HARDWARE_CHECK_REF'),
  );
  assert.equal(parseEnv({ ...PROD, WALLET_MAINNET_ENABLED: 'true', WALLET_HARDWARE_CHECK_REF: 'docs/mainnet-checks-2026-10.md#wallet-2-of-3' }).WALLET_MAINNET_ENABLED, true);
  assert.equal(parseEnv(PROD).WALLET_MAINNET_ENABLED, false, 'off by default');
  const deps = await readFile(new URL('../lib/server/wallet-deps.ts', import.meta.url), 'utf8');
  assert.match(deps, /walletNetworkGate\(\)/, 'every wallet route goes through the gate');
});

/* ── 6. Single-signer consent, and nobody left out silently ───────────── */

function candidates(w) {
  return [
    { userId: 'u-founder', publicKey: w.keys.founder.publicKey, address: w.keys.founder.address, founder: true },
    { userId: 'u-two', publicKey: w.keys.two.publicKey, address: w.keys.two.address, founder: false },
    { userId: 'u-three', publicKey: w.keys.three.publicKey, address: w.keys.three.address, founder: false },
  ];
}

test('6: the founder alone cannot make a single-signer wallet for co-owners; every other owner must agree to that wallet', async () => {
  const w = await world();
  const base = { requestedBy: 'u-founder', candidates: candidates(w), missing: [], threshold: 1, singleSignerChosen: true };
  const asked = planBusinessWallet(base);
  assert.equal(asked.ok, false);
  assert.equal(asked.code, 'consent_needed');
  assert.deepEqual(asked.details.waiting, ['u-three', 'u-two']);

  await recordSingleSignerConsent(w.db, { orgId: 'acme', userId: 'u-two', walletAddress: asked.details.wallet });
  assert.equal(planBusinessWallet({ ...base, consents: await singleSignerConsents(w.db, 'acme', asked.details.wallet) }).code, 'consent_needed');
  await recordSingleSignerConsent(w.db, { orgId: 'acme', userId: 'u-three', walletAddress: asked.details.wallet });
  const agreed = planBusinessWallet({ ...base, consents: await singleSignerConsents(w.db, 'acme', asked.details.wallet) });
  assert.equal(agreed.ok, true);
  assert.equal(agreed.wallet.singleSigner, true);
  assert.deepEqual(await singleSignerConsents(w.db, 'northwind', asked.details.wallet), [], 'consents are per org');

  // A sole owner chooses for themselves.
  assert.equal(planBusinessWallet({ ...base, candidates: candidates(w).slice(0, 1) }).ok, true);
  // And the default needs nobody's consent.
  assert.equal(planBusinessWallet({ requestedBy: 'u-founder', candidates: candidates(w), missing: [] }).wallet.threshold, 2);
  await w.client.close();
});

test('6: an owner without a passkey blocks the wallet until the founder confirms by name that they are left out', async () => {
  const w = await world();
  const base = { requestedBy: 'u-founder', candidates: candidates(w).slice(0, 2), missing: ['u-three'] };
  const blocked = planBusinessWallet(base);
  assert.equal(blocked.code, 'owners_without_passkey');
  assert.deepEqual(blocked.details.missing, ['u-three']);
  assert.equal(planBusinessWallet({ ...base, confirmExcluded: ['u-somebody'] }).code, 'owners_without_passkey');
  const ok = planBusinessWallet({ ...base, confirmExcluded: ['u-three'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.wallet.members.length, 2);
  // Only the founder starts it.
  assert.equal(planBusinessWallet({ ...base, confirmExcluded: ['u-three'], requestedBy: 'u-two' }).code, 'not_the_founder');
  await w.client.close();
});

/* ── 7. The founder from the chain; one passkey each ──────────────────── */

test("7: the founder is the account's on-chain owner, and each owner signs with their one active passkey here", async () => {
  const a = softPasskey();
  const b = softPasskey();
  const old = softPasskey();
  const other = softPasskey();
  const at = (d) => new Date(`2026-10-${d}T00:00:00Z`);
  const row = (userId, key, extra = {}) => ({ userId, role: 'admin', publicKey: key.publicKey, address: key.address, rpId: 'splashz.xyz', revokedAt: null, createdAt: at(10), ...extra });
  const rows = [
    // Both memberships have grantedBy null in the database; only the chain says who founded it.
    row('u-a', a),
    row('u-b', b),
    row('u-b', old, { revokedAt: at(5), createdAt: at(1) }),
    row('u-b', other, { rpId: 'localhost' }),
    { userId: 'u-c', role: 'admin', publicKey: null, address: null, rpId: null, revokedAt: null, createdAt: null },
    row('u-staff', softPasskey(), { role: 'staff' }),
  ];
  const picked = pickWalletMembers(rows, { owner: b.address, owners: [b.address] }, 'splashz.xyz');
  assert.deepEqual(picked.candidates.map((c) => [c.userId, c.founder]), [['u-a', false], ['u-b', true]]);
  assert.equal(picked.candidates.find((c) => c.userId === 'u-b').publicKey, b.publicKey, 'the active key on this site, not the revoked or other-site one');
  assert.deepEqual(picked.missing, ['u-c']);

  // Every address funds may sit at, for detection: staff, revoked and other-site keys too.
  const addresses = memberWalletAddresses(rows, 'splashz.xyz');
  assert.equal(addresses.length, 5);
  assert.deepEqual(addresses.filter((x) => x.canSign).map((x) => x.userId).sort(), ['u-a', 'u-b', 'u-staff']);

  // Postgres allows one active passkey per person per site, so "two active passkeys" cannot reach the wallet.
  const w = await world();
  const key = (id, k) => ({ id, userId: 'u-two', credentialId: id, publicKey: k.publicKey, suiAddress: k.address, rpId: 'splashz.xyz' });
  await w.db.insert(schema.passkeyCredentials).values(key('cred-1', a));
  await assert.rejects(() => w.db.insert(schema.passkeyCredentials).values(key('cred-2', b)));

  // A founder passkey that is not the account's owner cannot nominate.
  const notOwner = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-two', founder: { userId: 'u-two', passkeyPublicKey: w.keys.two.publicKey }, owners: w.owners });
  assert.equal(notOwner.code, 'not_the_founder');
  await w.client.close();
});

/* ── 8. Migration paging ──────────────────────────────────────────────── */

test('8: every page of coins is read, and a wallet with too many coins moves the rest next time', async () => {
  const coin = (i) => ({ objectId: '0x' + i.toString(16).padStart(64, '0'), version: 1, digest: toBase58(new Uint8Array(32).fill(i % 255)) });
  const pages = [[coin(1), coin(2)], [coin(3), coin(4)], [coin(5)]];
  const list = async (cursor) => {
    const i = cursor === null ? 0 : Number(cursor);
    return { objects: pages[i], hasNextPage: i < pages.length - 1, cursor: i < pages.length - 1 ? String(i + 1) : null };
  };
  assert.deepEqual((await collectCoins(list)).coins.length, 5);
  assert.equal((await collectCoins(list)).more, false);
  const capped = await collectCoins(list, 3);
  assert.equal(capped.coins.length, 3);
  assert.equal(capped.more, true);
});

/* ── 9. Budget, rate limits, one bad row ──────────────────────────────── */

test("9: the sponsor pays at most a daily budget for one org's wallet requests", async () => {
  const w = await world({ sponsorDailyBudgetMist: 30_000_000n });
  const first = await nominate(w);
  await cancelSigningRequest(w.signing, { orgId: 'acme', userId: 'u-founder', id: first.id });
  const second = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: founderOf(w), owners: w.owners });
  assert.equal(second.ok, false);
  assert.equal(second.status, 429);
  assert.equal(second.code, 'sponsor_budget');
  // A day later the budget is back.
  w.setNow(new Date(T0.getTime() + 24 * 3600_000 + 1));
  assert.equal((await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: founderOf(w), owners: w.owners })).ok, true);
  await w.client.close();
});

test('9: a request that no longer decodes shows as no longer valid instead of failing the whole inbox', async () => {
  const w = await world();
  await nominateAndOpenRegistration(w);
  const changed = { ...w.signing, expect: { ...expect, registryId: '0x' + '12'.repeat(32) } };
  const inbox = await signingInbox(changed, { orgId: 'acme', userId: 'u-two' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].valid, false);
  assert.equal(inbox[0].description, null);
  assert.equal(inbox[0].you.mustSign, false);
  const signed = await submitPartialSignature(changed, { orgId: 'acme', userId: 'u-two', id: inbox[0].id, signature: await sign(w.keys.two, inbox[0]), digest: inbox[0].digest });
  assert.equal(signed.code, 'no_longer_valid');
  await w.client.close();
});

test('9: every route that opens a wallet request is rate-limited per person and per business', async () => {
  for (const route of ['business/route.ts', 'business/consent/route.ts', 'business/rotation/route.ts', 'business/members/route.ts', 'migration/route.ts']) {
    const source = await readFile(new URL(`../app/api/wallet/${route}`, import.meta.url), 'utf8');
    assert.match(source, /limitWalletRequests\(route\)/, route);
  }
  const front = await readFile(new URL('../lib/server/wallet-route.ts', import.meta.url), 'utf8');
  assert.match(front, /walletRequestUser/);
  assert.match(front, /walletRequestOrg/);
});

/* ── 10. The device decodes the bytes itself ──────────────────────────── */

test("10: the signer's device decodes the exact bytes and refuses a code that does not match them", async () => {
  const w = await world();
  const { register } = await nominateAndOpenRegistration(w);
  const review = reviewOnDevice(register);
  assert.deepEqual(review.actions, describeWalletTransaction(register.transactionBytes, register.expect).actions);
  assert.equal(review.code, transactionCode(register.bytesHash));
  assert.match(review.code, /^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
  // A server that sends one transaction's bytes with another's digest is caught.
  // (A fixed prefix that the random digest may already start with would change nothing.)
  const otherPrefix = register.digest.startsWith('GZ') ? 'HY' : 'GZ';
  assert.throws(() => reviewOnDevice({ ...register, digest: otherPrefix + register.digest.slice(2) }), /does not match/);
  assert.throws(() => reviewOnDevice({ ...register, bytesHash: 'ff'.repeat(32) }), /does not match/);
  await w.client.close();
});

/* ── + On-chain owners, rotation, membership ──────────────────────────── */

test('+ registration only works because the nomination made every member an on-chain owner', async () => {
  const w = await world();
  assert.deepEqual([...w.model.state.owners], [w.keys.founder.address]);
  await registered(w);
  assert.deepEqual([...w.model.state.owners].sort(), [w.keys.founder.address, w.keys.two.address, w.keys.three.address].sort());
  // A second nomination is refused: the account already has its wallet.
  const again = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: founderOf(w), owners: w.owners });
  assert.equal(again.code, 'wallet_registered');
  await w.client.close();
});

test('+ rotation: the current wallet proposes, the new one confirms, then the old wallet moves its USDC over', async () => {
  const w = await world();
  const { wallet: old, members } = await registered(w);
  const current = await currentWalletMembers(w.ctx, w.db, 'acme');
  assert.equal(current.address, old.address);

  const rotate = await startWalletRotation(w.ctx, { orgId: 'acme', requestedBy: 'u-two', current: members, owners: w.owners, threshold: 3 });
  assert.equal(rotate.ok, true, JSON.stringify(rotate));
  assert.equal(rotate.request.sender, old.address);
  // The member being outvoted cannot veto it.
  assert.equal((await cancelSigningRequest(w.signing, { orgId: 'acme', userId: 'u-three', id: rotate.request.id })).code, 'not_requester');
  await signBy(w, rotate.request, 'two', 'founder');
  const next = buildBusinessMultisig({ members: w.owners, threshold: 3 });
  assert.equal(w.model.state.pending.wallet, next.address);

  w.balances.set(old.address, { coinMinor: 0n, addressBalanceMinor: 7_000_000n });
  const [confirm] = (await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' })).filter((r) => r.purpose === 'confirm_wallet_rotation');
  assert.equal(confirm.sender, next.address);
  await signBy(w, confirm, 'founder', 'two', 'three');
  assert.equal(w.model.state.wallet, next.address, 'the new wallet is current on chain');

  const [move] = (await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' })).filter((r) => r.purpose === 'rotation_transfer');
  assert.ok(move, 'the old wallet is asked to move its funds');
  assert.equal(move.sender, old.address);
  const send = move.description.actions.at(-1);
  assert.deepEqual([send.type, send.recipient, send.amountMinor], ['send_funds', next.address, '7000000']);
  assert.equal((await signBy(w, move, 'founder', 'three')).status, 'executed');

  // The wallet is read from the chain from now on.
  assert.equal((await currentWalletMembers(w.ctx, w.db, 'acme')).address, next.address);
  await w.client.close();
});

test('+ membership changes are signed by the wallet', async () => {
  const w = await world();
  const { members } = await registered(w);
  const outsider = softPasskey();
  const r = await changeWalletMembership(w.ctx, { orgId: 'acme', requestedBy: 'u-two', wallet: members, change: 'set_recovery_party', address: outsider.address });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.request.description.actions.map((a) => [a.type, a.address]), [['set_recovery_party', outsider.address]]);
  await w.client.close();
});
