import { NextResponse } from 'next/server';
import { z } from 'zod';

import { parseInvoice, type CopilotSuggestion } from '@/lib/server/copilot';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { readJsonBody } from '@/lib/server/http';
import { readInvoice } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { patchAuditReceipt } from '@/lib/server/transfers-store';
import { sealAdapter } from '@/lib/server/seal';
import { retrieveBlob } from '@/lib/server/walrus';

const schema = z.object({ invoiceId: z.string().min(1) });

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // Extraction feeds a document to the model: bounded per user.
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.extractInvoiceUser, key: auth.session.email });
  if (limited) return limited;

  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 });
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const invoice = await readInvoice(accountCheck.account.orgId, parsed.data.invoiceId);
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  let invoiceText = `${invoice.memo ?? ''} Vendor: ${invoice.payerOrgName ?? ''} Amount due ${invoice.amountUsd} ${invoice.targetCurrency}`;
  if (invoice.walrusBlobId && invoice.sealPolicyId) {
    const blob = await retrieveBlob(invoice.walrusBlobId);
    if (blob) {
      const decrypted = await sealAdapter.decrypt(blob.encryptedData, invoice.sealPolicyId, invoice.issuerOrg);
      if (decrypted) invoiceText = `${invoiceText}\n${Buffer.from(decrypted, 'base64').toString('utf8').slice(0, 5000)}`;
    }
  }
  const extraction = await parseInvoice(invoiceText);
  const deliveryTier = invoice.targetCurrency === 'PHP' ? 'SWEEP_ACCOUNT' : 'PAYOUT_ONLY';
  const suggestion: CopilotSuggestion = {
    suggestionId: `invoice_${invoice.id}`,
    type: 'invoice',
    title: `${deliveryTier} recommended`,
    description: deliveryTier === 'SWEEP_ACCOUNT'
      ? 'SWEEP_ACCOUNT via PDAX - recipient has no stored-balance enablement.'
      : 'Bank payout - direct local delivery is the enabled route for this corridor.',
    confidence: Math.max(0.96, extraction.confidence),
    requiresAuth: true,
    suggestedAction: `deliveryTier:${deliveryTier}`,
  };
  if (invoice.transferIntentId) await patchAuditReceipt(invoice.transferIntentId, { extractionSnapshot: extraction });
  return NextResponse.json({ extraction, suggestion });
}
