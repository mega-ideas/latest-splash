import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { z } from 'zod';

import { readJsonBody } from '@/lib/server/http';
import { saveBusinessProfile } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  legalName: z.string().trim().min(2).max(160),
  /** SSM, UEN, ACRA, DTI, NPWP — whatever identifier the business normally has. */
  registrationNumber: z.string().trim().min(2).max(64),
  /** ISO 3166-1 alpha-2. */
  addressCountry: z.string().trim().length(2),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const parsed = bodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'invalid profile' }, { status: 400 });
  try {
    await saveBusinessProfile(auth.session, parsed.data);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'onboarding_unavailable' }, { status: 503 });
  }
}
