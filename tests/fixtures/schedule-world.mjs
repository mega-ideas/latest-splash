/**
 * A scheduled-batches test world: the staff-rule world (a business `acme` with
 * a wallet, a spending policy, USDC and a verified recipient, on PGlite with the
 * model chain and software passkeys), plus
 *
 *   - a scheduled payer: a test Ed25519 key standing in for the KMS key. It
 *     signs nothing for any network; the model chain does not check
 *     signatures, and the tests check what was signed;
 *   - more saved, screened and verified recipients;
 *   - `payBefore`: an owner pays a recipient once, so it counts as paid before
 *     (an automatic run never makes a first payment to a new recipient);
 *   - `allowance`: the owners give the scheduled payer an allowance, signed by
 *     the owners' quorum through the same request flow as a spending rule;
 *   - `sdeps`: the per-business dependencies the schedule service and the
 *     runner take, with the clock the world controls and every notice recorded.
 *
 * Nothing reaches a network, and nothing is signed for any network.
 */
import assert from 'node:assert/strict';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../../lib/db/schema.ts';
import { parseAllowanceInput } from '../../lib/schedule/rules.ts';
import { automaticSummary, paymentsOfSchedules, summaryDigest } from '../../lib/schedule/summary.ts';
import * as S from '../../lib/server/scheduled-payments.ts';
import { readSpenderStanding } from '../../lib/server/spend-standing.ts';
import * as T from '../../lib/server/wallet-transfers.ts';
import { OWNER, SUPPLIER, U, amountInput, feeFor, setup, signBy, t0, DAY } from './staff-rule-world.mjs';

export { OWNER, SUPPLIER, U, feeFor, t0, DAY };
export const FINANCE_LEAD = { userId: 'u-lead', role: 'APPROVER', financeLead: true };
export const OWNER_ACTOR = { userId: 'u-founder', role: 'OWNER' };
export const OWNER2 = { userId: 'u-two', role: 'OWNER' };
export const STAFF_ACTOR = { userId: 'u-staff', role: 'MAKER' };
export const VIEWER_ACTOR = { userId: 'u-viewer', role: 'VIEWER' };
export const WALLET_B = normalizeSuiAddress(`0x${'71'.repeat(32)}`);
export const WALLET_C = normalizeSuiAddress(`0x${'72'.repeat(32)}`);
export const EXCHANGE = normalizeSuiAddress(`0x${'79'.repeat(32)}`);
export const NORTH = normalizeSuiAddress(`0x${'99'.repeat(32)}`);

const payerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x33));
export const PAYER = normalizeSuiAddress(payerKey.toSuiAddress());

export async function scheduleWorld(opts = {}) {
  const t = await setup(opts);
  const { w, wallet } = t;
  // The Finance lead is an approver (role checker), not an owner.
  await w.db.insert(schema.users).values({ id: 'u-lead', email: 'lead@acme.test', name: 'u-lead' });
  await w.db.insert(schema.memberships).values({ id: 'm-u-lead', userId: 'u-lead', orgId: 'acme', role: 'checker' });
  const notices = [];
  const signed = [];
  const payer = {
    kind: 'kms',
    address: PAYER,
    sign: async (bytes) => {
      signed.push(bytes);
      return (await payerKey.signTransaction(bytes)).signature;
    },
  };
  // `notify`: 'ok' tells one owner; 'nobody' reaches no one (no address, WhatsApp off); 'throw' is the mail provider down.
  const undelivered = [];
  const state = { payer: { ok: true, payer }, balance: undefined, notify: 'ok' };
  // The scheduled payer is Splash's own spender on the policy, not a person who left: standing says so, as the live wiring does.
  w.sc.standing = () => readSpenderStanding(w.db, 'acme', { scheduledPayer: PAYER });

  const sdeps = (orgId = 'acme', over = {}) => ({
    ...t.deps(orgId),
    payer: async () => state.payer,
    notify: async (n) => {
      if (state.notify === 'throw') {
        undelivered.push(n);
        throw new Error('the mail provider is down');
      }
      if (state.notify === 'nobody') {
        undelivered.push(n);
        return 0;
      }
      notices.push(n);
      return 1;
    },
    walletBalance: async () => (state.balance !== undefined ? state.balance : (w.balances.get(wallet.address)?.addressBalanceMinor ?? 0n)),
    ...over,
  });

  /** A saved, screened wallet recipient the owners also verified on the policy. */
  const recipient = async (address, name) => {
    await w.screenClear(address);
    const id = await w.saveRecipient(address, { name });
    await t.verify(address);
    return id;
  };

  /** An owner pays a recipient once from Transfer, signed by the quorum: from then on it has been paid before. */
  let n = 0;
  const payBefore = async (recipientId, usdc = 1) => {
    n += 1;
    const made = await T.createTransfer(t.deps(), OWNER_ACTOR, amountInput(recipientId, usdc, { clientKey: `before_key_${String(n).padStart(6, '0')}`, reference: `Earlier ${n}` }));
    assert.equal(made.ok, true, JSON.stringify(made, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const done = await signBy(w, made.signingRequest, ['two', 'three']);
    assert.equal(done.status, 'executed');
    return made;
  };

  /** The owners give the scheduled payer an allowance (per payment max, a monthly cap, an expiry). */
  const allowance = async (over = {}) => t.give(t.rule(PAYER, { perPaymentMaxMinor: U(2_000), cap: { period: 'month', limitMinor: U(20_000) }, expiresAtMs: t0 + 90n * DAY, ...over }));

  /**
   * What the page sends with a request for the allowance: the typed values and the digest of the summary the page
   * built from the schedules it loaded and its clock (here, the world's), as the owner confirmed it.
   */
  const confirmed = async (input, over = {}) => {
    const deps = sdeps('acme', over);
    const views = await S.listScheduleViews(deps, OWNER_ACTOR);
    const { payments, schedules, firstPaymentMs } = paymentsOfSchedules(views);
    const { form } = parseAllowanceInput(input);
    const { graceMinutes } = await S.automaticStatus(deps);
    const summary = automaticSummary({ payments, schedules, form, graceMinutes, nowMs: deps.now().getTime(), firstPaymentMs });
    return { ...input, summaryDigest: await summaryDigest(summary) };
  };

  /** Move the clock and screen every recipient again, as the provider does when a screening has gone stale. */
  const addresses = [SUPPLIER, WALLET_B, WALLET_C, NORTH];
  const clock = async (when) => {
    w.setNow(when);
    for (const a of addresses) await w.screenClear(a);
  };
  const second = await recipient(WALLET_B, 'Santos Supplies Inc');
  const third = await recipient(WALLET_C, 'Reyes Logistics Corp');
  const kinds = () => notices.map((n) => n.kind);
  /** How many payments the model chain has taken under an allowance. */
  const spent = () => w.spends.length;
  return { ...t, kinds, spent, payer, payerKey, signed, notices, undelivered, state, sdeps, recipient, payBefore, allowance, confirmed, clock, ids: { a: t.recipientId, b: second, c: third } };
}

/** A schedule input in USDC, as the page sends it. */
export const sched = (ids, over = {}) => ({
  clientKey: 'sched_key_000001',
  name: 'Monthly suppliers',
  mode: 'ask',
  cadence: 'monthly',
  firstDueAt: new Date(Number(t0) + 3 * Number(DAY)).toISOString(),
  items: [
    { recipientId: ids.a, amount: '500', reference: 'INV-1' },
    { recipientId: ids.b, amount: '750.50', reference: 'INV-2' },
  ],
  ...over,
});
