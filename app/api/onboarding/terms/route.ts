import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { acceptTerms } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step 1. Idempotent: accepting twice writes nothing new. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  try {
    await acceptTerms(auth.session);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'onboarding_unavailable' }, { status: 503 });
  }
}
