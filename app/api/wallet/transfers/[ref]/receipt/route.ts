import { NextResponse } from 'next/server';

import { paymentReceiptFor } from '@/lib/server/payment-receipts';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { receiptRefFor } from '@/lib/server/wallet-transfers';
import { receiptDepsFor, transferRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';
import { eInvoiceOffer, receiptRows } from '@/lib/transfer/receipt';
import { receiptPdf } from '@/lib/transfer/receipt-pdf';
import { readEInvoice } from '@/lib/server/receipt-documents';

export const dynamic = 'force-dynamic';

/**
 * One payment's receipt (v2 brief 5.4 step 5), by the payment's id, its
 * signing request, its payout or its intent id. Owners and staff of the
 * business; another business's payment reads as absent (404).
 *
 *   GET            { receipt, rows, eInvoice: { offer, made } }
 *   GET ?format=pdf  the receipt as a PDF
 *
 * A payment that has not settled has a receipt that says so (`final: false`).
 * A payment the owners have not yet accepted has none (404).
 */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.controlsEvidenceUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'pdf') return NextResponse.json({ error: 'format is json or pdf' }, { status: 400, headers: NO_STORE });
  const { ref } = await params;
  const evidenceRef = await receiptRefFor(gate.deps, ref);
  if (!evidenceRef) return NextResponse.json({ error: 'The owners have not approved this payment yet, so there is no receipt.', code: 'not_approved' }, { status: 404, headers: NO_STORE });
  const made = await paymentReceiptFor(await receiptDepsFor(gate.route.db, gate.route.orgId), evidenceRef, gate.route.authority.userId);
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: made.status, headers: NO_STORE });
  const { receipt } = made;
  if (format === 'pdf') {
    return new Response(Buffer.from(receiptPdf(receipt)), {
      headers: { ...NO_STORE, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="splash-receipt-${receipt.receiptNo}.pdf"` },
    });
  }
  const offer = eInvoiceOffer(receipt, { payerCountry: made.payerCountry, supplierCountry: made.supplierCountry });
  const file = await readEInvoice(gate.route.db, { orgId: gate.route.orgId, paymentRef: receipt.paymentRef, receiptNo: receipt.receiptNo });
  return NextResponse.json(
    { receipt, rows: receiptRows(receipt), eInvoice: { offer, made: file ? { fileName: file.fileName, sha256: file.sha256, generatedAt: file.generatedAt } : null } },
    { headers: NO_STORE },
  );
}
