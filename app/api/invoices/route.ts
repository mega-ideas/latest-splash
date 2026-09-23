import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { buildInvoice } from '@/lib/server/operations';
import { listInvoicesFor, persistInvoice } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { sealAdapter } from '@/lib/server/seal';
import { storeEncryptedInvoice, WalrusAdapterError } from '@/lib/server/walrus';
import { requireTermsAccepted } from '@/lib/server/onboarding';

const createInvoiceSchema = z.object({
  issuerOrg: z.string().trim().min(2),
  payerOrgName: z.string().trim().min(2).optional(),
  payerOrgEmail: z.string().email().optional().or(z.literal('')),
  amountUsd: z.coerce.number().positive(),
  targetCurrency: z.string().trim().length(3),
  dueDate: z.string().min(8),
  memo: z.string().trim().max(500).optional(),
  documentBase64: z.string().optional(),
});

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // This returned every tenant's invoices — amounts, payers, memos, due
  // dates — to any authenticated caller.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  return NextResponse.json({ invoices: await listInvoicesFor(accountCheck.account.orgId) });
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
  let document:
    | { walrusBlobId: string; sealPolicyId: string; documentSha256: string; walrus: { sizeBytes: number; epochs: number; mode: string } }
    | undefined;

  try {
    if (input.documentBase64) {
      const documentSha256 = createHash('sha256').update(input.documentBase64).digest('hex');
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

    const invoice = await persistInvoice(buildInvoice({
      // From the SESSION, never the request.
      orgId: accountCheck.account.orgId,
      issuerOrg: input.issuerOrg,
      payerOrgName: input.payerOrgName,
      payerOrgEmail: input.payerOrgEmail || undefined,
      amountUsd: input.amountUsd.toFixed(2),
      targetCurrency: input.targetCurrency.toUpperCase(),
      dueDate: input.dueDate,
      memo: input.memo,
      status: 'draft',
      walrusBlobId: document?.walrusBlobId,
      sealPolicyId: document?.sealPolicyId,
      documentSha256: document?.documentSha256,
    }));
    return NextResponse.json({ invoice, walrus: document?.walrus ?? null }, { status: 201 });
  } catch (error) {
    if (error instanceof WalrusAdapterError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invoice creation failed' }, { status: 500 });
  }
}
