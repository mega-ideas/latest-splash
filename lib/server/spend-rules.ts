/**
 * Spending rules (sub-accounts), the backend Settings → Team & rules calls
 * (v2 §4.2, decision D2).
 *
 * A rule is an app-bound allowance from the business wallet to one staff
 * member's address, bound to splash_spend and named for the business's
 * current SpendPolicy, plus that person's place on the policy with their own
 * per-payment maximum. Inside the rule they pay alone (splash_spend::pay_intent,
 * from their own device); outside it, the payment goes to the owners (an
 * approval ask, lib/server/payment-approval-asks.ts). The policy is
 * business-wide: verified recipients (tagged WALLET or EXCHANGE), bank
 * beneficiaries bound to partner deposit addresses, the per-payment maximum,
 * the second-approval threshold (default 10,000 USDC) and the running-total
 * window.
 *
 *   policy     The wallet creates the policy for its current generation
 *              (`spend_policy`). One per generation; a rotation needs a new
 *              one, and the rules are reissued under it.
 *   issue      add_spender (STAFF, their per-payment maximum) and
 *              propose_for_app + accept: the cap per day (a 24-hour window)
 *              or per calendar month (UTC), an expiry, optionally a start and
 *              a lifetime cap (`spend_rule`).
 *   change     revoke the rule's allowance and issue a new one in the same
 *              transaction; a new per-payment maximum also removes and
 *              re-adds the spender, which retires outstanding approvals.
 *   revoke     revoke the allowance and remove the spender.
 *   recipients verify or remove recipients and beneficiaries. The WALLET tag
 *              only for an address with a verified ownership proof (A1 §2.3;
 *              lib/server/ownership-proofs.ts); otherwise refused before
 *              anything is built.
 *   limits     set_limits, set_running_window.
 *   approve    one owner's second approval (`spend_approval`) of a payment
 *              within a staff member's rule but above the threshold.
 *   reissue    after a rotation: the new wallet's policy, then the earlier
 *              generation's spenders, recipients, beneficiaries, limits and
 *              unexpired rules copied under it; the old allowances can be
 *              revoked by the old wallet's quorum.
 *
 * Every change is signed by the wallet's quorum through the §4.1 signing
 * flow (lib/server/wallet-signing.ts): the bytes are built here
 * (lib/server/spend-rules-builders.ts), decoded and shape-checked, sponsored,
 * simulated, and only then put to the signers. Every function takes the
 * caller's org and its own account; a policy, allowance or cap of another
 * business is refused by the decoder.
 */
import { fromBase64, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';
import { PasskeyPublicKey } from '@mysten/sui/keypairs/passkey';

import { allowanceNameFor, policyIdFor, splashSpendAppName, type AllowanceState, type RuleSpendEvent } from '../wallet/spend-rules-bcs.ts';
import { recordedWalletMembers, walletRegistration, type AccountState, type IntentState, type WalletContext, type WalletMembers } from './business-wallet.ts';
import type { OwnershipGate } from './ownership-proofs.ts';
import { approvePayoutTx, createSpendPolicyTx, RECIPIENT_TAG, SPEND_ROLE, spendRuleTx, type OwnedRef, type RuleCap, type RuleOp, type SpendChain } from './spend-rules-builders.ts';
import { buildSpendView, boundTo, DAY_MS, type HeldAllowance, type PolicyState, type SpendView } from './spend-rules-index.ts';
import { V2_KIND } from './sui-v2-builders.ts';
import { openSigningRequest, type RequestView, type SigningFailure } from './wallet-signing.ts';
import type { DrizzleDb, StoredRequest } from './wallet-signing-store.ts';
import { resolveOffboardedSpenders, type StandingOf } from './spend-standing.ts';
import { recordAuthorityEvent } from './wallet-authority.ts';

/** What the chain says, read for one business. */
export interface SpendReader {
  readPolicy(id: string): Promise<PolicyState | null>;
  /** `AllowanceCap<Balance<USDC>>` objects `owner` holds. */
  listAllowanceCaps(owner: string): Promise<Array<OwnedRef & { allowance: string }>>;
  readAllowances(ids: string[]): Promise<Array<AllowanceState & { initialSharedVersion: string }>>;
  /** RuleSpend events for this policy, newest first, at most `limit`. */
  listRuleSpends(policyId: string, limit: number): Promise<RuleSpendEvent[]>;
}

export type SpendContext = {
  wallet: WalletContext;
  chain: SpendChain;
  read: SpendReader;
  ownership: OwnershipGate;
  db: DrizzleDb;
  /** Who each spender address is to this business now (lib/server/spend-standing.ts). */
  standing?: () => Promise<StandingOf>;
};

type Result = { ok: true; request: RequestView } | SigningFailure;
export type SpendFailure = SigningFailure & { details?: Record<string, unknown> };
const refuse = (status: number, code: string, error: string, details?: Record<string, unknown>): SpendFailure => ({ ok: false, status, code, error, ...(details ? { details } : {}) });
const isFailure = (x: unknown): x is SpendFailure => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

/** A year: no rule outlives it without the owners reissuing it. */
export const MAX_RULE_LIFETIME_MS = 366n * DAY_MS;
/** splash_spend's own fee ceiling, 1% (FEE_CEILING_BPS = 100). */
const FEE_CEILING_BPS = 100n;
const BPS = 10_000n;
const MIN_WINDOW_MS = 3_600_000n;
const MAX_WINDOW_MS = 2_592_000_000n;
/** How many earlier wallet generations are looked at for rules to reissue. */
const EARLIER_GENERATIONS = 4n;
const RECENT_SPENDS = 50;

export type RuleInput = {
  /** The staff member's own passkey address in this business. */
  spender: string;
  perPaymentMaxMinor: bigint;
  cap: RuleCap;
  expiresAtMs: bigint;
  startsAtMs?: bigint | null;
  lifetimeCapMinor?: bigint | null;
};

export type RecipientChange = {
  add?: Array<{ address: string; tag: 'wallet' | 'exchange' }>;
  remove?: string[];
  addBeneficiaries?: Array<{ commitment: string; partnerDeposit: string }>;
  removeBeneficiaries?: string[];
};

function nowOf(sc: SpendContext): bigint {
  return BigInt((sc.wallet.signing.now ?? (() => new Date()))().getTime());
}

async function gas(sc: SpendContext) {
  return sc.wallet.signing.sponsor ? sc.wallet.signing.sponsor.gasFor() : null;
}

type Loaded = {
  account: AccountState;
  wallet: string;
  walletEpoch: bigint;
  policyId: string;
  policy: PolicyState | null;
  earlier: PolicyState[];
  held: HeldAllowance[];
  now: bigint;
  appName: string;
};

/** Everything a rule decision needs, read fresh from the chain. */
async function load(sc: SpendContext, opts: { wallet?: WalletMembers } = {}): Promise<Loaded | SpendFailure> {
  let account: AccountState;
  try {
    account = await sc.wallet.readAccount();
  } catch {
    return refuse(502, 'account_unreadable', 'the business account could not be read from the chain');
  }
  if (!account.wallet) return refuse(409, 'no_wallet', 'register the business wallet first');
  if (account.walletEpoch === undefined) return refuse(502, 'account_unreadable', "the business account's wallet generation could not be read");
  const wallet = normalizeSuiAddress(account.wallet);
  if (opts.wallet && walletRegistration(opts.wallet).address !== wallet) {
    return refuse(409, 'wallet_changed', 'the business wallet changed; reload and try again');
  }
  const policyId = policyIdFor({
    policyRegistryId: sc.chain.policyRegistry.objectId,
    spendPackageId: sc.chain.spendPackageId,
    accountId: sc.wallet.account.objectId,
    walletEpoch: account.walletEpoch,
  });
  const earlierIds: string[] = [];
  for (let e = account.walletEpoch - 1n; e >= 1n && e >= account.walletEpoch - EARLIER_GENERATIONS; e--) {
    earlierIds.push(policyIdFor({ policyRegistryId: sc.chain.policyRegistry.objectId, spendPackageId: sc.chain.spendPackageId, accountId: sc.wallet.account.objectId, walletEpoch: e }));
  }
  try {
    const [policy, ...earlierRead] = await Promise.all([sc.read.readPolicy(policyId), ...earlierIds.map((id) => sc.read.readPolicy(id))]);
    const accountId = normalizeSuiAddress(sc.wallet.account.objectId);
    // A policy is this business's only if it says so (the id is derived from the account too).
    const mine = (p: PolicyState | null): p is PolicyState => p !== null && normalizeSuiAddress(p.account) === accountId;
    const earlier = earlierRead.filter(mine);
    const holders = [...new Set([wallet, ...earlier.map((p) => p.wallet)])];
    const caps = (await Promise.all(holders.map((h) => sc.read.listAllowanceCaps(h)))).flat();
    const allowances = await sc.read.readAllowances(caps.map((c) => c.allowance));
    const byId = new Map(allowances.map((a) => [normalizeSuiAddress(a.id), a]));
    const held: HeldAllowance[] = [];
    for (const c of caps) {
      const a = byId.get(normalizeSuiAddress(c.allowance));
      if (a) held.push({ ...a, cap: { objectId: normalizeSuiAddress(c.objectId), version: String(c.version), digest: c.digest } });
    }
    return {
      account,
      wallet,
      walletEpoch: account.walletEpoch,
      policyId,
      policy: mine(policy) ? policy : null,
      earlier,
      held,
      now: nowOf(sc),
      appName: splashSpendAppName(sc.chain.spendPackageId),
    };
  } catch {
    return refuse(502, 'chain_unreadable', 'the spending rules could not be read from the chain');
  }
}

/** Settings → Team & rules: every rule, its live spend, window, running totals and expiry. */
export async function readSpendingRules(sc: SpendContext): Promise<{ ok: true; view: SpendView } | SpendFailure> {
  const l = await load(sc);
  if (isFailure(l)) return l;
  let spends: RuleSpendEvent[] = [];
  if (l.policy) {
    try {
      spends = await sc.read.listRuleSpends(l.policy.id, RECENT_SPENDS);
    } catch {
      spends = [];
    }
  }
  const standing = sc.standing ? await sc.standing() : undefined;
  return {
    ok: true,
    view: buildSpendView({ now: l.now, wallet: l.wallet, walletEpoch: l.walletEpoch, policy: l.policy, earlierPolicies: l.earlier, allowances: l.held, spends, appName: l.appName, standing }),
  };
}

/**
 * The current wallet generation's policy, or null when there is none (or it
 * cannot be read). For an approval ask: what it shows the owners about the
 * payee and the asker's own per-payment maximum.
 */
export async function readCurrentPolicy(sc: SpendContext): Promise<PolicyState | null> {
  const l = await load(sc);
  if (isFailure(l) || !l.policy) return null;
  const p = currentPolicy(l);
  return isFailure(p) ? null : p;
}

function currentPolicy(l: Loaded): PolicyState | SpendFailure {
  if (!l.policy) return refuse(409, 'no_policy', 'set up spending rules for this wallet first (its spending policy)');
  if (l.policy.wallet !== l.wallet || l.policy.walletEpoch !== l.walletEpoch) return refuse(409, 'stale_policy', 'the spending policy belongs to an earlier wallet; reissue the rules');
  return l.policy;
}

/** The decoder's allow-list for a request: this business's policies, allowances and caps. */
function spendScope(l: Loaded) {
  return {
    policyIds: [l.policyId, ...l.earlier.map((p) => p.id)],
    allowanceIds: l.held.map((a) => a.id),
    capIds: l.held.map((a) => a.cap.objectId),
  };
}

function sharedRef(p: { id: string; initialSharedVersion: string }) {
  return { objectId: p.id, initialSharedVersion: p.initialSharedVersion };
}

async function openRule(
  sc: SpendContext,
  l: Loaded,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; policy: PolicyState; ops: RuleOp[]; dedupeKey: string; walletTagAllowed: string[]; nextStep?: unknown },
): Promise<Result> {
  const g = await gas(sc);
  if (!g) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  let bytes: Uint8Array;
  try {
    bytes = await spendRuleTx(sc.chain, { wallet: l.wallet, account: sc.wallet.account, policy: sharedRef(input.policy), ops: input.ops, gas: g });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_rule', e.message ?? 'the change could not be built');
  }
  return openSigningRequest(sc.wallet.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'spend_rule',
    dedupeKey: input.dedupeKey,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
    spend: spendScope(l),
    walletTagAllowed: input.walletTagAllowed,
    nextStep: input.nextStep,
  });
}

// ─── The policy ─────────────────────────────────────────────────────────────

/** The wallet creates its spending policy for the current wallet generation. */
export async function startSpendPolicy(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; perPaymentMaxMinor: bigint; nextStep?: unknown },
): Promise<Result> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  if (l.policy) return refuse(409, 'policy_exists', 'this wallet already has its spending policy');
  if (input.perPaymentMaxMinor <= 0n) return refuse(400, 'bad_limit', 'the per-payment maximum must be above zero');
  const g = await gas(sc);
  if (!g) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const reg = walletRegistration(input.wallet);
  const bytes = await createSpendPolicyTx(sc.chain, {
    wallet: l.wallet,
    account: sc.wallet.account,
    keys: reg.keys,
    weights: reg.weights,
    threshold: reg.threshold,
    perPaymentMaxMinor: input.perPaymentMaxMinor,
    gas: g,
  });
  return openSigningRequest(sc.wallet.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'spend_policy',
    dedupeKey: `spend:policy:${l.walletEpoch}`,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
    nextStep: input.nextStep,
  });
}

function checkRule(rule: RuleInput, policy: PolicyState, wallet: string, now: bigint): SpendFailure | null {
  if (normalizeSuiAddress(rule.spender) === wallet) return refuse(400, 'bad_spender', 'the wallet pays through its own path, not under a rule');
  if (rule.perPaymentMaxMinor <= 0n) return refuse(400, 'bad_limit', 'the per-payment maximum must be above zero');
  if (rule.perPaymentMaxMinor > policy.perPaymentMax) return refuse(400, 'above_policy_max', "a rule's per-payment maximum cannot be above the business's");
  if (rule.cap.limitMinor <= 0n) return refuse(400, 'bad_limit', "the rule's daily or monthly cap must be above zero");
  if (rule.cap.period !== 'day' && rule.cap.period !== 'month') return refuse(400, 'bad_period', 'a rule caps spending per day or per month');
  if (rule.expiresAtMs <= now) return refuse(400, 'bad_expiry', 'the rule must expire in the future');
  if (rule.expiresAtMs > now + MAX_RULE_LIFETIME_MS) return refuse(400, 'bad_expiry', 'a rule lasts at most a year; reissue it then');
  if (rule.startsAtMs != null && rule.startsAtMs >= rule.expiresAtMs) return refuse(400, 'bad_expiry', 'a rule must start before it expires');
  if (rule.lifetimeCapMinor != null && rule.lifetimeCapMinor <= 0n) return refuse(400, 'bad_limit', 'a lifetime cap must be above zero');
  return null;
}

function issueOp(rule: RuleInput, policyId: string): RuleOp {
  return {
    op: 'issue_allowance',
    spender: normalizeSuiAddress(rule.spender),
    name: allowanceNameFor(policyId),
    cap: rule.cap,
    lifetimeCapMinor: rule.lifetimeCapMinor ?? null,
    startsAtMs: rule.startsAtMs ?? null,
    expiresAtMs: rule.expiresAtMs,
  };
}

/** The ops and the gate for a recipient change, or why it is refused. */
async function recipientOps(sc: SpendContext, orgId: string, policy: PolicyState, change: RecipientChange): Promise<{ ops: RuleOp[]; proven: string[] } | SpendFailure> {
  const ops: RuleOp[] = [];
  const onPolicy = new Map(policy.recipients.map((r) => [r.address, r.kind]));
  const bound = new Map(policy.beneficiaries.map((b) => [b.commitment, b.partnerDeposit]));
  const add = (change.add ?? []).map((r) => ({ address: normalizeSuiAddress(r.address), tag: r.tag }));
  const walletTagged = add.filter((r) => r.tag === 'wallet').map((r) => r.address);
  const proven = walletTagged.length ? await sc.ownership.provenAddresses(orgId, walletTagged) : [];
  const missing = walletTagged.filter((a) => !proven.includes(a));
  if (missing.length) {
    return refuse(409, 'ownership_not_proven', 'a recipient is tagged as a wallet only after its owner signs the ownership proof', { addresses: missing });
  }
  for (const r of change.remove ?? []) {
    const address = normalizeSuiAddress(r);
    if (!onPolicy.has(address)) return refuse(404, 'not_a_recipient', 'that address is not a verified recipient', { address });
    ops.push({ op: 'remove_recipient', address });
  }
  for (const c of change.removeBeneficiaries ?? []) {
    const commitment = c.toLowerCase();
    if (!bound.has(commitment)) return refuse(404, 'not_a_beneficiary', 'that beneficiary is not verified', { commitment });
    ops.push({ op: 'remove_beneficiary', commitment: new Uint8Array(Buffer.from(commitment, 'hex')) });
  }
  for (const r of add) {
    if (r.tag !== 'wallet' && r.tag !== 'exchange') return refuse(400, 'bad_tag', 'a recipient is tagged as a wallet or an exchange');
    if (onPolicy.has(r.address) && !(change.remove ?? []).map((x) => normalizeSuiAddress(x)).includes(r.address)) {
      return refuse(409, 'already_verified', 'that address is already a verified recipient; remove it first to change its tag', { address: r.address });
    }
    ops.push({ op: 'verify_recipient', address: r.address, kind: r.tag === 'wallet' ? RECIPIENT_TAG.WALLET : RECIPIENT_TAG.EXCHANGE });
  }
  for (const b of change.addBeneficiaries ?? []) {
    const commitment = b.commitment.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(commitment)) return refuse(400, 'bad_commitment', 'a beneficiary is named by its 32-byte commitment');
    ops.push({ op: 'verify_beneficiary', commitment: new Uint8Array(Buffer.from(commitment, 'hex')), partnerDeposit: normalizeSuiAddress(b.partnerDeposit) });
  }
  return { ops, proven };
}

// ─── Rules ──────────────────────────────────────────────────────────────────

/** Give a staff member a rule. Optionally verify recipients in the same transaction. */
export async function issueSpendingRule(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; rule: RuleInput; recipients?: RecipientChange },
): Promise<Result> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const bad = checkRule(input.rule, policy, l.wallet, l.now);
  if (bad) return bad;
  const spender = normalizeSuiAddress(input.rule.spender);
  const existing = l.held.filter((a) => a.spender === spender && boundTo(a, policy, l.appName));
  if (existing.length > 0) return refuse(409, 'rule_exists', 'this person already has a rule; change it instead');
  const recipients = await recipientOps(sc, input.orgId, policy, input.recipients ?? {});
  if (isFailure(recipients)) return recipients;
  const ops: RuleOp[] = [...recipients.ops];
  const listed = policy.spenders.find((x) => x.spender === spender);
  if (listed && listed.perPaymentMax !== input.rule.perPaymentMaxMinor) ops.push({ op: 'remove_spender', spender });
  if (!listed || listed.perPaymentMax !== input.rule.perPaymentMaxMinor) ops.push({ op: 'add_spender', spender, role: SPEND_ROLE.STAFF, perPaymentMaxMinor: input.rule.perPaymentMaxMinor });
  ops.push(issueOp(input.rule, policy.id));
  return openRule(sc, l, { ...input, policy, ops, dedupeKey: `spend:rule:${spender}`, walletTagAllowed: recipients.proven });
}

/**
 * Change a rule: revoke its allowance and issue the new one in the same
 * transaction. A changed per-payment maximum removes and re-adds the spender
 * (the only way the policy changes it), which retires every outstanding
 * approval; their running totals stay, since a total is the address's.
 */
export async function changeSpendingRule(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; rule: RuleInput },
): Promise<Result> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const bad = checkRule(input.rule, policy, l.wallet, l.now);
  if (bad) return bad;
  const spender = normalizeSuiAddress(input.rule.spender);
  const listed = policy.spenders.find((x) => x.spender === spender);
  const existing = l.held.filter((a) => a.spender === spender && boundTo(a, policy, l.appName));
  if (!listed && existing.length === 0) return refuse(404, 'no_rule', 'this person has no rule to change');
  const ops: RuleOp[] = existing.map((a) => ({ op: 'revoke_allowance', cap: a.cap, allowance: { objectId: a.id, initialSharedVersion: a.initialSharedVersion } }));
  if (listed && listed.perPaymentMax !== input.rule.perPaymentMaxMinor) ops.push({ op: 'remove_spender', spender });
  if (!listed || listed.perPaymentMax !== input.rule.perPaymentMaxMinor) ops.push({ op: 'add_spender', spender, role: SPEND_ROLE.STAFF, perPaymentMaxMinor: input.rule.perPaymentMaxMinor });
  ops.push(issueOp(input.rule, policy.id));
  return openRule(sc, l, { ...input, policy, ops, dedupeKey: `spend:rule:${spender}`, walletTagAllowed: [] });
}

/** Take a rule back: revoke every allowance the wallet gave this person, and remove them from the policy. */
export async function revokeSpendingRule(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; spender: string },
): Promise<Result> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const spender = normalizeSuiAddress(input.spender);
  // Every allowance the CURRENT wallet funds for this person (bound or not):
  // the wallet holds their caps, so its quorum can revoke them.
  const theirs = l.held.filter((a) => a.spender === spender && a.funder === l.wallet && a.app === l.appName);
  const listed = policy.spenders.some((x) => x.spender === spender);
  if (!listed && theirs.length === 0) return refuse(404, 'no_rule', 'this person has no rule');
  const ops: RuleOp[] = theirs.map((a) => ({ op: 'revoke_allowance', cap: a.cap, allowance: { objectId: a.id, initialSharedVersion: a.initialSharedVersion } }));
  if (listed) ops.push({ op: 'remove_spender', spender });
  return openRule(sc, l, { ...input, policy, ops, dedupeKey: `spend:rule:${spender}`, walletTagAllowed: [] });
}

/**
 * Take back, in one transaction, every staff rule whose holder may no longer
 * pay under one: a member who was removed, a viewer, or an address nobody
 * here holds (lib/server/spend-standing.ts). Each spender's allowances from
 * the current wallet are revoked and the spender is removed from the policy,
 * which stops them at once. The wallet's quorum signs it.
 */
export async function revokeOrphanedRules(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers },
): Promise<Result> {
  if (!sc.standing) return refuse(503, 'no_standing', 'who holds each rule cannot be read, so nothing was built');
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const standing = await sc.standing();
  const orphaned = policy.spenders.filter((x) => x.role === SPEND_ROLE.STAFF && standing(x.spender) !== 'member').map((x) => x.spender);
  if (orphaned.length === 0) return refuse(404, 'nothing_orphaned', 'every rule belongs to a current member');
  const ops: RuleOp[] = [];
  for (const spender of orphaned) {
    for (const a of l.held.filter((h) => h.spender === spender && h.funder === l.wallet && h.app === l.appName)) {
      ops.push({ op: 'revoke_allowance', cap: a.cap, allowance: { objectId: a.id, initialSharedVersion: a.initialSharedVersion } });
    }
    ops.push({ op: 'remove_spender', spender });
  }
  const opened = await openRule(sc, l, { ...input, policy, ops, dedupeKey: 'spend:offboard', walletTagAllowed: [] });
  if (opened.ok) {
    await recordAuthorityEvent(sc.db, {
      orgId: input.orgId,
      actorUserId: input.requestedBy,
      action: 'spending_rules_revoke_opened',
      ref: opened.request.id,
      detail: { spenders: orphaned.map((a) => ({ address: a, standing: standing(a) })) },
      now: () => new Date(Number(l.now)),
    });
  }
  return opened;
}

/** Verify or remove recipients and beneficiaries. */
export async function changeRecipients(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; change: RecipientChange },
): Promise<Result> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const r = await recipientOps(sc, input.orgId, policy, input.change);
  if (isFailure(r)) return r;
  if (r.ops.length === 0) return refuse(400, 'empty', 'nothing to change');
  return openRule(sc, l, { ...input, policy, ops: r.ops, dedupeKey: 'spend:recipients', walletTagAllowed: r.proven });
}

/** The business-wide limits: per-payment maximum, second-approval threshold, running-total window. */
export async function changePolicyLimits(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; perPaymentMaxMinor?: bigint; secondApprovalThresholdMinor?: bigint; runningWindowMs?: bigint },
): Promise<Result> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const ops: RuleOp[] = [];
  const max = input.perPaymentMaxMinor ?? policy.perPaymentMax;
  const threshold = input.secondApprovalThresholdMinor ?? policy.secondApprovalThreshold;
  if (max <= 0n) return refuse(400, 'bad_limit', 'the per-payment maximum must be above zero');
  if (max !== policy.perPaymentMax || threshold !== policy.secondApprovalThreshold) ops.push({ op: 'set_limits', perPaymentMaxMinor: max, secondApprovalThresholdMinor: threshold });
  if (input.runningWindowMs !== undefined && input.runningWindowMs !== policy.runningWindowMs) {
    if (input.runningWindowMs < MIN_WINDOW_MS || input.runningWindowMs > MAX_WINDOW_MS) return refuse(400, 'bad_window', 'the running-total window is an hour to thirty days');
    ops.push({ op: 'set_running_window', windowMs: input.runningWindowMs });
  }
  if (ops.length === 0) return refuse(400, 'empty', 'nothing to change');
  return openRule(sc, l, { ...input, policy, ops, dedupeKey: 'spend:limits', walletTagAllowed: [] });
}

// ─── A second approval ──────────────────────────────────────────────────────

const feeCeiling = (principal: bigint) => (principal * FEE_CEILING_BPS) / BPS;

/**
 * One owner approves one payment within a staff member's rule but above the
 * threshold: `approve_payout`, signed by that owner's own passkey, naming the
 * staff member as payer, the principal plus the fee shown (`max_total`) and
 * the quote's deadline. The owner may not be the maker or the payer.
 */
export async function openSecondApproval(
  sc: SpendContext,
  input: { orgId: string; ownerUserId: string; ownerPasskeyPublicKey: string; intentId: string; payer: string; maxFeeMinor: bigint; settleByMs: bigint },
): Promise<Result> {
  const l = await load(sc);
  if (isFailure(l)) return l;
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;
  const ownerKey = new PasskeyPublicKey(fromBase64(input.ownerPasskeyPublicKey));
  const owner = normalizeSuiAddress(ownerKey.toSuiAddress());
  if (!policy.owners.includes(owner)) return refuse(403, 'not_a_wallet_member', 'only a member of the business wallet gives a second approval');
  if (!sc.wallet.readIntent) return refuse(503, 'no_chain', 'the payment cannot be read from the chain');
  let intent: IntentState | null;
  try {
    intent = await sc.wallet.readIntent(normalizeSuiAddress(input.intentId));
  } catch {
    return refuse(502, 'intent_unreadable', 'the payment could not be read from the chain');
  }
  if (!intent || !intent.account || normalizeSuiAddress(intent.account) !== normalizeSuiAddress(sc.wallet.account.objectId)) return refuse(404, 'not_found', 'no such payment');
  if (intent.status !== 0) return refuse(409, 'intent_not_open', 'this payment is no longer waiting to be paid');
  if (intent.expiresAtMs <= l.now) return refuse(409, 'intent_expired', 'this payment has expired');
  if (intent.kind === V2_KIND.CROSS_CHAIN) return refuse(400, 'wrong_pay_path', 'a cross-chain payment is paid from the wallet, not under a rule');
  const payer = normalizeSuiAddress(input.payer);
  if (owner === payer || (intent.maker && owner === normalizeSuiAddress(intent.maker))) {
    return refuse(409, 'self_approval', 'a second approval comes from an owner who neither opened nor pays this payment');
  }
  if (!policy.spenders.some((x) => x.spender === payer)) return refuse(409, 'payer_not_a_spender', 'the person paying has no spending rule');
  if (input.maxFeeMinor < 0n || input.maxFeeMinor > feeCeiling(intent.amountMinor)) return refuse(400, 'bad_fee', "the fee shown is above Splash's 1% ceiling");
  if (input.settleByMs <= l.now || input.settleByMs > intent.expiresAtMs) return refuse(400, 'bad_deadline', "the quote's deadline must be in the future and no later than the payment's expiry");
  const g = await gas(sc);
  if (!g) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const bytes = await approvePayoutTx(sc.chain, {
    owner,
    account: sc.wallet.account,
    policy: sharedRef(policy),
    intent: { objectId: intent.id, initialSharedVersion: intent.initialSharedVersion },
    payer,
    maxTotalMinor: intent.amountMinor + input.maxFeeMinor,
    settleByMs: input.settleByMs,
    gas: g,
  });
  return openSigningRequest(sc.wallet.signing, {
    orgId: input.orgId,
    requestedBy: input.ownerUserId,
    purpose: 'spend_approval',
    dedupeKey: `spend:approve:${normalizeSuiAddress(intent.id)}`,
    transactionBytes: bytes,
    signer: { kind: 'single', userId: input.ownerUserId, publicKey: toBase64(ownerKey.toSuiBytes()) },
    gasMode: 'sponsored',
    spend: spendScope(l),
    payer,
    openIntent: {
      intentId: normalizeSuiAddress(intent.id),
      recipient: normalizeSuiAddress(intent.recipient),
      amountMinor: intent.amountMinor.toString(),
      kind: intent.kind,
      targetCurrency: intent.targetCurrency,
      fxRateUsdLocal: intent.fxRateUsdLocal.toString(),
      expiresAtMs: intent.expiresAtMs.toString(),
      asset: intent.asset,
    },
  });
}

// ─── After a rotation ───────────────────────────────────────────────────────

type ReissueStep = { purpose: 'spend_reissue' };

function capOf(a: AllowanceState): RuleCap | null {
  const rl = a.rateLimit;
  if (!rl) return null;
  if (rl.window.kind === 'periodic' && rl.window.periodMs === DAY_MS) return { period: 'day', limitMinor: rl.limit };
  if (rl.window.kind === 'calendar' && rl.window.months === 1) return { period: 'month', limitMinor: rl.limit };
  return null;
}

/**
 * After a rotation the earlier generation's policy and rules cannot pay. This
 * reissues them under the new wallet: first its policy (`spend_policy`, with
 * a follow-up step), then, once that lands, one `spend_rule` with the earlier
 * policy's limits, window, recipients (a WALLET tag only while its ownership
 * proof still holds), beneficiaries, spenders, and each unexpired rule's
 * allowance with the same cap and expiry (a lifetime cap carries what is left
 * of it). What could not be carried is listed in `skipped`.
 */
export async function reissueAfterRotation(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers },
): Promise<(Result & { skipped?: string[] }) | SpendFailure> {
  const l = await load(sc, { wallet: input.wallet });
  if (isFailure(l)) return l;
  const source = l.earlier.find((p) => p.spenders.length > 0 || p.recipients.length > 0 || p.beneficiaries.length > 0);
  if (!source) return refuse(404, 'nothing_to_reissue', 'no earlier spending rules to carry over');
  if (!l.policy) {
    const step: ReissueStep = { purpose: 'spend_reissue' };
    return startSpendPolicy(sc, { orgId: input.orgId, requestedBy: input.requestedBy, wallet: input.wallet, perPaymentMaxMinor: source.perPaymentMax, nextStep: step });
  }
  const policy = currentPolicy(l);
  if (isFailure(policy)) return policy;

  const skipped: string[] = [];
  const ops: RuleOp[] = [];
  if (policy.perPaymentMax !== source.perPaymentMax || policy.secondApprovalThreshold !== source.secondApprovalThreshold) {
    ops.push({ op: 'set_limits', perPaymentMaxMinor: source.perPaymentMax, secondApprovalThresholdMinor: source.secondApprovalThreshold });
  }
  if (policy.runningWindowMs !== source.runningWindowMs) ops.push({ op: 'set_running_window', windowMs: source.runningWindowMs });
  const have = new Set(policy.recipients.map((r) => r.address));
  const walletTagged = source.recipients.filter((r) => r.kind === RECIPIENT_TAG.WALLET && !have.has(r.address)).map((r) => r.address);
  const proven = walletTagged.length ? await sc.ownership.provenAddresses(input.orgId, walletTagged) : [];
  for (const r of source.recipients) {
    if (have.has(r.address)) continue;
    if (r.kind === RECIPIENT_TAG.WALLET && !proven.includes(r.address)) {
      skipped.push(`recipient ${r.address}: its ownership proof no longer holds`);
      continue;
    }
    ops.push({ op: 'verify_recipient', address: r.address, kind: r.kind });
  }
  const haveBeneficiaries = new Set(policy.beneficiaries.map((b) => b.commitment));
  for (const b of source.beneficiaries) {
    if (!haveBeneficiaries.has(b.commitment)) ops.push({ op: 'verify_beneficiary', commitment: new Uint8Array(Buffer.from(b.commitment, 'hex')), partnerDeposit: b.partnerDeposit });
  }
  const spenders = new Set(policy.spenders.map((x) => x.spender));
  for (const sp of source.spenders) {
    if (spenders.has(sp.spender)) continue;
    if (sp.role !== SPEND_ROLE.STAFF) {
      skipped.push(`spender ${sp.spender}: the operator's rule is set up again by Splash`);
      continue;
    }
    ops.push({ op: 'add_spender', spender: sp.spender, role: sp.role, perPaymentMaxMinor: sp.perPaymentMax });
    spenders.add(sp.spender);
    const old = l.held.filter((a) => a.spender === sp.spender && boundTo(a, source, l.appName));
    const alreadyIssued = l.held.some((a) => a.spender === sp.spender && boundTo(a, policy, l.appName));
    for (const a of alreadyIssued ? [] : old) {
      const cap = capOf(a);
      const remaining = a.lifetimeCap === null ? null : a.lifetimeCap - a.currentSpend;
      if (a.expiresAtMs === null || a.expiresAtMs <= l.now) {
        skipped.push(`rule of ${sp.spender}: expired`);
      } else if (!cap) {
        skipped.push(`rule of ${sp.spender}: its cap is not per day or per month`);
      } else if (remaining !== null && remaining <= 0n) {
        skipped.push(`rule of ${sp.spender}: its lifetime cap is used up`);
      } else {
        ops.push(issueOp({ spender: sp.spender, perPaymentMaxMinor: sp.perPaymentMax, cap, expiresAtMs: a.expiresAtMs, startsAtMs: a.startMs !== null && a.startMs > l.now ? a.startMs : null, lifetimeCapMinor: remaining }, policy.id));
      }
    }
  }
  if (ops.length === 0) return refuse(409, 'nothing_to_reissue', 'the rules are already carried over', { skipped });
  const opened = await openRule(sc, l, { ...input, policy, ops, dedupeKey: 'spend:reissue', walletTagAllowed: proven });
  return opened.ok ? { ...opened, skipped } : opened;
}

/**
 * The old wallet's quorum revokes the allowances it funded that can no longer
 * pay (stale after a rotation). Storage is refunded to it; nothing else moves.
 */
export async function revokeStaleAllowances(
  sc: SpendContext,
  input: { orgId: string; requestedBy: string; oldWallet: string },
): Promise<Result> {
  const l = await load(sc);
  if (isFailure(l)) return l;
  const old = normalizeSuiAddress(input.oldWallet);
  if (old === l.wallet) return refuse(400, 'not_stale', 'that is the current wallet; take rules back one by one');
  const members = await recordedWalletMembers(sc.db, input.orgId, old);
  if (!members) return refuse(404, 'wallet_unknown', 'Splash has no record of setting up that wallet for this business');
  const source = l.earlier.find((p) => p.wallet === old);
  const theirs = l.held.filter((a) => a.funder === old && a.app === l.appName);
  if (theirs.length === 0 || !source) return refuse(404, 'nothing_to_revoke', 'that wallet holds no spending rules');
  const ops: RuleOp[] = theirs.map((a) => ({ op: 'revoke_allowance', cap: a.cap, allowance: { objectId: a.id, initialSharedVersion: a.initialSharedVersion } }));
  const g = await gas(sc);
  if (!g) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  let bytes: Uint8Array;
  try {
    bytes = await spendRuleTx(sc.chain, { wallet: old, account: sc.wallet.account, policy: sharedRef(source), ops, gas: g });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_rule', e.message ?? 'the change could not be built');
  }
  return openSigningRequest(sc.wallet.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'spend_rule',
    dedupeKey: `spend:revoke-stale:${old}`,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...members },
    gasMode: 'sponsored',
    spend: spendScope(l),
    walletTagAllowed: [],
  });
}

/** After a spending-rule request executes: the step that follows it (the reissue after a new policy). */
export async function continueSpendSteps(sc: SpendContext, executed: StoredRequest): Promise<Result | SpendFailure | null> {
  await resolveOffboardedSpenders(sc.db, executed);
  const next = executed.nextStep as ReissueStep | null;
  if (!next || next.purpose !== 'spend_reissue' || executed.purpose !== 'spend_policy') return null;
  const wallet = await recordedWalletMembers(sc.db, executed.orgId, executed.senderAddress);
  if (!wallet) return null;
  return reissueAfterRotation(sc, { orgId: executed.orgId, requestedBy: executed.requestedBy, wallet });
}
