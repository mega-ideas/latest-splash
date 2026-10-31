/**
 * Client calls for Transfer. Each answers `{ ok, status, body }` and never
 * throws: a network failure is `status: 0`, which the page words as "could
 * not reach Splash", never as a refusal of the payment.
 */
import type { PaymentReceipt, ReceiptRow, EInvoiceOffer } from '@/lib/transfer/receipt';
import type { PolicyFacts, StaffRuleFacts } from '@/lib/transfer/plan';
import type { InFlightWire } from '@/lib/transfer/context';

export type Answer<T> = { ok: boolean; status: number; body: T | null };

export async function call<T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown; key?: string }): Promise<Answer<T>> {
  try {
    const response = await fetch(url, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      cache: 'no-store',
      headers: { ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init?.key ? { 'Idempotency-Key': init.key } : {}) },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = (await response.json().catch(() => null)) as T | null;
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export function errorText(answer: Answer<unknown>, fallback: string): string {
  if (answer.status === 0) return 'Could not reach Splash. Check your connection; nothing was sent.';
  const body = answer.body as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
}

export type Context = {
  role: string;
  orgId: string;
  walletState: 'ready' | 'none' | 'pending' | 'off' | 'unavailable';
  wallet: string | null;
  rule: StaffRuleFacts | null;
  policy: PolicyFacts | null;
  /** What every spender has paid each recipient in the window that counts towards the second-approval amount. */
  runningTotals: Record<string, string>;
  /** Payments already asked for that the chain has not counted: the caller's own cap and open payments, and everyone's towards each recipient. */
  inFlight?: InFlightWire;
  staffRulePaymentsWired: boolean;
};

export type SigningView = {
  id: string;
  /** What the request is for (`staff_rule_payment`: a staff member paying alone under their rule). */
  purpose?: string;
  status: string;
  transactionBytes: string;
  digest: string;
  bytesHash: string;
  expect: unknown;
  threshold: number;
  signedWeight: number;
  expiresAt: string;
  signers: Array<{ userId: string; address: string; weight: number; signed: boolean; declined: boolean }>;
  you: { mustSign: boolean; signed: boolean; declined: boolean; requested: boolean };
  executedDigest: string | null;
};

export type SavedRecipient = {
  id: string;
  name: string;
  country: string;
  delivery?: { deliveryKind: 'BANK' | 'EXCHANGE' | 'SELF_CUSTODY' | 'CROSS_CHAIN'; exchangeId?: string | null; destinationChain?: string | null; destinationAddress?: string | null; ownershipStatus?: string | null };
  walletAddress?: string;
  walletOwnershipProvenAt?: string | null;
  screeningVerdict?: string | null;
};

export type Beneficiary = { id: string; route: string; country: string; currency: string; bankCode: string; holderName: string; last4: string; label: string; status: string };

export type ReceiptAnswer = { receipt: PaymentReceipt; rows: ReceiptRow[]; eInvoice: { offer: EInvoiceOffer; made: { fileName: string; sha256: string; generatedAt: string } | null } };
