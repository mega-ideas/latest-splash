/**
 * The sealed record behind a payment's receipt (v2 brief 5.4, §4.5).
 *
 * Every payment from the business wallet anchors an audit bundle on chain: a
 * content hash and the Walrus blob that holds the sealed record
 * (`audit_anchor::anchor`). The page never makes that bundle: a client that
 * names its own hash and blob could anchor anything. The server builds the
 * record from the payment it just checked, seals it, stores the ciphertext,
 * and hands back the hash and the blob id.
 *
 * It fails closed. In production the bundle is made only with a live Seal
 * policy and a live Walrus publisher; a demo policy or a demo blob (the
 * stand-ins `lib/server/seal.ts` and `lib/server/walrus.ts` use when no
 * service is configured) is refused, and nothing is stored under a demo
 * policy. Outside production the stand-ins answer, and the result says
 * `sandbox`. A failure in either service is a refusal, never a made-up bundle.
 *
 * The hash is of the record, not of the ciphertext or the blob id, so the same
 * record always has the same hash and anyone holding it can check it.
 *
 * Who started it, who approved it (v2 Phase 3, Sky's rule). The record carries
 * a `trail`: who started the payment (internal id, role, and the name and title
 * as they were), when, by which route, under which rule, and which owners could
 * approve it. It is always there, whatever the name-sharing switches say: those
 * switches change only what an exchange is told and what the confirmation shows
 * (lib/server/exchange-names.ts). Names are inside the encrypted record only;
 * what is stored in plain text or anchored on chain is its hash and blob id.
 * The record is made before anyone approves, so each later signature, decline
 * or answer to an ask is one more sealed record bound to this one by its hash
 * (lib/server/payment-trail.ts). A record without a `trail` (a withdrawal, a
 * payout, a payment made before this) is byte for byte what it was.
 */
import { createHash } from 'node:crypto';

import { isProductionRuntime } from './runtime-mode.ts';

/** Who started a payment and under what: the audit trail the sealed record always holds. */
export type PaymentTrail = {
  startedBy: { userId: string; role: 'owner' | 'approver' | 'staff'; name: string | null; title: string | null };
  /** ISO time the payment was built. */
  startedAt: string;
  route: 'owners_sign' | 'asked_owners' | 'staff_rule';
  /** The staff rule it was paid under (a payment within a rule), as the chain said when it was built; null otherwise. */
  rule: { spender: string | null; status: string; perPaymentMaxMinor: string; spendableNowMinor: string; startsAtMs: string | null; expiresAtMs: string | null } | null;
  /** The owners (internal ids, sorted) who could approve it when it was built. */
  mayApprove: string[];
};

export type PaymentRecordInput = {
  orgId: string;
  transferId: string;
  payer: string;
  payee: string;
  amountMinor: string;
  maxFeeMinor: string;
  reference?: string | null;
  /** Who started it and under what (a wallet payment). Absent for a withdrawal or payout, whose record is unchanged. */
  trail?: PaymentTrail;
};

export type PaymentRecordResult =
  | { ok: true; contentHash: Uint8Array; walrusBlobId: Uint8Array; mode: 'live' | 'sandbox' }
  | { ok: false; status: number; code: 'record_unavailable'; error: string };

export type PaymentRecorder = (input: PaymentRecordInput) => Promise<PaymentRecordResult>;

const UNAVAILABLE = 'The payment record cannot be made right now, so nothing was sent. Try again shortly.';
const refuse = (): PaymentRecordResult => ({ ok: false, status: 503, code: 'record_unavailable', error: UNAVAILABLE });

/** Canonical JSON: keys in a fixed order, so the same record always has the same bytes. */
export function canonicalRecord(input: PaymentRecordInput): string {
  const t = input.trail;
  return JSON.stringify({
    schema: t ? 'splash.payment-record.v2' : 'splash.payment-record.v1',
    org: input.orgId,
    transfer: input.transferId,
    payer: input.payer,
    payee: input.payee,
    amountMinor: input.amountMinor,
    maxFeeMinor: input.maxFeeMinor,
    reference: input.reference ?? null,
    ...(t
      ? {
          trail: {
            startedBy: { userId: t.startedBy.userId, role: t.startedBy.role, name: t.startedBy.name, title: t.startedBy.title },
            startedAt: t.startedAt,
            route: t.route,
            rule: t.rule
              ? { spender: t.rule.spender, status: t.rule.status, perPaymentMaxMinor: t.rule.perPaymentMaxMinor, spendableNowMinor: t.rule.spendableNowMinor, startsAtMs: t.rule.startsAtMs, expiresAtMs: t.rule.expiresAtMs }
              : null,
            mayApprove: [...t.mayApprove],
            // None yet: each later decision is its own sealed record, bound to this one by this record's hash.
            decisions: [] as string[],
          },
        }
      : {}),
  });
}

type SealDeps = {
  seal: { encrypt(data: string, allowlist: string[]): Promise<{ ciphertext: string; policy: { policyId: string; mode: 'demo' | 'live' } }> };
  store: (ciphertext: string) => Promise<{ blobId: string; mode: string }>;
  env?: NodeJS.ProcessEnv;
};

export type RecordSealer = (plain: string, orgId?: string) => Promise<{ ok: true; contentHash: Uint8Array; blobId: string; mode: 'live' | 'sandbox' } | { ok: false }>;

/**
 * Seal one plain record and store the ciphertext, failing closed in production without the live services. The hash is of the plain
 * record. The auditor and the business may read it (Seal allowlist). Used for a payment's record and for each decision record.
 */
export function makeRecordSealer(deps: SealDeps): RecordSealer {
  const env = deps.env ?? process.env;
  return async (plain, orgId) => {
    const production = isProductionRuntime(env);
    const contentHash = createHash('sha256').update(plain).digest();
    try {
      const sealed = await deps.seal.encrypt(Buffer.from(plain, 'utf8').toString('base64'), orgId ? [orgId, 'auditor'] : ['auditor']);
      if (production && sealed.policy.mode !== 'live') return { ok: false };
      const blob = await deps.store(sealed.ciphertext);
      if (production && blob.mode !== 'live') return { ok: false };
      if (!blob.blobId) return { ok: false };
      return { ok: true, contentHash: new Uint8Array(contentHash), blobId: blob.blobId, mode: sealed.policy.mode === 'live' && blob.mode === 'live' ? 'live' : 'sandbox' };
    } catch {
      return { ok: false };
    }
  };
}

export function makePaymentRecorder(deps: SealDeps): PaymentRecorder {
  const sealer = makeRecordSealer(deps);
  return async (input) => {
    const sealed = await sealer(canonicalRecord(input), input.orgId);
    if (!sealed.ok) return refuse();
    return { ok: true, contentHash: sealed.contentHash, walrusBlobId: new TextEncoder().encode(sealed.blobId), mode: sealed.mode };
  };
}
