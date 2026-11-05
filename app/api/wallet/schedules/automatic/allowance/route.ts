import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { requestAllowance, revokeAllowance } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { asResponse, limitWalletRequests, NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * The allowance the owners give Splash to pay scheduled batches automatically,
 * through the same signed request flow as a spending rule: the wallet's quorum
 * signs it on their own devices, it expires, and it can be taken back.
 *
 * POST    { perPaymentUsdc, dailyUsdc, monthlyUsdc, expiresInDays }: ask the
 *         owners to sign it (or to change the one in force). Nothing is in
 *         force until they do. Owners only. The body also carries summaryDigest,
 *         the digest of the summary the owner confirmed; the server builds its
 *         own from the schedules as they are now and answers 409
 *         summary_changed, with the new summary, when they differ. The answer
 *         carries the summary in plain words, built from the same values the
 *         request is, and the same text goes with the signing request so every
 *         owner who signs reads it.
 * DELETE  ask the owners to sign taking it back. Owners only. (The kill switch
 *         and “Ask me first” stop automatic payments at once, without waiting
 *         for signatures.)
 */
export async function POST(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const termsGate = await requireTermsAccepted(gate.route.orgId);
  if (termsGate) return termsGate;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await requestAllowance(gate.deps, gate.actor, { perPaymentUsdc: body.perPaymentUsdc, dailyUsdc: body.dailyUsdc, monthlyUsdc: body.monthlyUsdc, expiresInDays: body.expiresInDays, summaryDigest: body.summaryDigest });
  return result.ok ? NextResponse.json({ request: result.request, summary: result.summary }, { status: 201, headers: NO_STORE }) : asResponse(result);
}

export async function DELETE(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const result = await revokeAllowance(gate.deps, gate.actor);
  return result.ok ? NextResponse.json({ request: result.request }, { status: 201, headers: NO_STORE }) : asResponse(result);
}
