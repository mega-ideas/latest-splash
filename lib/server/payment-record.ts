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
 */
import { createHash } from 'node:crypto';

import { isProductionRuntime } from './runtime-mode.ts';

export type PaymentRecordInput = {
  orgId: string;
  transferId: string;
  payer: string;
  payee: string;
  amountMinor: string;
  maxFeeMinor: string;
  reference?: string | null;
};

export type PaymentRecordResult =
  | { ok: true; contentHash: Uint8Array; walrusBlobId: Uint8Array; mode: 'live' | 'sandbox' }
  | { ok: false; status: number; code: 'record_unavailable'; error: string };

export type PaymentRecorder = (input: PaymentRecordInput) => Promise<PaymentRecordResult>;

const UNAVAILABLE = 'The payment record cannot be made right now, so nothing was sent. Try again shortly.';
const refuse = (): PaymentRecordResult => ({ ok: false, status: 503, code: 'record_unavailable', error: UNAVAILABLE });

/** Canonical JSON: keys in a fixed order, so the same record always has the same bytes. */
export function canonicalRecord(input: PaymentRecordInput): string {
  return JSON.stringify({
    schema: 'splash.payment-record.v1',
    org: input.orgId,
    transfer: input.transferId,
    payer: input.payer,
    payee: input.payee,
    amountMinor: input.amountMinor,
    maxFeeMinor: input.maxFeeMinor,
    reference: input.reference ?? null,
  });
}

export function makePaymentRecorder(deps: {
  seal: { encrypt(data: string, allowlist: string[]): Promise<{ ciphertext: string; policy: { policyId: string; mode: 'demo' | 'live' } }> };
  store: (ciphertext: string) => Promise<{ blobId: string; mode: string }>;
  env?: NodeJS.ProcessEnv;
}): PaymentRecorder {
  const env = deps.env ?? process.env;
  return async (input) => {
    const production = isProductionRuntime(env);
    const plain = canonicalRecord(input);
    const contentHash = createHash('sha256').update(plain).digest();
    try {
      const sealed = await deps.seal.encrypt(Buffer.from(plain, 'utf8').toString('base64'), [input.orgId, 'auditor']);
      if (production && sealed.policy.mode !== 'live') return refuse();
      const blob = await deps.store(sealed.ciphertext);
      if (production && blob.mode !== 'live') return refuse();
      if (!blob.blobId) return refuse();
      const live = sealed.policy.mode === 'live' && blob.mode === 'live';
      return { ok: true, contentHash: new Uint8Array(contentHash), walrusBlobId: new TextEncoder().encode(blob.blobId), mode: live ? 'live' : 'sandbox' };
    } catch {
      return refuse();
    }
  };
}
