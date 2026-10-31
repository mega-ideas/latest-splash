/**
 * The on-chain layouts a spending rule is read from, as BCS (v2 §4.2).
 *
 * Allowances emit no events, so Splash indexes a business's rules from the
 * objects themselves: the `AllowanceCap`s the business wallet owns, the
 * shared `Allowance`s they point to, and the business's `SpendPolicy` with
 * its tables. The fullnode's JSON rendering of Move values differs between
 * transports, so these are read as BCS against the Move structs, field for
 * field, in declaration order (`tests/spend-rules.test.mjs` checks the
 * order against the Move sources and the framework's allowance module).
 *
 * Also the two names Splash computes before proposing anything: the
 * allowance name a policy requires (`splash_spend::allowance_name`) and a
 * policy's object id (derived from the account and its wallet generation
 * under the publish-time `PolicyRegistry`).
 *
 * Isomorphic.
 */
import { bcs } from '@mysten/sui/bcs';
import { deriveObjectID, normalizeSuiAddress } from '@mysten/sui/utils';

import type { AllowanceWindow, RateLimitState, RunningTotalState } from './allowance-window.ts';

const UID = bcs.Address;

/** Each struct's field names, in the order its BCS layout reads them. */
export const LAYOUTS: Record<string, string[]> = {};
function struct<T extends Record<string, Parameters<typeof bcs.struct>[1][string]>>(name: string, fields: T) {
  LAYOUTS[name] = Object.keys(fields);
  return bcs.struct(name, fields);
}
const TypeName = struct('TypeName', { name: bcs.string() });

export const WindowBcs = bcs.enum('Window', { PeriodicMs: bcs.u64(), CalendarMonths: bcs.u8() });
export const RateLimitBcs = bcs.enum('RateLimit', {
  Windowed: struct('Windowed', { limit: bcs.u256(), spent: bcs.u256(), anchor_ms: bcs.option(bcs.u64()), index: bcs.u64(), window: WindowBcs }),
});
export const SettingsBcs = struct('Settings', {
  funder: bcs.Address,
  spender: bcs.option(bcs.Address),
  app: bcs.option(TypeName),
  lifetime_cap: bcs.option(bcs.u256()),
  start_timestamp_ms: bcs.option(bcs.u64()),
  expiration_timestamp_ms: bcs.option(bcs.u64()),
  rate_limit: bcs.option(RateLimitBcs),
  name: bcs.string(),
});
/** `0x2::allowance::Allowance<T>`. */
export const AllowanceBcs = struct('Allowance', { id: UID, settings: SettingsBcs, current_spend: bcs.u256() });
/** `0x2::allowance::AllowanceCap<T>`. */
export const AllowanceCapBcs = struct('AllowanceCap', { id: UID, allowance: bcs.Address });

const Table = struct('Table', { id: UID, size: bcs.u64() });
export const RunningKeyBcs = struct('RunningKey', { payer: bcs.Address, beneficiary: bcs.vector(bcs.u8()), recipient: bcs.Address });
const LinkedTable = struct('LinkedTable', { id: UID, size: bcs.u64(), head: bcs.option(RunningKeyBcs), tail: bcs.option(RunningKeyBcs) });
/** `splash_spend::spend_policy::SpendPolicy`. */
export const SpendPolicyBcs = struct('SpendPolicy', {
  id: UID,
  account: bcs.Address,
  wallet: bcs.Address,
  wallet_epoch: bcs.u64(),
  asset: bcs.string(),
  config: bcs.Address,
  fee_config: bcs.Address,
  address_registry: bcs.Address,
  owners: bcs.vector(bcs.Address),
  spenders: Table,
  spender_count: bcs.u64(),
  recipients: Table,
  recipient_count: bcs.u64(),
  beneficiaries: Table,
  beneficiary_count: bcs.u64(),
  partner_deposits: Table,
  per_payment_max: bcs.u64(),
  second_approval_threshold: bcs.u64(),
  generation: bcs.u64(),
  running_window_ms: bcs.u64(),
  running_totals: LinkedTable,
});
export const SpenderBcs = struct('Spender', { role: bcs.u8(), per_payment_max: bcs.u64() });
export const DestinationBcs = struct('Destination', { domain: bcs.u32(), addr: bcs.Address });
export const RunningTotalBcs = struct('RunningTotal', {
  window_start_ms: bcs.u64(),
  window_end_ms: bcs.u64(),
  last_payment_ms: bcs.u64(),
  total: bcs.u64(),
  carried: bcs.u64(),
  carried_until_ms: bcs.u64(),
});
/** `sui::linked_table::Node<K, V>`. Each table entry lives in a `0x2::dynamic_field::Field<K, V>` { id, name, value }. */
export const RunningNodeBcs = struct('Node', { prev: bcs.option(RunningKeyBcs), next: bcs.option(RunningKeyBcs), value: RunningTotalBcs });
/** `splash_spend::splash_spend::RuleSpend`. */
export const RuleSpendBcs = struct('RuleSpend', {
  policy_id: bcs.Address,
  intent_id: bcs.Address,
  allowance_id: bcs.Address,
  approval_id: bcs.option(bcs.Address),
  spender: bcs.Address,
  recipient: bcs.Address,
  derived_kind: bcs.u8(),
  fee: bcs.u64(),
});
export const PolicyKeyBcs = struct('PolicyKey', { account: bcs.Address, wallet_epoch: bcs.u64() });

// ─── Parsed shapes ──────────────────────────────────────────────────────────

export type AllowanceState = {
  id: string;
  funder: string;
  spender: string | null;
  /** The app type name as the chain records it (`with_defining_ids`, no 0x). */
  app: string | null;
  lifetimeCap: bigint | null;
  startMs: bigint | null;
  expiresAtMs: bigint | null;
  rateLimit: RateLimitState | null;
  name: string;
  /** Everything ever charged (`current_spend`). */
  currentSpend: bigint;
};

export type AllowanceCapState = { id: string; allowance: string };

export type SpendPolicyHead = {
  id: string;
  account: string;
  wallet: string;
  walletEpoch: bigint;
  asset: string;
  owners: string[];
  tables: { spenders: string; recipients: string; beneficiaries: string; partnerDeposits: string; runningTotals: string };
  counts: { spenders: bigint; recipients: bigint; beneficiaries: bigint; runningTotals: bigint };
  perPaymentMax: bigint;
  secondApprovalThreshold: bigint;
  generation: bigint;
  runningWindowMs: bigint;
};

const opt = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);
const big = (v: string | number | bigint) => BigInt(v);

function windowOf(w: { PeriodicMs?: string | number; CalendarMonths?: number; $kind?: string }): AllowanceWindow {
  if (w.PeriodicMs !== undefined && w.PeriodicMs !== null) return { kind: 'periodic', periodMs: big(w.PeriodicMs) };
  return { kind: 'calendar', months: Number(w.CalendarMonths) };
}

export function parseAllowance(bytes: Uint8Array): AllowanceState {
  const a = AllowanceBcs.parse(bytes);
  const s = a.settings;
  const rl = s.rate_limit ? s.rate_limit.Windowed : null;
  return {
    id: normalizeSuiAddress(a.id),
    funder: normalizeSuiAddress(s.funder),
    spender: s.spender ? normalizeSuiAddress(s.spender) : null,
    app: s.app ? s.app.name : null,
    lifetimeCap: opt(s.lifetime_cap) === null ? null : big(s.lifetime_cap as string),
    startMs: opt(s.start_timestamp_ms) === null ? null : big(s.start_timestamp_ms as string),
    expiresAtMs: opt(s.expiration_timestamp_ms) === null ? null : big(s.expiration_timestamp_ms as string),
    rateLimit: rl
      ? { limit: big(rl.limit), spent: big(rl.spent), anchorMs: opt(rl.anchor_ms) === null ? null : big(rl.anchor_ms as string), index: big(rl.index), window: windowOf(rl.window as never) }
      : null,
    name: s.name,
    currentSpend: big(a.current_spend),
  };
}

export function parseAllowanceCap(bytes: Uint8Array): AllowanceCapState {
  const c = AllowanceCapBcs.parse(bytes);
  return { id: normalizeSuiAddress(c.id), allowance: normalizeSuiAddress(c.allowance) };
}

export function parseSpendPolicy(bytes: Uint8Array): SpendPolicyHead {
  const p = SpendPolicyBcs.parse(bytes);
  return {
    id: normalizeSuiAddress(p.id),
    account: normalizeSuiAddress(p.account),
    wallet: normalizeSuiAddress(p.wallet),
    walletEpoch: big(p.wallet_epoch),
    asset: p.asset,
    owners: p.owners.map((o) => normalizeSuiAddress(o)),
    tables: {
      spenders: normalizeSuiAddress(p.spenders.id),
      recipients: normalizeSuiAddress(p.recipients.id),
      beneficiaries: normalizeSuiAddress(p.beneficiaries.id),
      partnerDeposits: normalizeSuiAddress(p.partner_deposits.id),
      runningTotals: normalizeSuiAddress(p.running_totals.id),
    },
    counts: { spenders: big(p.spender_count), recipients: big(p.recipient_count), beneficiaries: big(p.beneficiary_count), runningTotals: big(p.running_totals.size) },
    perPaymentMax: big(p.per_payment_max),
    secondApprovalThreshold: big(p.second_approval_threshold),
    generation: big(p.generation),
    runningWindowMs: big(p.running_window_ms),
  };
}

export type RunningEntry = RunningTotalState & { payer: string; beneficiary: string; recipient: string };

export function parseSpenderField(bytes: Uint8Array): { spender: string; role: number; perPaymentMax: bigint } {
  const f = bcs.struct('Field', { id: UID, name: bcs.Address, value: SpenderBcs }).parse(bytes);
  return { spender: normalizeSuiAddress(f.name), role: f.value.role, perPaymentMax: big(f.value.per_payment_max) };
}
export function parseRecipientField(bytes: Uint8Array): { domain: number; address: string; kind: number } {
  const f = bcs.struct('Field', { id: UID, name: DestinationBcs, value: bcs.u8() }).parse(bytes);
  return { domain: f.name.domain, address: normalizeSuiAddress(f.name.addr), kind: f.value };
}
export function parseBeneficiaryField(bytes: Uint8Array): { commitment: string; partnerDeposit: string } {
  const f = bcs.struct('Field', { id: UID, name: bcs.vector(bcs.u8()), value: DestinationBcs }).parse(bytes);
  return { commitment: Buffer.from(f.name).toString('hex'), partnerDeposit: normalizeSuiAddress(f.value.addr) };
}
export function parseRunningField(bytes: Uint8Array): RunningEntry {
  const f = bcs.struct('Field', { id: UID, name: RunningKeyBcs, value: RunningNodeBcs }).parse(bytes);
  const v = f.value.value;
  return {
    payer: normalizeSuiAddress(f.name.payer),
    beneficiary: Buffer.from(f.name.beneficiary).toString('hex'),
    recipient: normalizeSuiAddress(f.name.recipient),
    windowStartMs: big(v.window_start_ms),
    windowEndMs: big(v.window_end_ms),
    lastPaymentMs: big(v.last_payment_ms),
    total: big(v.total),
    carried: big(v.carried),
    carriedUntilMs: big(v.carried_until_ms),
  };
}

export type RuleSpendEvent = {
  policyId: string;
  intentId: string;
  allowanceId: string;
  approvalId: string | null;
  spender: string;
  recipient: string;
  derivedKind: number;
  fee: bigint;
  /** When the emitting transaction was checkpointed (ms), when the reader looked it up; the event itself carries no time. */
  timestampMs?: bigint | null;
};

export function parseRuleSpend(bytes: Uint8Array): RuleSpendEvent {
  const e = RuleSpendBcs.parse(bytes);
  return {
    policyId: normalizeSuiAddress(e.policy_id),
    intentId: normalizeSuiAddress(e.intent_id),
    allowanceId: normalizeSuiAddress(e.allowance_id),
    approvalId: e.approval_id ? normalizeSuiAddress(e.approval_id) : null,
    spender: normalizeSuiAddress(e.spender),
    recipient: normalizeSuiAddress(e.recipient),
    derivedKind: e.derived_kind,
    fee: big(e.fee),
  };
}

// ─── Names Splash computes ──────────────────────────────────────────────────

/**
 * `splash_spend::allowance_name`: `splash-policy:` and the policy's id as
 * `address::to_string` writes it (64 lowercase hex digits, no 0x).
 */
export function allowanceNameFor(policyId: string): string {
  return `splash-policy:${normalizeSuiAddress(policyId).slice(2)}`;
}

/** The policy id `create_policy` claims for this account and wallet generation. */
export function policyIdFor(input: { policyRegistryId: string; spendPackageId: string; accountId: string; walletEpoch: bigint }): string {
  const key = PolicyKeyBcs.serialize({ account: normalizeSuiAddress(input.accountId), wallet_epoch: input.walletEpoch }).toBytes();
  return normalizeSuiAddress(deriveObjectID(normalizeSuiAddress(input.policyRegistryId), `${normalizeSuiAddress(input.spendPackageId)}::spend_policy::PolicyKey`, key));
}

/** The app type an allowance bound to SPLASH_SPEND records: its defining id, no 0x. */
export function splashSpendAppName(spendPackageId: string): string {
  return `${normalizeSuiAddress(spendPackageId).slice(2)}::splash_spend::SPLASH_SPEND`;
}
