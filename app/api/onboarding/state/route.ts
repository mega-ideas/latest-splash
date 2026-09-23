import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readOnboardingState } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The derived setup state — computed fresh, never stored (see lib/server/onboarding.ts). */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  try {
    return NextResponse.json(await readOnboardingState(auth.session));
  } catch {
    // No database on this machine, or no membership: the setup screen renders
    // its unavailable state rather than a dead 500.
    return NextResponse.json({ error: 'onboarding_unavailable' }, { status: 503 });
  }
}
