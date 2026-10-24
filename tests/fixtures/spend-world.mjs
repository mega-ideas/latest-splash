/**
 * A spending-rules test world (v2 §4.2), on top of wallet-world.mjs: the
 * same PGlite, owners, software passkeys and BusinessAccount model chain,
 * plus a MODEL of splash_spend and the framework's allowances:
 *
 *   create_spend_policy   the wallet itself; the id is derived from the
 *                         account and its wallet generation, once
 *   add/remove_spender,   the policy's wallet only; growth only while the
 *   verify_*, set_*       policy is current (E_POLICY_NOT_CURRENT)
 *   propose + accept      the funder is the policy's wallet, the spender is
 *                         on the policy, the name is its allowance_name;
 *                         an Allowance (shared) and its AllowanceCap (sent
 *                         to the funder) appear
 *   revoke                the cap's owner, with its own allowance
 *   approve_payout        an owner of the policy, neither maker nor payer;
 *                         the payer is a spender; the intent is pending
 *
 * The wallet generation moves when a wallet registers or a rotation is
 * confirmed, as business_account does. It decodes every transaction with
 * the server's own reader, so a transaction the reader refuses cannot run
 * here either. `charge` spends under an allowance as `allowance::consume`
 * does (anchor, window index, reset, caps), for the window tests.
 *
 * Nothing reaches a network.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { ACCOUNT, chainCfg, expect as walletExpect, USDC, world } from './wallet-world.mjs';
import * as schema from '../../lib/db/schema.ts';
import { describeWalletTransaction } from '../../lib/wallet/wallet-tx-describe.ts';
import { allowanceNameFor, policyIdFor, splashSpendAppName } from '../../lib/wallet/spend-rules-bcs.ts';
import { windowIndexAt } from '../../lib/wallet/allowance-window.ts';
import { continueWalletSteps } from '../../lib/server/business-wallet.ts';
import { continueSpendSteps } from '../../lib/server/spend-rules.ts';
import { dbOwnershipGate } from '../../lib/server/ownership-proofs.ts';

export const SPEND = '0x' + '5e'.repeat(32);
export const POLICY_REGISTRY = '0x' + '9e'.repeat(32);
export const spendChainCfg = { ...chainCfg, spendPackageId: SPEND, policyRegistry: { objectId: POLICY_REGISTRY, initialSharedVersion: 6 } };
export const spendExpect = { ...walletExpect, spendPackageId: SPEND, policyRegistryId: POLICY_REGISTRY };

const SPEND_TYPES = new Set([
  'create_spend_policy', 'add_spender', 'remove_spender', 'verify_recipient', 'remove_recipient', 'verify_beneficiary', 'remove_beneficiary',
  'set_limits', 'set_running_window', 'rate_limit', 'wrap_rate_limit', 'propose_allowance', 'accept_allowance', 'revoke_allowance', 'approve_payout',
]);

const clone = (s) => ({
  epoch: s.epoch,
  policies: new Map([...s.policies].map(([k, p]) => [k, { ...p, spenders: p.spenders.map((x) => ({ ...x })), recipients: [...p.recipients], beneficiaries: [...p.beneficiaries], runningTotals: [...p.runningTotals] }])),
  allowances: new Map([...s.allowances].map(([k, a]) => [k, { ...a, rateLimit: a.rateLimit ? { ...a.rateLimit } : null }])),
  caps: new Map([...s.caps].map(([k, c]) => [k, { ...c }])),
  approvals: [...s.approvals],
  next: s.next,
});

export async function spendWorld(opts = {}) {
  const w = await world(opts);
  for (const [id, email, org, role] of [
    ['u-staff', 'staff@acme.test', 'acme', 'maker'],
    ['u-staff2', 'staff2@acme.test', 'acme', 'maker'],
    ['u-north-staff', 'staff@northwind.test', 'northwind', 'maker'],
  ]) {
    await w.db.insert(schema.users).values({ id, email, name: id });
    await w.db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  w.signing.expect = spendExpect;

  const state = { epoch: 0n, policies: new Map(), allowances: new Map(), caps: new Map(), approvals: [], next: 1 };
  const spends = [];
  const base = w.chain;

  function decode(bytes) {
    const extra = { spend: { policyIds: [...state.policies.keys()], allowanceIds: [...state.allowances.keys()], capIds: [...state.caps.keys()] } };
    try {
      return describeWalletTransaction(bytes, { ...spendExpect, ...extra });
    } catch (error) {
      if (error.code !== 'open_intent_unchecked' && error.code !== 'wrong_object') throw error;
      for (const i of w.model.state.intents.values()) {
        try {
          return describeWalletTransaction(bytes, {
            ...spendExpect,
            ...extra,
            openIntent: { intentId: i.id, recipient: i.recipient, amountMinor: i.amountMinor.toString(), kind: i.kind, targetCurrency: i.targetCurrency, fxRateUsdLocal: i.fxRateUsdLocal.toString(), expiresAtMs: i.expiresAtMs.toString(), asset: i.asset },
          });
        } catch {
          /* the next */
        }
      }
      throw error;
    }
  }

  function apply(d) {
    const s = clone(state);
    const abort = (code) => ({ success: false, error: `MoveAbort(${code})` });
    const wallet = w.model.state.wallet;
    const current = (p) => p.wallet === wallet && p.walletEpoch === s.epoch;
    const proposals = new Map();
    const newId = () => '0x' + (s.next++).toString(16).padStart(64, '0');
    for (let i = 0; i < d.actions.length; i++) {
      const a = d.actions[i];
      const p = a.policy ? s.policies.get(a.policy) : null;
      if (a.policy && !p) return abort('E_NO_SUCH_POLICY');
      const walletOnly = () => d.sender === p.wallet;
      switch (a.type) {
        case 'create_spend_policy': {
          if (!wallet || d.sender !== wallet || a.wallet !== d.sender) return abort('E_WALLET_MISMATCH');
          const id = policyIdFor({ policyRegistryId: POLICY_REGISTRY, spendPackageId: SPEND, accountId: ACCOUNT, walletEpoch: s.epoch });
          if (s.policies.has(id)) return abort('EObjectAlreadyClaimed');
          s.policies.set(id, {
            id, account: normalizeSuiAddress(ACCOUNT), wallet, walletEpoch: s.epoch, asset: USDC, owners: a.members.map((m) => m.address),
            tables: { spenders: '0x1', recipients: '0x2', beneficiaries: '0x3', partnerDeposits: '0x4', runningTotals: '0x5' },
            counts: { spenders: 0n, recipients: 0n, beneficiaries: 0n, runningTotals: 0n },
            perPaymentMax: BigInt(a.perPaymentMaxMinor), secondApprovalThreshold: 10_000_000_000n, generation: 0n, runningWindowMs: 86_400_000n,
            initialSharedVersion: '11', spenders: [], recipients: [], beneficiaries: [], runningTotals: [],
          });
          break;
        }
        case 'add_spender':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          if (!current(p)) return abort('E_POLICY_NOT_CURRENT');
          if (p.spenders.some((x) => x.spender === a.spender)) return abort('E_ALREADY_A_SPENDER');
          p.spenders.push({ spender: a.spender, role: a.role === 'staff' ? 1 : 2, perPaymentMax: BigInt(a.perPaymentMaxMinor) });
          break;
        case 'remove_spender':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          if (!p.spenders.some((x) => x.spender === a.spender)) return abort('E_NOT_A_SPENDER');
          p.spenders = p.spenders.filter((x) => x.spender !== a.spender);
          p.generation += 1n;
          break;
        case 'verify_recipient':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          if (!current(p)) return abort('E_POLICY_NOT_CURRENT');
          if (p.recipients.some((r) => r.address === a.address)) return abort('E_ALREADY_VERIFIED');
          p.recipients.push({ domain: 8, address: a.address, kind: a.kind });
          break;
        case 'remove_recipient':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          if (!p.recipients.some((r) => r.address === a.address)) return abort('E_NOT_VERIFIED');
          p.recipients = p.recipients.filter((r) => r.address !== a.address);
          p.generation += 1n;
          break;
        case 'verify_beneficiary':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          if (!current(p)) return abort('E_POLICY_NOT_CURRENT');
          p.beneficiaries.push({ commitment: a.commitment, partnerDeposit: a.partnerDeposit });
          break;
        case 'remove_beneficiary':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          p.beneficiaries = p.beneficiaries.filter((b) => b.commitment !== a.commitment);
          p.generation += 1n;
          break;
        case 'set_limits':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          p.perPaymentMax = BigInt(a.perPaymentMaxMinor);
          p.secondApprovalThreshold = BigInt(a.secondApprovalThresholdMinor);
          break;
        case 'set_running_window':
          if (!walletOnly()) return abort('E_NOT_THE_WALLET');
          p.runningWindowMs = BigInt(a.windowMs);
          break;
        case 'rate_limit':
        case 'wrap_rate_limit':
          break;
        case 'propose_allowance':
          proposals.set(i, { ...a, funder: d.sender });
          break;
        case 'accept_allowance': {
          const prop = proposals.get(a.proposalFromCommand);
          if (!current(p)) return abort('E_POLICY_NOT_CURRENT');
          if (prop.funder !== p.wallet) return abort('E_PROPOSAL_FUNDER');
          if (!p.spenders.some((x) => x.spender === prop.spender)) return abort('E_PROPOSAL_SPENDER');
          if (prop.name !== allowanceNameFor(p.id)) return abort('E_ALLOWANCE_NOT_FOR_POLICY');
          const id = newId();
          const capId = newId();
          const rl = prop.rateLimit;
          s.allowances.set(id, {
            id, funder: prop.funder, spender: prop.spender, app: splashSpendAppName(SPEND),
            lifetimeCap: prop.lifetimeCapMinor === null ? null : BigInt(prop.lifetimeCapMinor),
            startMs: prop.startsAtMs === null ? null : BigInt(prop.startsAtMs),
            expiresAtMs: prop.expiresAtMs === null ? null : BigInt(prop.expiresAtMs),
            rateLimit: { limit: BigInt(rl.limitMinor), spent: 0n, anchorMs: null, index: 0n, window: rl.window.kind === 'calendar' ? { kind: 'calendar', months: rl.window.months } : { kind: 'periodic', periodMs: BigInt(rl.window.periodMs) } },
            name: prop.name, currentSpend: 0n, initialSharedVersion: '12',
          });
          s.caps.set(capId, { objectId: capId, version: '13', digest: '11111111111111111111111111111111', owner: prop.funder, allowance: id });
          break;
        }
        case 'revoke_allowance': {
          const cap = s.caps.get(a.cap);
          if (!cap || cap.owner !== d.sender) return abort('E_NOT_OWNED');
          if (cap.allowance !== a.allowance) return abort('EWrongCap');
          s.caps.delete(a.cap);
          s.allowances.delete(a.allowance);
          break;
        }
        case 'approve_payout': {
          if (!p.owners.includes(d.sender)) return abort('E_NOT_AN_OWNER');
          const intent = w.model.state.intents.get(a.intent.intentId);
          if (!intent || intent.status !== 0) return abort('E_NOT_PAYABLE');
          if (d.sender === a.payer || (intent.maker && d.sender === normalizeSuiAddress(intent.maker))) return abort('E_SELF_APPROVAL');
          if (!p.spenders.some((x) => x.spender === a.payer)) return abort('E_NOT_A_SPENDER');
          s.approvals.push({ intent: a.intent.intentId, approver: d.sender, payer: a.payer, maxTotal: BigInt(a.maxTotalMinor) });
          break;
        }
        default:
          return abort(`the spend model does not run ${a.type}`);
      }
    }
    return { success: true, next: s };
  }

  const commit = (next) => Object.assign(state, next);

  async function run(bytes, mode) {
    let d;
    try {
      d = decode(bytes);
    } catch (error) {
      return { spend: true, result: { success: false, error: `the model chain cannot read it: ${error.message}` } };
    }
    if (!d.actions.some((a) => SPEND_TYPES.has(a.type))) return { spend: false, d };
    const r = apply(d);
    if (mode === 'execute' && r.success) commit(r.next);
    return { spend: true, result: r.success ? { success: true } : r };
  }

  const landed = new Map();
  const chain = {
    simulate: async (bytes) => {
      const r = await run(bytes, 'simulate');
      if (!r.spend) return base.simulate(bytes);
      return r.result.success ? { success: true, balanceChanges: [] } : r.result;
    },
    execute: async (bytes, signatures) => {
      const r = await run(bytes, 'execute');
      if (!r.spend) {
        const out = await base.execute(bytes, signatures);
        // business_account moves the wallet generation on register and on a confirmed rotation.
        if (out.success && r.d.actions.some((a) => a.type === 'register_wallet' || a.type === 'confirm_wallet_rotation')) state.epoch += 1n;
        return out;
      }
      const { TransactionDataBuilder } = await import('@mysten/sui/transactions');
      const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
      const out = r.result.success ? { digest, success: true } : { digest, success: false, error: r.result.error };
      landed.set(digest, out);
      return out;
    },
    read: async (digest) => landed.get(digest) ?? (await base.read(digest)),
    currentEpoch: base.currentEpoch,
  };
  w.signing.chain = chain;
  const baseReadAccount = w.ctx.readAccount;
  w.ctx.readAccount = async () => ({ ...(await baseReadAccount()), walletEpoch: state.epoch });

  const reader = {
    readPolicy: async (id) => {
      const p = state.policies.get(normalizeSuiAddress(id));
      return p ? { ...p, spenders: [...p.spenders], recipients: [...p.recipients], beneficiaries: [...p.beneficiaries], runningTotals: [...p.runningTotals] } : null;
    },
    listAllowanceCaps: async (owner) => [...state.caps.values()].filter((c) => c.owner === normalizeSuiAddress(owner)).map((c) => ({ objectId: c.objectId, version: c.version, digest: c.digest, allowance: c.allowance })),
    readAllowances: async (ids) => ids.map((i) => state.allowances.get(normalizeSuiAddress(i))).filter(Boolean).map((a) => ({ ...a })),
    listRuleSpends: async (policyId) => spends.filter((e) => e.policyId === normalizeSuiAddress(policyId)),
  };
  const sc = { wallet: w.ctx, chain: spendChainCfg, read: reader, ownership: dbOwnershipGate(w.db), db: w.db };
  w.signing.onExecuted = async (request) => {
    await continueWalletSteps(w.ctx, request);
    await continueSpendSteps(sc, request);
  };

  /** Spend under an allowance as `allowance::consume` charges it. */
  function charge(allowanceId, amount, nowMs) {
    // On a copy: an abort leaves the allowance as it was, as on chain.
    const stored = state.allowances.get(normalizeSuiAddress(allowanceId));
    const a = { ...stored, rateLimit: { ...stored.rateLimit } };
    if (a.startMs !== null && nowMs < a.startMs) throw new Error('ENotStarted');
    if (a.expiresAtMs !== null && nowMs >= a.expiresAtMs) throw new Error('EExpired');
    a.currentSpend += amount;
    if (a.lifetimeCap !== null && a.currentSpend > a.lifetimeCap) throw new Error('EExceedsLifetimeCap');
    const rl = a.rateLimit;
    if (rl.anchorMs !== null) {
      const current = windowIndexAt(rl.window, rl.anchorMs, nowMs);
      if (current > rl.index) {
        rl.index = current;
        rl.spent = 0n;
      }
    } else {
      rl.anchorMs = nowMs;
    }
    rl.spent += amount;
    if (rl.spent > rl.limit) throw new Error('EExceedsRateLimit');
    state.allowances.set(stored.id, a);
  }

  return { ...w, chain, spend: state, spends, sc, reader, charge };
}
