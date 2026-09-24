import { NextResponse } from 'next/server';
import { z } from 'zod';

import { laneRefusalText, zekeLaneState } from '@/lib/agent/zeke-lane-guard';
import { laneAccess } from '@/lib/payments/stablecoin-lane';
import { parseInvoice, type CopilotSuggestion } from '@/lib/server/copilot';
import { custodyPhaseEnabled, invoiceDeliveryTier } from '@/lib/server/custody-phase';
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
  // The vendor pattern is remembered for the caller's org, from the session.
  const parsedInvoice = await parseInvoice(invoiceText, accountCheck.account.orgId);
  // amountMinor is a bigint, which JSON cannot carry — this route answered 500
  // on every extraction until it was converted. A decimal string, so the
  // minor-unit amount stays exact on the wire and in the stored receipt.
  const extraction = { ...parsedInvoice, amountMinor: parsedInvoice.amountMinor.toString() };

  // Zeke has now READ what the invoice asks for. A payout in anything but USDC
  // is the fiat lane, and a business still in verification cannot use it — so
  // the loop stops here, with the reason, instead of recommending a route the
  // authorize button would refuse. Both the record's currency and the one read
  // off the document count: an invoice re-typed as USDC that still says PHP on
  // its face is still a PHP invoice.
  const localCurrency = [invoice.targetCurrency, extraction.currency]
    .map((c) => String(c ?? '').trim().toUpperCase())
    .find((c) => c && c !== 'USDC');
  if (localCurrency) {
    const state = await zekeLaneState(accountCheck.account.orgId);
    const access = laneAccess(state, 'FIAT_OUT_LOCAL');
    if (!access.allowed) {
      const refused: CopilotSuggestion = {
        suggestionId: `invoice_${invoice.id}`,
        type: 'invoice',
        title: `Refused: ${localCurrency} payout is locked`,
        description: laneRefusalText('FIAT_OUT_LOCAL', state, localCurrency),
        confidence: extraction.confidence,
        requiresAuth: false,
        suggestedAction: 'lane:FIAT_OUT_LOCAL:locked',
        blocked: { lane: 'FIAT_OUT_LOCAL', reason: access.reason },
      };
      return NextResponse.json({ extraction, suggestion: refused });
    }
  }

  // Only a tier the authorize step will accept: in Phase 0 that is PAYOUT_ONLY,
  // PHP included. SWEEP_ACCOUNT holds funds and waits for the custody phase.
  const deliveryTier = invoiceDeliveryTier(invoice.targetCurrency);
  const directPayout = 'Direct payout - funds go straight to the recipient\'s bank account or wallet, and nothing is held in between.';
  const suggestion: CopilotSuggestion = {
    suggestionId: `invoice_${invoice.id}`,
    type: 'invoice',
    title: `${deliveryTier} recommended`,
    description: deliveryTier === 'SWEEP_ACCOUNT'
      ? 'SWEEP_ACCOUNT via PDAX - recipient has no stored-balance enablement.'
      : custodyPhaseEnabled()
      ? directPayout
      : `${directPayout} Phase 0 pays out only: sweep and stored-balance delivery need a money-broking licence Splash does not hold yet.`,
    // What the parser actually returned. It was floored at 0.96, so a
    // heuristic read at 0.2 was shown as 96% confident.
    confidence: extraction.confidence,
    requiresAuth: true,
    suggestedAction: `deliveryTier:${deliveryTier}`,
  };
  if (invoice.transferIntentId) await patchAuditReceipt(invoice.transferIntentId, { extractionSnapshot: extraction });
  return NextResponse.json({ extraction, suggestion });
}
