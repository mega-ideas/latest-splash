import { NextResponse } from 'next/server';

import { complianceResponse, exchangePaymentDepsFor } from '@/lib/server/compliance-deps';
import { senderDeclarationFor } from '@/lib/server/exchange-payment-compliance';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { NO_STORE,requirePayoutReader, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * The sender-declaration pack for a wallet payment to an exchange recipient
 * (v2 §4.6, D5a): `{ exchange, invoiceNumber?, invoiceDate?, format? }`,
 * format `pdf` (the default) or `json`. Everything else in the pack is read
 * on the server: the payer from the business's profile, the sending wallet
 * and amount from this org's own signing request, the supplier from its
 * saved recipient at that address.
 */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.complianceReadUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const { ref } = await params;
  const body = await readJsonBody(request);
  const format = body.format ?? 'pdf';
  if (format !== 'pdf' && format !== 'json') return NextResponse.json({ error: 'format is pdf or json' }, { status: 400, headers: NO_STORE });
  const result = await senderDeclarationFor(exchangePaymentDepsFor(gate.route), {
    requestId: decodeURIComponent(ref),
    exchange: body.exchange,
    invoiceNumber: body.invoiceNumber,
    invoiceDate: body.invoiceDate,
  });
  if (!result.ok) return complianceResponse(result);
  const name = `splash-sender-declaration-${result.pack.json.paymentRef}`;
  const headers = { ...NO_STORE, 'X-Content-SHA256': result.pack.sha256 };
  if (format === 'json') return NextResponse.json(result.pack.json, { headers });
  return new Response(Buffer.from(result.pack.pdf), {
    headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"` },
  });
}
