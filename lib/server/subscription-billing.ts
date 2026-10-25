/**
 * Subscription billing (Amendment A1 §6), behind FEATURE_SUBSCRIPTION_BILLING,
 * which is OFF. Built and tested; not enabled.
 *
 * While the flag is off every entry point here refuses with `not_found`
 * (404) before it reads or writes anything, and the cron does nothing. The
 * one exception is cancelling: a business that has a live subscription can
 * always revoke it, whatever the flag says (with the flag off and nothing
 * live, cancel is `not_found` too). No payment path imports this module, so
 * no payment is ever blocked because billing failed.
 *
 * ─── The money path ─────────────────────────────────────────────────────────
 *
 * Subscribing: the business wallet's quorum signs `0x2::allowance::new`
 * (lib/server/subscription-builders.ts) naming the Splash finance multisig as
 * spender, `monthly_rate_limit(plan price)`, and the end of the term as its
 * expiry. The finance multisig is SPLASH_FINANCE_ADDRESS, and only while it
 * is FeeConfig's fee recipient on chain, which `fee_config` proved to be a
 * multisig no single key can sign for; the operator can never be it. The
 * AllowanceCap goes to the wallet. Splash has no key to the wallet.
 *
 * Billing: at most one pull per business per calendar month (UTC), by a
 * unique index on (org, period), and only when the allowance's own monthly
 * window has room (the chain would refuse otherwise). Each pull is a
 * transaction the FINANCE MULTISIG signs, never the operator: the server
 * builds and stores the exact bytes and an invoice; the finance signers
 * sign them on their own devices, and `submitPullForStaff` sends them. A
 * pull that lands gets a receipt; one that fails puts the subscription in
 * a grace period and tells the business's owners. A failed pull may be
 * tried again in the same month, on the same row; a succeeded one never.
 *
 * Cancelling is the wallet revoking the allowance; a plan change is a revoke
 * and a new allowance in one transaction the wallet signs.
 *
 * Tenant isolation: every customer-facing read and write takes the org from
 * the caller (the routes take it from the session, WS2); the cron's
 * cross-tenant reads say so (`*ForStaff`).
 */
import { createHash, randomUUID } from 'node:crypto';

import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress, toBase64, fromBase64 } from '@mysten/sui/utils';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  allowanceCopy,
  billingAllowanceName,
  billingPeriod,
  GRACE_PERIOD_MS,
  SUBSCRIPTION_INTERVAL,
  subscriptionBillingEnabled,
  termEndUtc,
} from '../billing/subscription.ts';
import { formatUsdcBound } from '../fees/copy.ts';
import {
  memberships,
  subscriptionInvoices,
  subscriptionNotices,
  subscriptionPlans,
  subscriptionPulls,
  subscriptionReceipts,
  subscriptions,
  users,
} from '../db/schema.ts';
import { liveRateLimit } from '../wallet/allowance-window.ts';
import type { AllowanceState } from '../wallet/spend-rules-bcs.ts';
import type { WalletContext, WalletMembers } from './business-wallet.ts';
import { billingPullTx, cancelSubscriptionTx, subscribeTx, type OwnGas } from './subscription-builders.ts';
import { openSigningRequest, type RequestView, type SigningFailure } from './wallet-signing.ts';
import { IN_FLIGHT, readSigningRequest, type DrizzleDb, type StoredRequest } from './wallet-signing-store.ts';

export type BillingFailure = SigningFailure & { details?: Record<string, unknown> };
const refuse = (status: number, code: string, error: string, details?: Record<string, unknown>): BillingFailure => ({ ok: false, status, code, error, ...(details ? { details } : {}) });
const NOT_FOUND = () => refuse(404, 'not_found', 'Not found');

/** A billing allowance as the wallet holds it: the allowance and its cap. */
export type HeldBillingAllowance = AllowanceState & { initialSharedVersion: string; cap: { objectId: string; version: string; digest: string } };

export type BillingDeps = {
  db: DrizzleDb;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

/** What the wallet-facing calls need for one org. */
export type BillingWallet = {
  ctx: WalletContext;
  /** Every AllowanceCap<Balance<USDC>> `owner` holds, with its allowance. */
  readHeldAllowances: (owner: string) => Promise<HeldBillingAllowance[]>;
  /** The finance multisig, only while it is FeeConfig's fee recipient on chain. */
  financeAddress: () => Promise<{ ok: true; address: string } | { ok: false; error: string }>;
};

/** A failed pull is tried again at most this many times in its month. */
export const MAX_PULL_ATTEMPTS = 3;
const MAX_NOTICE_ATTEMPTS = 3;
const LIVE = ['active', 'grace', 'lapsed'] as const;

const nowOf = (deps: BillingDeps) => (deps.now ?? (() => new Date()))();
const on = (deps: BillingDeps) => subscriptionBillingEnabled(deps.env ?? process.env);

type PlanRow = typeof subscriptionPlans.$inferSelect;
type SubRow = typeof subscriptions.$inferSelect;
type PullRow = typeof subscriptionPulls.$inferSelect;

export type PlanView = { id: string; name: string; priceMinor: string; interval: typeof SUBSCRIPTION_INTERVAL; termMonths: number; lifetimeCapMinor: string | null; copy: string };

const planView = (p: PlanRow): PlanView => ({
  id: p.id,
  name: p.name,
  priceMinor: p.priceMinor.toString(),
  interval: SUBSCRIPTION_INTERVAL,
  termMonths: p.termMonths,
  lifetimeCapMinor: p.lifetimeCapMinor === null ? null : p.lifetimeCapMinor.toString(),
  copy: allowanceCopy(p.priceMinor),
});

// ─── Plans (rows in the database, editable without code) ───────────────────

/** Splash staff add or change a plan. A price change applies to new subscriptions; a live one keeps what it was signed at. */
export async function upsertPlanForStaff(db: DrizzleDb, plan: { id: string; name: string; priceMinor: bigint; termMonths?: number; lifetimeCapMinor?: bigint | null; active?: boolean }): Promise<void> {
  billingAllowanceName(plan.id);
  if (plan.priceMinor <= 0n) throw new RangeError('a plan price is above zero');
  const now = new Date();
  const values = { id: plan.id, name: plan.name, priceMinor: plan.priceMinor, termMonths: plan.termMonths ?? 12, lifetimeCapMinor: plan.lifetimeCapMinor ?? null, active: plan.active ?? true, interval: SUBSCRIPTION_INTERVAL, updatedAt: now };
  await db.insert(subscriptionPlans).values({ ...values, createdAt: now }).onConflictDoUpdate({ target: subscriptionPlans.id, set: values });
}

export async function listPlans(deps: BillingDeps): Promise<{ ok: true; plans: PlanView[] } | BillingFailure> {
  if (!on(deps)) return NOT_FOUND();
  const rows = await deps.db.select().from(subscriptionPlans).where(eq(subscriptionPlans.active, true)).orderBy(asc(subscriptionPlans.priceMinor));
  return { ok: true, plans: rows.map(planView) };
}

// ─── A business's subscription ─────────────────────────────────────────────

export type SubscriptionView = {
  id: string;
  planId: string;
  planName: string;
  status: string;
  priceMinor: string;
  /** "Splash can draw up to X USDC per calendar month (UTC) for your plan. Revoke any time." */
  copy: string;
  financeAddress: string;
  allowanceId: string | null;
  termStart: string;
  expiresAt: string;
  graceUntil: string | null;
};

async function planOf(db: DrizzleDb, id: string): Promise<PlanRow | null> {
  const [p] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
  return p ?? null;
}

async function liveSub(db: DrizzleDb, orgId: string): Promise<SubRow | null> {
  const [s] = await db.select().from(subscriptions).where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, [...LIVE]))).limit(1);
  return s ?? null;
}

async function viewOf(db: DrizzleDb, s: SubRow): Promise<SubscriptionView> {
  const plan = await planOf(db, s.planId);
  return {
    id: s.id,
    planId: s.planId,
    planName: plan?.name ?? s.planId,
    status: s.status,
    priceMinor: s.priceMinor.toString(),
    copy: allowanceCopy(s.priceMinor),
    financeAddress: s.financeAddress,
    allowanceId: s.allowanceId,
    termStart: s.termStart.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    graceUntil: s.graceUntil?.toISOString() ?? null,
  };
}

/** Settings → Billing for ONE org: its live and pending subscription, invoices and receipts. */
export async function readSubscription(deps: BillingDeps, orgId: string) {
  if (!on(deps)) return NOT_FOUND();
  const rows = await deps.db.select().from(subscriptions).where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, [...LIVE, 'pending']))).orderBy(desc(subscriptions.createdAt));
  const live = rows.find((r: SubRow) => (LIVE as readonly string[]).includes(r.status)) ?? null;
  const pending = rows.find((r: SubRow) => r.status === 'pending') ?? null;
  const invoices = await deps.db.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.orgId, orgId)).orderBy(desc(subscriptionInvoices.issuedAt)).limit(24);
  const receipts = await deps.db.select().from(subscriptionReceipts).where(eq(subscriptionReceipts.orgId, orgId)).orderBy(desc(subscriptionReceipts.paidAt)).limit(24);
  return {
    ok: true as const,
    subscription: live ? await viewOf(deps.db, live) : null,
    pending: pending ? await viewOf(deps.db, pending) : null,
    invoices: invoices.map((i: typeof subscriptionInvoices.$inferSelect) => ({ id: i.id, number: i.number, period: i.period, planName: i.planName, amountMinor: i.amountMinor.toString(), issuedAt: i.issuedAt.toISOString() })),
    receipts: receipts.map((r: typeof subscriptionReceipts.$inferSelect) => ({ id: r.id, invoiceId: r.invoiceId, suiDigest: r.suiDigest, amountMinor: r.amountMinor.toString(), paidAt: r.paidAt.toISOString() })),
  };
}

type Opened = { ok: true; request: RequestView; subscription: SubscriptionView } | BillingFailure;

/** The billing allowances this wallet holds: plain (no app), to the finance multisig, named for billing. */
function billingHeld(held: HeldBillingAllowance[], wallet: string, finance: string): HeldBillingAllowance[] {
  return held.filter((a) => a.app === null && a.funder === wallet && a.spender === finance && a.name.startsWith('splash-billing:'));
}

async function openBilling(
  deps: BillingDeps,
  bw: BillingWallet,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; planId?: string; mode: 'subscribe' | 'change' | 'cancel' },
): Promise<Opened> {
  const { db } = deps;
  const now = nowOf(deps);
  let account;
  try {
    account = await bw.ctx.readAccount();
  } catch {
    return refuse(502, 'account_unreadable', 'the business account could not be read from the chain');
  }
  if (!account.wallet) return refuse(409, 'no_wallet', 'register the business wallet first');
  const wallet = normalizeSuiAddress(account.wallet);
  const finance = await bw.financeAddress();
  if (!finance.ok) return refuse(503, 'finance_unconfigured', finance.error);
  const financeAddress = normalizeSuiAddress(finance.address);
  if (financeAddress === wallet) return refuse(409, 'finance_unconfigured', 'the finance multisig cannot be the business wallet');
  const sponsor = bw.ctx.signing.sponsor;
  if (!sponsor) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');

  // A pending plan whose signing request closed without executing is
  // abandoned, so it holds nothing back; one still collecting is refused.
  const pendings = await db.select().from(subscriptions).where(and(eq(subscriptions.orgId, input.orgId), eq(subscriptions.status, 'pending')));
  for (const p of pendings as SubRow[]) {
    const req = p.signingRequestId ? await readSigningRequest(db, input.orgId, p.signingRequestId) : null;
    if (req && IN_FLIGHT.includes(req.status)) {
      if (input.mode !== 'cancel') return refuse(409, 'request_open', 'a plan change for this business is already waiting for signatures');
      continue;
    }
    if (req?.status === 'executed') continue;
    await db.update(subscriptions).set({ status: 'abandoned', updatedAt: now }).where(and(eq(subscriptions.id, p.id), eq(subscriptions.status, 'pending')));
  }

  const current = await liveSub(db, input.orgId);
  let held: HeldBillingAllowance[];
  try {
    held = billingHeld(await bw.readHeldAllowances(wallet), wallet, financeAddress);
  } catch {
    return refuse(502, 'chain_unreadable', "the wallet's allowances could not be read from the chain");
  }
  const currentHeld = current ? held.find((a) => a.id === current.allowanceId) ?? null : null;

  if (input.mode === 'subscribe' && current) return refuse(409, 'already_subscribed', 'this business already has a plan; change it instead');
  if (input.mode !== 'subscribe') {
    if (!current) return refuse(404, 'not_found', 'this business has no plan');
    if (!currentHeld) return refuse(409, 'allowance_missing', 'the allowance this plan bills under is no longer held by the business wallet');
  }

  const gas = await sponsor.gasFor();
  const billingExpect = { financeAddress, allowanceIds: held.map((a) => a.id), capIds: held.map((a) => a.cap.objectId) };
  const revoke = currentHeld ? { cap: currentHeld.cap, allowance: { objectId: currentHeld.id, initialSharedVersion: currentHeld.initialSharedVersion } } : undefined;

  if (input.mode === 'cancel') {
    const bytes = await cancelSubscriptionTx({ wallet, usdcType: bw.ctx.chain.usdcType, cap: currentHeld!.cap, allowance: revoke!.allowance, gas });
    const opened = await openSigningRequest(bw.ctx.signing, {
      orgId: input.orgId,
      requestedBy: input.requestedBy,
      purpose: 'subscription',
      dedupeKey: 'billing:cancel',
      transactionBytes: bytes,
      signer: { kind: 'multisig', ...input.wallet },
      gasMode: 'sponsored',
      billing: billingExpect,
      billingTerms: { revokeAllowances: [currentHeld!.id] },
    });
    if (!opened.ok) return opened;
    await db.update(subscriptions).set({ cancelRequestId: opened.request.id, updatedAt: now }).where(and(eq(subscriptions.id, current!.id), eq(subscriptions.orgId, input.orgId)));
    return { ok: true, request: opened.request, subscription: await viewOf(db, current!) };
  }

  const plan = input.planId ? await planOf(db, input.planId) : null;
  if (!plan || !plan.active) return refuse(404, 'no_such_plan', 'there is no such plan');
  if (input.mode === 'change' && plan.id === current!.planId && plan.priceMinor === current!.priceMinor) return refuse(409, 'same_plan', 'this business is on that plan already');
  const name = billingAllowanceName(plan.id);
  const expiresAtMs = BigInt(termEndUtc(now.getTime(), plan.termMonths));
  const terms = { revokeAllowances: revoke ? [currentHeld!.id] : [], grant: { name, monthlyLimitMinor: plan.priceMinor, expiresAtMs, lifetimeCapMinor: plan.lifetimeCapMinor } };
  let bytes: Uint8Array;
  try {
    bytes = await subscribeTx({ wallet, usdcType: bw.ctx.chain.usdcType, name, finance: financeAddress, monthlyLimitMinor: plan.priceMinor, expiresAtMs, lifetimeCapMinor: plan.lifetimeCapMinor, ...(revoke ? { revoke } : {}), gas });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_plan', e.message ?? 'the subscription could not be built');
  }
  const id = `sub_${randomUUID()}`;
  const opened = await openSigningRequest(bw.ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'subscription',
    dedupeKey: 'billing:plan',
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
    billing: billingExpect,
    billingTerms: terms,
  });
  if (!opened.ok) return opened;
  try {
    await db.insert(subscriptions).values({
      id,
      orgId: input.orgId,
      planId: plan.id,
      status: 'pending',
      priceMinor: plan.priceMinor,
      lifetimeCapMinor: plan.lifetimeCapMinor,
      wallet,
      financeAddress,
      allowanceName: name,
      termStart: now,
      expiresAt: new Date(Number(expiresAtMs)),
      signingRequestId: opened.request.id,
      replacesId: current?.id ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return refuse(409, 'request_open', 'a plan change for this business is already waiting for signatures');
  }
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  return { ok: true, request: opened.request, subscription: await viewOf(db, row) };
}

export async function subscribe(deps: BillingDeps, bw: BillingWallet, input: { orgId: string; requestedBy: string; wallet: WalletMembers; planId: string }): Promise<Opened> {
  if (!on(deps)) return NOT_FOUND();
  return openBilling(deps, bw, { ...input, mode: 'subscribe' });
}

/** A plan change: the current allowance revoked and the new one issued, in one transaction the wallet signs. */
export async function changePlan(deps: BillingDeps, bw: BillingWallet, input: { orgId: string; requestedBy: string; wallet: WalletMembers; planId: string }): Promise<Opened> {
  if (!on(deps)) return NOT_FOUND();
  return openBilling(deps, bw, { ...input, mode: 'change' });
}

/** Cancel = the wallet revokes the allowance. Possible whenever a plan is live, whatever the flag. */
export async function cancelSubscription(deps: BillingDeps, bw: BillingWallet, input: { orgId: string; requestedBy: string; wallet: WalletMembers }): Promise<Opened> {
  if (!on(deps) && !(await liveSub(deps.db, input.orgId))) return NOT_FOUND();
  return openBilling(deps, bw, { ...input, mode: 'cancel' });
}

/**
 * After a `subscription` request executes, in its own org: a new allowance
 * makes its subscription active (and the one it replaces `replaced`); a
 * revoke makes the subscription `cancelled`. The allowance is read from the
 * chain, never from the client, and must carry exactly the plan's terms.
 */
export async function continueBillingSteps(deps: BillingDeps, bw: BillingWallet, request: StoredRequest): Promise<void> {
  if (request.purpose !== 'subscription' || request.status !== 'executed') return;
  const { db } = deps;
  const now = nowOf(deps);
  const [cancelled] = await db.select().from(subscriptions).where(and(eq(subscriptions.orgId, request.orgId), eq(subscriptions.cancelRequestId, request.id))).limit(1);
  if (cancelled && (LIVE as readonly string[]).includes(cancelled.status)) {
    await db.update(subscriptions).set({ status: 'cancelled', updatedAt: now }).where(eq(subscriptions.id, cancelled.id));
    return;
  }
  const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.orgId, request.orgId), eq(subscriptions.signingRequestId, request.id))).limit(1);
  if (!sub || sub.status !== 'pending') return;
  const held = billingHeld(await bw.readHeldAllowances(sub.wallet), sub.wallet, sub.financeAddress);
  const taken = new Set(
    (await db.select({ id: subscriptions.allowanceId }).from(subscriptions).where(eq(subscriptions.orgId, request.orgId))).map((r: { id: string | null }) => r.id).filter(Boolean),
  );
  const match = held.find(
    (a) =>
      !taken.has(a.id) &&
      a.name === sub.allowanceName &&
      a.expiresAtMs === BigInt(sub.expiresAt.getTime()) &&
      a.rateLimit?.window.kind === 'calendar' &&
      a.rateLimit.window.months === 1 &&
      a.rateLimit.limit === sub.priceMinor &&
      (a.lifetimeCap ?? null) === (sub.lifetimeCapMinor ?? null),
  );
  if (!match) throw new Error('the executed subscription left no allowance with the plan terms on chain');
  await db.transaction(async (tx: DrizzleDb) => {
    if (sub.replacesId) await tx.update(subscriptions).set({ status: 'replaced', updatedAt: now }).where(and(eq(subscriptions.id, sub.replacesId), eq(subscriptions.orgId, request.orgId)));
    await tx.update(subscriptions).set({ status: 'active', allowanceId: match.id, allowanceCapId: match.cap.objectId, updatedAt: now }).where(eq(subscriptions.id, sub.id));
  });
}

// ─── Billing: one pull per calendar month, signed by the finance multisig ──

export type PullDescription = { sender: string; funder: string; allowance: string; amountMinor: string; recipient: string; digest: string };

/**
 * What a pull's bytes do, read from the bytes alone, for the finance
 * signers and for the server before it stores them: one withdrawal from the
 * business wallet under this allowance, `balance_spend`, then `send_funds` to
 * the finance multisig itself. Anything else is refused.
 */
export function describeBillingPull(bytes: Uint8Array, usdcType: string): PullDescription {
  const data = TransactionDataBuilder.fromBytes(bytes);
  const fail = (why: string): never => {
    throw new Error(`not a billing pull: ${why}`);
  };
  const sender = normalizeSuiAddress(data.sender ?? fail('no sender'));
  if ((data.gasData.payment ?? []).length !== 0) fail('it names a gas coin');
  if (normalizeSuiAddress(data.gasData.owner ?? sender) !== sender) fail('someone else pays its gas');
  const T = normalizeStructTag(usdcType);
  const withdrawals = data.inputs.filter((i) => i.$kind === 'FundsWithdrawal');
  if (withdrawals.length !== 1 || data.inputs.some((i) => i.$kind === 'Object' && !(i.Object.$kind === 'SharedObject'))) fail('it is not one withdrawal from one allowance');
  const w = withdrawals[0].FundsWithdrawal!;
  if (w.withdrawFrom.$kind !== 'SenderAllowance' || !w.withdrawFrom.SenderAllowance) fail('it does not draw under an allowance');
  if (w.typeArg.$kind !== 'Balance' || normalizeStructTag(w.typeArg.Balance as string) !== T) fail('it does not draw USDC');
  const cmds = data.commands;
  if (cmds.length !== 2 || cmds[0].$kind !== 'MoveCall' || cmds[1].$kind !== 'MoveCall') fail('it is not a spend and a send');
  const spend = cmds[0].MoveCall!;
  const send = cmds[1].MoveCall!;
  if (normalizeSuiAddress(spend.package) !== normalizeSuiAddress('0x2') || `${spend.module}::${spend.function}` !== 'allowance::balance_spend') fail('its first step is not allowance::balance_spend');
  if (normalizeSuiAddress(send.package) !== normalizeSuiAddress('0x2') || `${send.module}::${send.function}` !== 'balance::send_funds') fail('its second step is not balance::send_funds');
  const recipientArg = send.arguments[1];
  if (recipientArg?.$kind !== 'Input') fail('the recipient is not a plain address');
  const recipientInput = data.inputs[(recipientArg as { Input: number }).Input];
  if (recipientInput?.$kind !== 'Pure') fail('the recipient is not a plain address');
  const raw = fromBase64((recipientInput as { Pure: { bytes: string } }).Pure.bytes);
  const recipient = normalizeSuiAddress(`0x${Buffer.from(raw).toString('hex')}`);
  if (recipient !== sender) fail('it pays someone other than the finance multisig');
  const from = w.withdrawFrom.SenderAllowance as { funder: string; allowance: string };
  return {
    sender,
    funder: normalizeSuiAddress(from.funder),
    allowance: normalizeSuiAddress(from.allowance),
    amountMinor: String(w.reservation.MaxAmountU64),
    recipient,
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
  };
}

export type CycleDeps = BillingDeps & {
  /** The allowance as the chain has it now; null once it is revoked. */
  readAllowance: (id: string) => Promise<(AllowanceState & { initialSharedVersion: string }) | null>;
  /** The finance multisig's own gas for a pull. */
  financeGas: () => Promise<OwnGas>;
  usdcType: string;
  /** What the chain says about a digest, or null if it has not seen it. */
  readDigest: (digest: string) => Promise<{ success: boolean; error?: string | null } | null>;
  sendEmail?: (message: { to: string; subject: string; text: string; link: string }) => Promise<{ providerRef: string | null }>;
  appUrl?: string;
};

export type CycleResult =
  | { ok: true; prepared: number; succeeded: number; failed: number; ended: number; cancelled: number; lapsed: number; notices: number; errors: Array<{ subscriptionId: string; error: string }> }
  | { ok: false; status: 404; code: 'not_found' };

const invoiceNumber = (orgId: string, period: string) => `SPL-${period.replace('-', '')}-${createHash('sha256').update(orgId).digest('hex').slice(0, 8).toUpperCase()}`;

/**
 * One run of billing, cross-tenant (the cron). Off: nothing at all. For each
 * live subscription: settle what a submitted pull did; end it at its term;
 * mark it cancelled if the wallet revoked the allowance outside Splash;
 * lapse it when its grace ran out; and, once per calendar month, when the
 * allowance's own window has room, build the month's pull for the finance
 * multisig to sign, with its invoice. Never more than one pull per business
 * per month: the unique index decides, not this loop.
 */
export async function runBillingCycleForStaff(deps: CycleDeps): Promise<CycleResult> {
  if (!on(deps)) return { ok: false, status: 404, code: 'not_found' };
  const { db } = deps;
  const now = nowOf(deps);
  const out = { ok: true as const, prepared: 0, succeeded: 0, failed: 0, ended: 0, cancelled: 0, lapsed: 0, notices: 0, errors: [] as Array<{ subscriptionId: string; error: string }> };

  // What submitted pulls did on chain.
  const submitted = await db.select().from(subscriptionPulls).where(eq(subscriptionPulls.status, 'submitted'));
  for (const p of submitted) {
    const seen = await deps.readDigest(p.txDigest).catch(() => null);
    if (!seen) continue;
    const r = await settlePull(deps, p, seen);
    if (r === 'succeeded') out.succeeded += 1;
    if (r === 'failed') {
      out.failed += 1;
      out.notices += await noticeOwners(deps, p);
    }
  }

  const live = await db.select().from(subscriptions).where(inArray(subscriptions.status, [...LIVE]));
  for (const s of live as SubRow[]) {
    try {
      if (s.expiresAt.getTime() <= now.getTime()) {
        await db.update(subscriptions).set({ status: 'ended', updatedAt: now }).where(eq(subscriptions.id, s.id));
        out.ended += 1;
        continue;
      }
      const allowance = s.allowanceId ? await deps.readAllowance(s.allowanceId) : null;
      if (!allowance) {
        // Cancel = revoke: the wallet took the allowance back, in Splash or not.
        await db.update(subscriptions).set({ status: 'cancelled', updatedAt: now }).where(eq(subscriptions.id, s.id));
        out.cancelled += 1;
        continue;
      }
      if (allowance.funder !== s.wallet || allowance.spender !== s.financeAddress || allowance.app !== null) throw new Error('the allowance on chain is not the one this plan was signed for');
      if (s.status === 'grace' && s.graceUntil && s.graceUntil.getTime() <= now.getTime()) {
        await db.update(subscriptions).set({ status: 'lapsed', updatedAt: now }).where(eq(subscriptions.id, s.id));
        out.lapsed += 1;
      }
      const period = billingPeriod(now.getTime());
      const [existing] = await db.select().from(subscriptionPulls).where(and(eq(subscriptionPulls.orgId, s.orgId), eq(subscriptionPulls.period, period))).limit(1);
      if (existing && (existing.status !== 'failed' || existing.attempts >= MAX_PULL_ATTEMPTS)) continue;
      // The chain's own window must have room, or the pull would abort.
      const room = allowance.rateLimit ? liveRateLimit(allowance.rateLimit, BigInt(now.getTime())).remainingMinor : 0n;
      const lifetimeRoom = allowance.lifetimeCap === null ? s.priceMinor : allowance.lifetimeCap - allowance.currentSpend;
      if (room < s.priceMinor || lifetimeRoom < s.priceMinor) continue;
      const bytes = await billingPullTx({
        finance: s.financeAddress,
        wallet: s.wallet,
        usdcType: deps.usdcType,
        allowance: { objectId: allowance.id, initialSharedVersion: allowance.initialSharedVersion },
        amountMinor: s.priceMinor,
        gas: await deps.financeGas(),
      });
      const d = describeBillingPull(bytes, deps.usdcType);
      if (d.funder !== s.wallet || d.allowance !== allowance.id || BigInt(d.amountMinor) !== s.priceMinor || d.sender !== s.financeAddress) throw new Error('the pull built is not this plan’s');
      if (existing) {
        // A failed pull, tried again on the same row: still one per month.
        const retried = await db
          .update(subscriptionPulls)
          .set({ status: 'awaiting_signature', txBytes: toBase64(bytes), txDigest: d.digest, attempts: sql`${subscriptionPulls.attempts} + 1`, failureReason: null, updatedAt: now })
          .where(and(eq(subscriptionPulls.id, existing.id), eq(subscriptionPulls.status, 'failed')))
          .returning({ id: subscriptionPulls.id });
        if (retried.length) out.prepared += 1;
        continue;
      }
      const pullId = `pull_${randomUUID()}`;
      const plan = await planOf(db, s.planId);
      const inserted = await db.transaction(async (tx: DrizzleDb) => {
        const rows = await tx
          .insert(subscriptionPulls)
          .values({ id: pullId, orgId: s.orgId, subscriptionId: s.id, period, amountMinor: s.priceMinor, status: 'awaiting_signature', txBytes: toBase64(bytes), txDigest: d.digest, createdAt: now, updatedAt: now })
          // Only the month's pull already existing is "nothing to do"; any
          // other conflict (the same bytes twice) is an error.
          .onConflictDoNothing({ target: [subscriptionPulls.orgId, subscriptionPulls.period] })
          .returning({ id: subscriptionPulls.id });
        if (!rows.length) return false;
        await tx.insert(subscriptionInvoices).values({ id: `inv_${randomUUID()}`, orgId: s.orgId, pullId, number: invoiceNumber(s.orgId, period), period, planName: plan?.name ?? s.planId, amountMinor: s.priceMinor, issuedAt: now });
        return true;
      });
      if (inserted) out.prepared += 1;
    } catch (error) {
      out.errors.push({ subscriptionId: s.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** Settle a pull from what the chain says about its digest. Forward only. */
async function settlePull(deps: BillingDeps, p: PullRow, seen: { success: boolean; error?: string | null }): Promise<'succeeded' | 'failed' | null> {
  const { db } = deps;
  const now = nowOf(deps);
  if (seen.success) {
    const done = await db.transaction(async (tx: DrizzleDb) => {
      const moved = await tx
        .update(subscriptionPulls)
        .set({ status: 'succeeded', succeededAt: now, failureReason: null, updatedAt: now })
        .where(and(eq(subscriptionPulls.id, p.id), inArray(subscriptionPulls.status, ['awaiting_signature', 'submitted'])))
        .returning({ id: subscriptionPulls.id });
      if (!moved.length) return false;
      const [invoice] = await tx.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.pullId, p.id)).limit(1);
      await tx.insert(subscriptionReceipts).values({ id: `rcpt_${randomUUID()}`, orgId: p.orgId, pullId: p.id, invoiceId: invoice.id, suiDigest: p.txDigest, amountMinor: p.amountMinor, paidAt: now });
      await tx.update(subscriptions).set({ status: 'active', graceUntil: null, updatedAt: now }).where(and(eq(subscriptions.id, p.subscriptionId), inArray(subscriptions.status, ['grace', 'lapsed'])));
      return true;
    });
    return done ? 'succeeded' : null;
  }
  const moved = await db
    .update(subscriptionPulls)
    .set({ status: 'failed', failureReason: (seen.error ?? 'the pull failed on chain').slice(0, 300), updatedAt: now })
    .where(and(eq(subscriptionPulls.id, p.id), inArray(subscriptionPulls.status, ['awaiting_signature', 'submitted'])))
    .returning({ id: subscriptionPulls.id });
  if (!moved.length) return null;
  // Grace starts at the first failure and is not extended by later ones.
  await db
    .update(subscriptions)
    .set({ status: 'grace', graceUntil: new Date(now.getTime() + GRACE_PERIOD_MS), updatedAt: now })
    .where(and(eq(subscriptions.id, p.subscriptionId), eq(subscriptions.status, 'active')));
  return 'failed';
}

/** Tell the business's owners a pull failed, each once per pull. Their payments are not affected. */
async function noticeOwners(deps: CycleDeps, p: PullRow): Promise<number> {
  const { db } = deps;
  const now = nowOf(deps);
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.id, p.subscriptionId)).limit(1);
  const plan = s ? await planOf(db, s.planId) : null;
  const owners = await db
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, p.orgId), eq(memberships.role, 'admin')));
  const link = `${(deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/dashboard/settings`;
  const graceUntil = s?.graceUntil ? s.graceUntil.toISOString().slice(0, 10) : null;
  let sent = 0;
  for (const o of owners as Array<{ userId: string; email: string }>) {
    const claimed = await db
      .insert(subscriptionNotices)
      .values({ id: `sbn_${randomUUID()}`, orgId: p.orgId, pullId: p.id, userId: o.userId, kind: 'pull_failed', status: 'sending', createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [subscriptionNotices.pullId, subscriptionNotices.userId, subscriptionNotices.kind],
        set: { status: 'sending', attempts: sql`${subscriptionNotices.attempts} + 1`, updatedAt: now },
        setWhere: and(eq(subscriptionNotices.status, 'failed'), sql`${subscriptionNotices.attempts} < ${MAX_NOTICE_ATTEMPTS}`),
      })
      .returning({ id: subscriptionNotices.id });
    if (!claimed.length) continue;
    let ok = true;
    let error: string | null = null;
    try {
      if (!deps.sendEmail) throw new Error('no email transport');
      await deps.sendEmail({
        to: o.email,
        subject: 'Your Splash plan payment did not go through',
        text: [
          `Splash could not draw ${formatUsdcBound(p.amountMinor)} USDC for your ${plan?.name ?? 'Splash'} plan for ${p.period}.`,
          'Your payments are not affected: billing never holds a payment back.',
          graceUntil ? `Your plan stays as it is until ${graceUntil} while Splash tries again. Keep enough USDC in the business wallet, or change or cancel your plan in Settings.` : 'Change or cancel your plan in Settings.',
          link,
        ].join('\n\n'),
        link,
      });
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
    await db.update(subscriptionNotices).set({ status: ok ? 'sent' : 'failed', error, updatedAt: now }).where(eq(subscriptionNotices.id, claimed[0].id));
    if (ok) sent += 1;
  }
  return sent;
}

/**
 * The finance multisig's signatures over a pull's stored bytes, sent. Only
 * the exact bytes the server built and described; a pull already sent, or
 * settled, is not sent again. A network that does not answer leaves the pull
 * `submitted`, and the next cycle reads its digest.
 */
export async function submitPullForStaff(
  deps: CycleDeps & { execute: (bytes: Uint8Array, signatures: string[]) => Promise<{ digest: string; success: boolean; error?: string | null }> },
  input: { pullId: string; signatures: string[] },
): Promise<{ ok: true; status: 'succeeded' | 'failed' | 'submitted' } | BillingFailure> {
  if (!on(deps)) return NOT_FOUND();
  const { db } = deps;
  const now = nowOf(deps);
  const claimed = await db
    .update(subscriptionPulls)
    .set({ status: 'submitted', updatedAt: now })
    .where(and(eq(subscriptionPulls.id, input.pullId), eq(subscriptionPulls.status, 'awaiting_signature')))
    .returning();
  if (!claimed.length) return refuse(409, 'not_awaiting', 'this pull is not waiting for signatures');
  const p = claimed[0] as PullRow;
  const bytes = fromBase64(p.txBytes);
  describeBillingPull(bytes, deps.usdcType);
  let result: { digest: string; success: boolean; error?: string | null };
  try {
    result = await deps.execute(bytes, input.signatures);
  } catch {
    return { ok: true, status: 'submitted' };
  }
  if (result.digest !== p.txDigest) throw new Error('the chain answered for other bytes');
  const settled = await settlePull(deps, p, result);
  if (settled === 'failed') await noticeOwners(deps, p);
  return { ok: true, status: settled ?? 'submitted' };
}
