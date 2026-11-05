import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { LAUNCH_SCOPE_CODE, stablecoinOnly } from '@/lib/server/launch-scope';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { buildInvoice } from '@/lib/server/operations';
import { createInvoiceOnce, listInvoicesFor, readInvoiceByCreateKey } from '@/lib/server/invoices-store';
import { CREATE_KEY_REUSED, createFingerprint, withoutCreateKey } from '@/lib/invoices/create-once';
import { createInvoiceSchema } from '@/lib/invoices/create-input';
import { relyingPartyId } from '@/lib/auth/passkey';
import { issuerUsdcAddress } from '@/lib/server/usdc-invoice-payments';
import type { InvoiceRecord } from '@/lib/server/operations';
import { requireSessionAccount } from '@/lib/server/session-account';
import { sealAdapter } from '@/lib/server/seal';
import { storeEncryptedInvoice, WalrusAdapterError } from '@/lib/server/walrus';
import { requireTermsAccepted } from '@/lib/server/onboarding';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Can this business receive USDC on a pay link? The link pays the Splash
 * Wallet of its main admin (lib/server/usdc-invoice-payments.ts); with no
 * passkey there, or no database to look in, a payer would find no way to pay.
 * The dialog says so before the link is offered.
 */
async function receiveWallet(orgId: string): Promise<{ ready: boolean }> {
  if (!process.env.DATABASE_URL) return { ready: false };
  try {
    const { getDb } = await import('@/lib/db/client');
    return { ready: (await issuerUsdcAddress(getDb(), orgId, relyingPartyId())) !== null };
  } catch {
    return { ready: false };
  }
}

/**
 * The same key came back with other details. The invoice already made under
 * it is named (read for the session org only), so the user can open it
 * rather than send it uncorrected or make a second invoice for one debt.
 */
async function keyReused(orgId: string, existing: InvoiceRecord | null) {
  return NextResponse.json(
    {
      error: 'An invoice was already created from this form, with other details. Open it to check it, or close this form and start a new one.',
      code: CREATE_KEY_REUSED,
      existing: existing
        ? { id: existing.id, payerOrgName: existing.payerOrgName ?? null, amountUsd: existing.amountUsd, dueDate: existing.dueDate, status: existing.status, payLinkSlug: existing.payLinkSlug }
        : null,
      receiveWallet: await receiveWallet(orgId),
    },
    { status: 409, headers: NO_STORE },
  );
}

/** Created, or a retry answered with the invoice already made. Never the key or fingerprint. */
async function made(invoice: InvoiceRecord, status: 200 | 201, extra: Record<string, unknown>) {
  return NextResponse.json({ invoice: withoutCreateKey(invoice), receiveWallet: await receiveWallet(invoice.orgId), ...extra }, { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // This returned every tenant's invoices — amounts, payers, memos, due
  // dates — to any authenticated caller.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  return NextResponse.json({ invoices: (await listInvoicesFor(accountCheck.account.orgId)).map(withoutCreateKey) });
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // Each invoice is a store write and, with a document, a Seal + Walrus
  // round trip: bounded per user.
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.invoiceCreateUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  // Onboarding: the terms are a fact on file before anything spends or a
  // record is created (lib/server/onboarding.ts). Sits BESIDE the KYB gate,
  // never instead of it.
  const termsGate = await requireTermsAccepted(accountCheck.account.orgId);
  if (termsGate) return termsGate;

  const parsed = createInvoiceSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid invoice', details: parsed.error.flatten() }, { status: 400 });
  }

  const input = parsed.data;
  const orgId = accountCheck.account.orgId;
  const documentSha256 = input.documentBase64 ? createHash('sha256').update(input.documentBase64).digest('hex') : undefined;
  const fingerprint = createFingerprint({ ...input, payerOrgEmail: input.payerOrgEmail || undefined, documentSha256 });

  // A retry (a second click, or the same form after a dropped connection) is
  // answered with the invoice already made, before any document is sealed or
  // stored again: one invoice, one pay link, one exact amount.
  const already = await readInvoiceByCreateKey(orgId, input.createKey);
  if (already) {
    if (already.createFingerprint !== fingerprint) return keyReused(orgId, already);
    return made(already, 200, { walrus: null, replay: true });
  }

  let document:
    | { walrusBlobId: string; sealPolicyId: string; documentSha256: string; walrus: { sizeBytes: number; epochs: number; mode: string } }
    | undefined;

  // A document is sealed and stored on Walrus, neither of which this launch
  // runs (lib/launch-scope-rules.ts): refuse it up front rather than keep a
  // copy that would not survive. An invoice without one, paid in USDC, is open.
  if (input.documentBase64 && stablecoinOnly()) {
    return NextResponse.json(
      { error: 'Attaching the invoice document is not open yet. Create the invoice without it; it can still be paid in USDC on Sui.', code: LAUNCH_SCOPE_CODE },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    if (input.documentBase64 && documentSha256) {
      const { ciphertext, policy } = await sealAdapter.encrypt(input.documentBase64, [
        input.issuerOrg,
        input.payerOrgEmail || input.payerOrgName || 'pending',
        'auditor',
      ]);
      const blob = await storeEncryptedInvoice(ciphertext);
      document = {
        walrusBlobId: blob.blobId,
        sealPolicyId: policy.policyId,
        documentSha256,
        walrus: { sizeBytes: blob.sizeBytes, epochs: blob.epochs, mode: blob.mode },
      };
    }

    const once = await createInvoiceOnce(buildInvoice({
      // From the SESSION, never the request.
      orgId,
      issuerOrg: input.issuerOrg,
      payerOrgName: input.payerOrgName,
      payerOrgEmail: input.payerOrgEmail || undefined,
      amountUsd: input.amountUsd,
      targetCurrency: input.targetCurrency.toUpperCase(),
      dueDate: input.dueDate,
      memo: input.memo,
      status: 'draft',
      walrusBlobId: document?.walrusBlobId,
      sealPolicyId: document?.sealPolicyId,
      documentSha256: document?.documentSha256,
    }), { createKey: input.createKey, fingerprint });
    if (once.outcome !== 'created' && document) {
      // Another request with this key won while this one sealed and stored
      // the document: this blob is referenced by nothing. Logged by id (never
      // the document) so it can be cleaned up.
      console.warn('invoice create: orphaned encrypted document', {
        orgId,
        outcome: once.outcome,
        walrusBlobId: document.walrusBlobId,
        sealPolicyId: document.sealPolicyId,
      });
    }
    if (once.outcome === 'conflict') return keyReused(orgId, await readInvoiceByCreateKey(orgId, input.createKey));
    if (once.outcome === 'replay') return made(once.invoice, 200, { walrus: null, replay: true });
    return made(once.invoice, 201, { walrus: document?.walrus ?? null });
  } catch (error) {
    if (error instanceof WalrusAdapterError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Logged, not echoed: an internal error is not an answer for the person.
    console.error('invoice create failed', { orgId, name: error instanceof Error ? error.name : typeof error });
    return NextResponse.json({ error: 'The invoice was not created. Try again; it will not be made twice.' }, { status: 500 });
  }
}
