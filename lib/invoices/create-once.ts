/**
 * Get paid (v2 brief 5.8): an invoice is created once.
 *
 * The create dialog makes one key (a UUID) per invoice it is creating and
 * keeps it across retries. The server keeps the key with the invoice under a
 * unique index per org (migration 0060). The same key with the same details
 * is a retry and is answered with the invoice already made; the same key
 * with other details is refused, because it is not the same invoice.
 *
 * The fingerprint is a hash of what the payer is asked to pay, normalised the
 * way the route stores it, so the same form sent twice matches itself.
 */
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCreateKey(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export type CreateFingerprintInput = {
  issuerOrg: string;
  payerOrgName?: string;
  payerOrgEmail?: string;
  amountUsd: number | string;
  targetCurrency: string;
  dueDate: string;
  memo?: string;
  documentSha256?: string;
};

export function createFingerprint(input: CreateFingerprintInput): string {
  const text = (value: string | undefined) => (value ?? '').trim();
  const normalised = {
    issuerOrg: text(input.issuerOrg),
    payerOrgName: text(input.payerOrgName),
    payerOrgEmail: text(input.payerOrgEmail).toLowerCase(),
    amountUsd: Number(input.amountUsd).toFixed(2),
    targetCurrency: text(input.targetCurrency).toUpperCase(),
    dueDate: text(input.dueDate),
    memo: text(input.memo),
    documentSha256: text(input.documentSha256),
  };
  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
}

/**
 * An invoice as a reply carries it: without the create key or the
 * fingerprint. Neither is needed by a client, and the fingerprint is a hash
 * over low-entropy details (payer email, amount, memo) that can be confirmed
 * offline. Both stay on the server.
 */
export function withoutCreateKey<T extends { createKey?: unknown; createFingerprint?: unknown }>(
  invoice: T | null | undefined,
): Omit<T, 'createKey' | 'createFingerprint'> | null {
  if (!invoice) return null;
  const { createKey: _key, createFingerprint: _fingerprint, ...rest } = invoice;
  void _key;
  void _fingerprint;
  return rest;
}

/** The code a client reads when a key comes back with other details. */
export const CREATE_KEY_REUSED = 'create_key_reused';
