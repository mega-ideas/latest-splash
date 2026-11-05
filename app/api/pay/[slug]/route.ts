import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { parsePaymentReport } from '@/lib/invoices/pay-report';
import { PAYER_MAY_REPORT } from '@/lib/invoices/status';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { recordAnalyticsEvent } from '@/lib/server/operations';
import { findInvoiceBySlug, reportInvoicePayment } from '@/lib/server/invoices-store';
import { payLinkBankInstructions } from '@/lib/server/pay-link';
import { findIssuerForPayLink, upsertRecipientFromInvoice } from '@/lib/server/recipients-store';
import { publicUsdcForSlug } from '@/lib/server/usdc-invoice-payments';
import { refuseOutsideLaunchScope, stablecoinOnly } from '@/lib/server/launch-scope';

async function publicInvoice(slug: string) {
  // Unscoped by design: the slug IS the capability. It is unguessable, it was
  // handed to a payer who has no account, and it resolves to one invoice.
  const invoice = await findInvoiceBySlug(slug);
  if (!invoice) return null;
  const issuer = await findIssuerForPayLink(invoice.orgId, invoice.issuerOrg);
  return {
    id: invoice.id,
    issuerOrg: invoice.issuerOrg,
    issuerVerified: issuer?.kybStatus === 'full',
    amountUsd: invoice.amountUsd,
    targetCurrency: invoice.targetCurrency,
    dueDate: invoice.dueDate,
    memo: invoice.memo,
    status: invoice.status,
    paymentReference: invoice.paymentReference ?? `SPL-${slug.toUpperCase()}-${invoice.id.slice(-4).toUpperCase()}`,
    // A Splash collection account only once Splash may hold the funds; null in
    // Phase 0, and the payer pays the issuer directly.
    bankInstructions: payLinkBankInstructions(),
    bankReports: !stablecoinOnly(),
    usdc: await publicUsdcForSlug(slug),
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const invoice = await publicInvoice(slug);
  return invoice
    ? NextResponse.json(invoice)
    : NextResponse.json({ error: 'Payment request not found' }, { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  // Public and unauthenticated: the only thing that bounds it is the network
  // it comes from. Limited before the slug is even looked up, so probing
  // slugs is bounded too.
  const limited = await enforceRateLimit({
    rule: RATE_LIMITS.payLinkIp,
    key: clientIp(request),
    message: 'Too many payment submissions from this network. Try again shortly.',
  });
  if (limited) return limited;
  const outOfScope = refuseOutsideLaunchScope();
  if (outOfScope) return outOfScope;

  const { slug } = await params;
  const invoice = await findInvoiceBySlug(slug);
  if (!invoice) return NextResponse.json({ error: 'Payment request not found' }, { status: 404 });
  // Bounded, and the reference in a plain form (lib/invoices/pay-report.ts).
  const parsed = parsePaymentReport(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'Valid payer details are required' }, { status: 400 });

  // The payer's word is a report, not a payment: it moves the invoice to
  // "reported", and only the issuer or a matched Sui payment makes it paid
  // (lib/invoices/status.ts). What the payer says is kept apart from the
  // issuer's own payment reference and from the payer the issuer named,
  // which it never replaces, and it is never the evidence for Mark as paid.
  // Once reported, paid or settled, nothing here overwrites it; the same
  // report again is answered as before.
  const replayed = invoice.status === 'reported'
    && invoice.payerReportedReference === parsed.data.paymentReference
    && invoice.payerReportedEmail === parsed.data.payerOrgEmail;
  if (replayed) return NextResponse.json({ ok: true, replayed: true });
  if (!PAYER_MAY_REPORT.includes(invoice.status)) {
    return NextResponse.json({ error: 'This invoice already has a payment on record.', code: 'status' }, { status: 409 });
  }

  // By id, not by session: the payer has no account. The slug already
  // established which invoice this is. Guarded on the status it leaves, so a
  // report that raced another lands once.
  const reported = await reportInvoicePayment(invoice.id, PAYER_MAY_REPORT, {
    payerOrgName: parsed.data.payerOrgName,
    payerOrgEmail: parsed.data.payerOrgEmail,
    reference: parsed.data.paymentReference,
    at: new Date(),
  });
  if (!reported) {
    return NextResponse.json({ error: 'This invoice already has a payment on record.', code: 'status' }, { status: 409 });
  }

  // The payer becomes a beneficiary of the ISSUING org, which the invoice now
  // names directly rather than by looking its issuer up by name.
  const recipient = await upsertRecipientFromInvoice({
    orgId: invoice.orgId,
    name: parsed.data.payerOrgName,
    orgEmail: parsed.data.payerOrgEmail,
  });
  const counterpartyPull = recordAnalyticsEvent('counterparty_pull');
  // The recipient id only: the payer's address stays out of the logs.
  console.info('[kyb-invite] prepared', { recipientId: recipient.id });
  return NextResponse.json({ ok: true, recipientId: recipient.id, counterpartyPull });
}
