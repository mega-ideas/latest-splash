import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readJsonBody } from '@/lib/server/http';
import { paymentReceiptFor } from '@/lib/server/payment-receipts';
import { makeEInvoice, readEInvoice } from '@/lib/server/receipt-documents';
import { receiptRefFor } from '@/lib/server/wallet-transfers';
import { receiptDepsFor, transferRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';
import { EINVOICE_GUIDELINE } from '@/lib/transfer/receipt';
import { SELF_BILLED_CLASSIFICATIONS } from '@/lib/myinvois/self-billed';
import { organizations } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const detailsSchema = z.object({
  buyerTin: z.string().trim().min(1).max(20),
  phone: z.string().trim().min(1).max(30),
  stateCode: z.string().trim().min(1).max(2),
  sstNumber: z.string().trim().max(30).optional(),
  email: z.string().trim().max(200).optional(),
  exchangeRateToMyr: z.string().trim().max(14).optional(),
  description: z.string().trim().min(1).max(300),
  classification: z.enum(Object.keys(SELF_BILLED_CLASSIFICATIONS) as [keyof typeof SELF_BILLED_CLASSIFICATIONS, ...Array<keyof typeof SELF_BILLED_CLASSIFICATIONS>]),
  supplierAddress: z.string().trim().max(140).optional(),
  supplierCity: z.string().trim().max(80).optional(),
  refresh: z.boolean().optional(),
});

/**
 * The self-billed e-invoice for a settled payment (v2 brief 5.4 step 5, D10):
 * UBL 2.1 JSON in LHDN's MyInvois format (lib/myinvois/self-billed.ts, the
 * guideline cited in lib/transfer/receipt.ts), made once, for a Malaysian
 * business paying a supplier outside Malaysia.
 *
 * GET           the file made, with ?download=1 as a file; 404 when none.
 * POST { buyerTin, phone, stateCode, description, classification,
 *        exchangeRateToMyr?, sstNumber?, email?, supplierAddress?,
 *        supplierCity?, refresh? }
 *               makes it from the receipt and the business's own details. The
 *               TIN, contact number, state and rate are the person's: Splash
 *               fills in none of them, and without them no file is made.
 *               Made already, it answers the same file.
 * The page then opens the MyInvois portal (EINVOICE_GUIDELINE.portal): Splash
 * does not submit it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { ref } = await params;
  const evidenceRef = await receiptRefFor(gate.deps, ref);
  const made = evidenceRef ? await paymentReceiptFor(await receiptDepsFor(gate.route.db, gate.route.orgId), evidenceRef, gate.route.authority.userId) : null;
  if (!made || !made.ok) return NextResponse.json({ error: 'No such payment.' }, { status: 404, headers: NO_STORE });
  const file = await readEInvoice(gate.route.db, { orgId: gate.route.orgId, paymentRef: made.receipt.paymentRef, receiptNo: made.receipt.receiptNo });
  if (!file) return NextResponse.json({ error: 'No e-invoice has been made for this payment.' }, { status: 404, headers: NO_STORE });
  if (new URL(request.url).searchParams.get('download') !== '1') return NextResponse.json({ eInvoice: file, guideline: EINVOICE_GUIDELINE }, { headers: NO_STORE });
  return new NextResponse(JSON.stringify(file.document, null, 2), {
    headers: { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"` },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const parsed = detailsSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'Some e-invoice details are not in the right form.', details: parsed.error.flatten().fieldErrors }, { status: 400, headers: NO_STORE });
  const { ref } = await params;
  const evidenceRef = await receiptRefFor(gate.deps, ref);
  const receipt = evidenceRef ? await paymentReceiptFor(await receiptDepsFor(gate.route.db, gate.route.orgId), evidenceRef, gate.route.authority.userId) : null;
  if (!receipt || !receipt.ok) return NextResponse.json({ error: 'No such payment.' }, { status: 404, headers: NO_STORE });
  const [org] = await gate.route.db
    .select({ legalName: organizations.legalName, name: organizations.name, registrationNumber: organizations.registrationNumber, line: organizations.addressLine1, city: organizations.addressCity, postcode: organizations.addressPostalCode })
    .from(organizations)
    .where(eq(organizations.id, gate.route.orgId))
    .limit(1);
  if (!org) return NextResponse.json({ error: 'Your business record is missing.' }, { status: 409, headers: NO_STORE });
  const b = parsed.data;
  const result = await makeEInvoice(gate.route.db, {
    orgId: gate.route.orgId,
    userId: gate.route.authority.userId,
    receipt: receipt.receipt,
    payerCountry: receipt.payerCountry,
    supplierCountry: receipt.supplierCountry,
    refresh: b.refresh,
    now: new Date(),
    details: {
      buyer: {
        name: org.legalName ?? org.name,
        tin: b.buyerTin,
        registrationNumber: org.registrationNumber ?? '',
        sstNumber: b.sstNumber,
        addressLine: org.line ?? '',
        city: org.city ?? '',
        postcode: org.postcode ?? undefined,
        stateCode: b.stateCode,
        phone: b.phone,
        email: b.email || undefined,
      },
      supplier: { name: receipt.receipt.payee.name, country: receipt.supplierCountry ?? '', addressLine: b.supplierAddress, city: b.supplierCity },
      exchangeRateToMyr: b.exchangeRateToMyr,
      description: b.description,
      classification: b.classification,
    },
  });
  if (!result.ok) {
    const { ok, status, ...rest } = result;
    void ok;
    return NextResponse.json(rest, { status, headers: NO_STORE });
  }
  return NextResponse.json({ eInvoice: result.eInvoice, guideline: EINVOICE_GUIDELINE, portal: EINVOICE_GUIDELINE.portal }, { status: result.created ? 201 : 200, headers: NO_STORE });
}
