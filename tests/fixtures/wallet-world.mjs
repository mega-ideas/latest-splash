/**
 * A Business Splash Wallet test world: PGlite with every migration, three
 * owners of `acme` and one of `northwind` with software passkeys
 * (soft-passkey.mjs), a sponsor key, and a MODEL CHAIN.
 *
 * The model chain decodes each transaction with the same reader the server
 * uses and applies the rules splash_core enforces on the BusinessAccount, in
 * order, on a copy, so a simulation fails the way the chain would:
 *
 *   add_owner            before a wallet, an owner sends it; after, the wallet
 *   nominate_wallet      only the account's `owner` (the founder), no wallet yet
 *   register_wallet      the nominated wallet itself, every member an owner
 *                        (E_SIGNER_NOT_AN_OWNER otherwise)
 *   rotate_wallet        the current wallet, no rotation pending
 *   confirm/cancel       the pending wallet / the current wallet
 *   pay_intent           the current wallet; an existing intent must be pending
 *
 * It does not verify signatures (the tests check those themselves), and it
 * moves no balances. `execute` can be told to time out before or after the
 * transaction lands, and `read` answers from what landed.
 *
 * Nothing reaches a network, and nothing is signed for any network.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';

import { migratedDb } from '../helpers/store-db.mjs';
import { softPasskey } from './soft-passkey.mjs';
import * as schema from '../../lib/db/schema.ts';
import { describeWalletTransaction } from '../../lib/wallet/wallet-tx-describe.ts';
import { continueWalletSteps } from '../../lib/server/business-wallet.ts';
import { recordScreening } from '../../lib/server/kyt-screenings.ts';

export const CORE = '0x' + 'c0'.repeat(32);
export const ACCOUNT = '0x' + 'ac'.repeat(32);
export const OTHER_ACCOUNT = '0x' + 'ad'.repeat(32);
export const CONFIG = '0x' + 'cf'.repeat(32);
export const FEES = '0x' + 'fe'.repeat(32);
export const REGISTRY = '0x' + 'ee'.repeat(32);
export const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const CHAIN_ID = toBase58(new Uint8Array(32).fill(7));
export const T0 = new Date('2026-10-25T08:00:00Z');

export const chainCfg = {
  corePackageId: CORE,
  complianceConfig: { objectId: CONFIG, initialSharedVersion: 3 },
  feeConfig: { objectId: FEES, initialSharedVersion: 4 },
  registry: { objectId: REGISTRY, initialSharedVersion: 5 },
  usdcType: USDC,
};
export const expect = { corePackageId: CORE, accountId: ACCOUNT, complianceConfigId: CONFIG, feeConfigId: FEES, registryId: REGISTRY, usdcType: USDC };

function intentExpectation(i) {
  return {
    intentId: i.id,
    recipient: i.recipient,
    amountMinor: i.amountMinor.toString(),
    kind: i.kind,
    targetCurrency: i.targetCurrency,
    fxRateUsdLocal: i.fxRateUsdLocal.toString(),
    expiresAtMs: i.expiresAtMs.toString(),
    asset: i.asset,
  };
}

/** The BusinessAccount rules, on a model of its state. */
export function modelChain({ founder, simulateOk = true }) {
  const state = {
    owner: normalizeSuiAddress(founder),
    owners: new Set([normalizeSuiAddress(founder)]),
    wallet: null,
    nominated: null,
    pending: null,
    intents: new Map(),
    landed: new Map(),
    epoch: 900n,
  };
  const executed = [];
  const simulated = [];
  let mode = 'ok';

  function decode(bytes) {
    try {
      return describeWalletTransaction(bytes, expect);
    } catch (error) {
      if (error.code !== 'open_intent_unchecked' && error.code !== 'wrong_object') throw error;
      for (const i of state.intents.values()) {
        try {
          return describeWalletTransaction(bytes, { ...expect, openIntent: intentExpectation(i) });
        } catch {
          /* try the next */
        }
      }
      throw error;
    }
  }

  function run(bytes) {
    let d;
    try {
      d = decode(bytes);
    } catch (error) {
      return { success: false, error: `the model chain cannot read it: ${error.message}` };
    }
    const s = { ...state, owners: new Set(state.owners), intents: new Map(state.intents) };
    const abort = (code) => ({ success: false, error: `MoveAbort(${code})` });
    for (const a of d.actions) {
      switch (a.type) {
        case 'add_owner':
          if (s.wallet ? d.sender !== s.wallet : !s.owners.has(d.sender)) return abort('E_NOT_AUTHORIZED');
          if (s.owners.has(a.address)) return abort('E_ALREADY_A_MEMBER');
          s.owners.add(a.address);
          break;
        case 'remove_owner':
        case 'set_recovery_party':
          if (s.wallet ? d.sender !== s.wallet : !s.owners.has(d.sender)) return abort('E_NOT_AUTHORIZED');
          if (a.type === 'remove_owner') s.owners.delete(a.address);
          break;
        case 'nominate_wallet':
          if (d.sender !== s.owner) return abort('E_NOT_THE_FOUNDER');
          if (s.wallet) return abort('E_WALLET_ALREADY_REGISTERED');
          s.nominated = { wallet: a.wallet, singleSigner: a.singleSigner };
          break;
        case 'register_wallet':
          if (s.wallet) return abort('E_WALLET_ALREADY_REGISTERED');
          if (!s.nominated || s.nominated.wallet !== d.sender) return abort('E_WALLET_NOT_NOMINATED');
          if (!a.members.every((m) => s.owners.has(m.address))) return abort('E_SIGNER_NOT_AN_OWNER');
          s.wallet = d.sender;
          s.nominated = null;
          break;
        case 'rotate_wallet':
          if (d.sender !== s.wallet) return abort('E_NOT_THE_WALLET');
          if (s.pending) return abort('E_ROTATION_PENDING');
          if (!a.members.every((m) => s.owners.has(m.address))) return abort('E_SIGNER_NOT_AN_OWNER');
          s.pending = { wallet: a.newWallet };
          break;
        case 'confirm_wallet_rotation':
          if (!s.pending || s.pending.wallet !== d.sender) return abort('E_NOT_THE_PENDING_WALLET');
          s.wallet = d.sender;
          s.pending = null;
          break;
        case 'cancel_wallet_rotation':
          if (d.sender !== s.wallet || !s.pending) return abort('E_NOT_THE_WALLET');
          s.pending = null;
          break;
        case 'pay_intent':
          if (d.sender !== s.wallet) return abort('E_NOT_THE_WALLET');
          if (a.intent) {
            const i = s.intents.get(a.intent.intentId);
            if (!i || i.status !== 0) return abort('E_INTENT_NOT_PENDING');
            s.intents.set(i.id, { ...i, status: 1 });
          }
          break;
        default:
          break;
      }
    }
    return { success: true, next: s, description: d };
  }

  const commit = (next) => {
    for (const k of ['owner', 'owners', 'wallet', 'nominated', 'pending', 'intents']) state[k] = next[k];
  };

  const chain = {
    simulate: async (bytes) => {
      simulated.push(bytes);
      if (!simulateOk) return { success: false, error: 'MoveAbort(E_NOT_THE_FOUNDER)' };
      const r = run(bytes);
      return r.success ? { success: true, balanceChanges: [{ address: '0x1', coinType: USDC, amount: '-5' }] } : { success: false, error: r.error };
    },
    execute: async (bytes, signatures) => {
      executed.push({ bytes, signatures });
      const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
      if (mode === 'timeout-before') throw new Error('timeout');
      const r = run(bytes);
      const result = r.success ? { digest, success: true } : { digest, success: false, error: r.error };
      if (r.success) commit(r.next);
      state.landed.set(digest, result);
      if (mode === 'timeout-after') throw new Error('timeout');
      return result;
    },
    read: async (digest) => state.landed.get(digest) ?? null,
    currentEpoch: async () => state.epoch,
  };
  return {
    state,
    chain,
    executed,
    simulated,
    setMode: (m) => {
      mode = m;
    },
    addIntent: (i) => state.intents.set(normalizeSuiAddress(i.id), { ...i, id: normalizeSuiAddress(i.id) }),
    readAccount: async () => ({
      owner: state.owner,
      owners: [...state.owners],
      wallet: state.wallet,
      pendingWallet: state.pending?.wallet ?? null,
      nominatedWallet: state.nominated?.wallet ?? null,
    }),
    readIntent: async (id) => state.intents.get(normalizeSuiAddress(id)) ?? null,
  };
}

export async function world({ simulateOk = true, sponsor: withSponsor = true, sponsorDailyBudgetMist } = {}) {
  const { client, db } = await migratedDb();
  for (const [id, email, org] of [
    ['u-founder', 'founder@acme.test', 'acme'],
    ['u-two', 'two@acme.test', 'acme'],
    ['u-three', 'three@acme.test', 'acme'],
    ['u-north', 'north@northwind.test', 'northwind'],
  ]) {
    await db.insert(schema.users).values({ id, email, name: id });
    await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role: 'admin' });
  }
  const keys = { founder: softPasskey(), two: softPasskey(), three: softPasskey(), north: softPasskey() };

  const sponsorKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x5a));
  let nonce = 1;
  const sponsor = {
    address: sponsorKey.toSuiAddress(),
    gasFor: async () => ({ owner: sponsorKey.toSuiAddress(), price: 1000n, budget: 20_000_000n, epoch: 900n, chain: CHAIN_ID, nonce: nonce++ }),
    sign: async (bytes) => (await sponsorKey.signTransaction(bytes)).signature,
  };

  const model = modelChain({ founder: keys.founder.address, simulateOk });
  const balances = new Map();

  let now = T0;
  const notices = [];
  const signing = {
    db,
    chain: model.chain,
    sponsor: withSponsor ? sponsor : null,
    expect,
    now: () => now,
    notifier: { notify: async (n) => (notices.push(n), { delivered: n.userIds, unreachable: [] }) },
    ...(sponsorDailyBudgetMist !== undefined ? { sponsorDailyBudgetMist } : {}),
  };
  const ctx = {
    signing,
    chain: chainCfg,
    account: { objectId: ACCOUNT, initialSharedVersion: 9 },
    readAccount: model.readAccount,
    readIntent: model.readIntent,
    readUsdc: async (address) => balances.get(normalizeSuiAddress(address)) ?? { coinMinor: 0n, addressBalanceMinor: 0n },
    gasless: () => true,
    validity: async () => ({ epoch: 900n, chain: CHAIN_ID, nonce: nonce++ }),
  };
  signing.onExecuted = async (request) => {
    await continueWalletSteps(ctx, request);
  };
  const owners = [
    { userId: 'u-founder', publicKey: keys.founder.publicKey },
    { userId: 'u-two', publicKey: keys.two.publicKey },
    { userId: 'u-three', publicKey: keys.three.publicKey },
  ];
  return {
    client,
    db,
    keys,
    sponsor,
    sponsorKey,
    model,
    chain: model.chain,
    executed: model.executed,
    simulated: model.simulated,
    balances,
    signing,
    ctx,
    owners,
    notices,
    setNow: (d) => {
      now = d;
    },
    /** A fresh CLEAR for an address this business pays (v2 §4.6: a payment is opened only for one). */
    screenClear: (address, orgId = 'acme') =>
      recordScreening(db, {
        orgId, kind: 'wallet_recipient', chain: 'SUI', address: normalizeSuiAddress(address), requestedBy: 'test',
        screening: { provider: 'elliptic', verdict: 'CLEAR', reference: `elliptic:test-${normalizeSuiAddress(address).slice(2, 14)}-${now.getTime()}`, detail: 'test', screenedAt: now.toISOString(), riskScore: 0 },
      }),
  };
}
