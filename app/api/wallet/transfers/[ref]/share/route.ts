import { NextResponse } from 'next/server';

import { resolveEmailTransport, EmailDeliveryError } from '@/lib/auth/email-transport';
import { readJsonBody } from '@/lib/server/http';
import { paymentReceiptFor } from '@/lib/server/payment-receipts';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { liveReceiptShares, mintReceiptShare, revokeReceiptShares } from '@/lib/server/receipt-documents';
import { receiptRefFor } from '@/lib/server/wallet-transfers';
import { receiptDepsFor, transferRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requireOwner, requirePayoutReader } from '@/lib/server/wallet-route';
import { accountantMessage, isEmail } from '@/lib/transfer/receipt';

export const dynamic = 'force-dynamic';

/**
 * Sharing a receipt (v2 brief 5.4 step 5).
 *
 * POST { via: 'link' }                  makes a link that opens this one receipt
 *                                       for a month, readable without signing in.
 * POST { via: 'accountant', to }        makes a link and emails it, with the receipt,
 *                                       to the address given (one address, from Splash).
 *
 * WhatsApp and a mail program are links the person sends from their own app
 * (lib/transfer/receipt.ts); the PDF is GET .../receipt?format=pdf. Only a
 * settled payment's receipt is shared, only this business's own, and each
 * request is limited per person.
 */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.receiptSendUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const body = await readJsonBody(request);
  const via = body.via === 'accountant' ? 'accountant' : body.via === 'link' ? 'link' : null;
  if (!via) return NextResponse.json({ error: 'Choose a link or an accountant.' }, { status: 400, headers: NO_STORE });
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (via === 'accountant' && !isEmail(to)) return NextResponse.json({ error: 'That email address does not look right.', code: 'bad_email' }, { status: 400, headers: NO_STORE });

  const { ref } = await params;
  const evidenceRef = await receiptRefFor(gate.deps, ref);
  if (!evidenceRef) return NextResponse.json({ error: 'The owners have not approved this payment yet, so there is no receipt.' }, { status: 404, headers: NO_STORE });
  const made = await paymentReceiptFor(await receiptDepsFor(gate.route.db, gate.route.orgId), evidenceRef, gate.route.authority.userId);
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: made.status, headers: NO_STORE });
  if (!made.receipt.final) return NextResponse.json({ error: 'This payment has not settled yet. A receipt is shared once it has.', code: 'not_settled' }, { status: 409, headers: NO_STORE });

  const { token, expiresAt } = await mintReceiptShare(gate.route.db, { orgId: gate.route.orgId, paymentRef: made.receipt.paymentRef, userId: gate.route.authority.userId, now: new Date() });
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '') || new URL(request.url).origin;
  const url = `${base}/receipt/${token}`;
  if (via === 'link') return NextResponse.json({ url, expiresAt: expiresAt.toISOString() }, { status: 201, headers: NO_STORE });

  const message = accountantMessage(made.receipt, url, { business: made.payerName });
  try {
    await resolveEmailTransport().sendMessage({ to, subject: message.subject, text: message.text, link: url });
  } catch (error) {
    if (error instanceof EmailDeliveryError) {
      return NextResponse.json({ error: 'The email could not be sent just now. Nothing was sent; try again, or copy the link.', code: 'email_unavailable', url }, { status: 502, headers: NO_STORE });
    }
    throw error;
  }
  return NextResponse.json({ sent: true, url, expiresAt: expiresAt.toISOString() }, { status: 201, headers: NO_STORE });
}

/** The payment's reference as its receipt carries it, for this business only; null when there is no such payment. */
async function paymentRefOf(request: Request, params: Promise<{ ref: string }>) {
  const gate = await transferRoute(request);
  if (gate.response) return { response: gate.response };
  const reader = requirePayoutReader(gate.route);
  if (reader) return { response: reader };
  const { ref } = await params;
  const evidenceRef = await receiptRefFor(gate.deps, ref);
  if (!evidenceRef) return { response: NextResponse.json({ error: 'There is no receipt for this payment yet.' }, { status: 404, headers: NO_STORE }) };
  const made = await paymentReceiptFor(await receiptDepsFor(gate.route.db, gate.route.orgId), evidenceRef, gate.route.authority.userId);
  if (!made.ok) return { response: NextResponse.json({ error: made.error, code: made.code }, { status: made.status, headers: NO_STORE }) };
  return { route: gate.route, paymentRef: made.receipt.paymentRef };
}

/** GET: how many links to this receipt still open, and whether this person can stop them (an owner can). */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const found = await paymentRefOf(request, params);
  if (found.response) return found.response;
  const live = await liveReceiptShares(found.route.db, { orgId: found.route.orgId, paymentRef: found.paymentRef, now: new Date() });
  return NextResponse.json({ live: live.length, expiresAt: live.map((l) => l.expiresAt.toISOString()).sort().pop() ?? null, canRevoke: found.route.authority.role === 'OWNER' }, { headers: NO_STORE });
}

/** DELETE: stop sharing. Every link made to this receipt stops opening at once. Owners only. */
export async function DELETE(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const found = await paymentRefOf(request, params);
  if (found.response) return found.response;
  const owner = requireOwner(found.route, 'stop sharing a receipt');
  if (owner) return owner;
  const stopped = await revokeReceiptShares(found.route.db, { orgId: found.route.orgId, paymentRef: found.paymentRef, now: new Date() });
  return NextResponse.json({ stopped }, { headers: NO_STORE });
}
