import { notFound } from 'next/navigation';

import PayInvoiceClient from '@/components/pay/PayInvoiceClient';
import { findInvoiceBySlug } from '@/lib/server/invoices-store';
import { payLinkBankInstructions } from '@/lib/server/pay-link';
import { findIssuerForPayLink } from '@/lib/server/recipients-store';
import { publicUsdcForSlug } from '@/lib/server/usdc-invoice-payments';

export default async function PayInvoicePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const invoice = await findInvoiceBySlug(slug);
  if (!invoice) notFound();
  const issuer = await findIssuerForPayLink(invoice.orgId, invoice.issuerOrg);
  const reference = invoice.paymentReference ?? `SPL-${slug.toUpperCase()}-${invoice.id.slice(-4).toUpperCase()}`;
  const usdc = await publicUsdcForSlug(slug);

  return (
    <PayInvoiceClient
      slug={slug}
      invoice={{
        issuerOrg: invoice.issuerOrg,
        issuerVerified: issuer?.kybStatus === 'full',
        amountUsd: invoice.amountUsd,
        targetCurrency: invoice.targetCurrency,
        dueDate: invoice.dueDate,
        memo: invoice.memo,
        status: invoice.status,
        paymentReference: reference,
        bankInstructions: payLinkBankInstructions(),
        usdc,
      }}
    />
  );
}
