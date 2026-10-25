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
  /**
   * The registered address in its parts (ISO 20022 structured; the country is
   * addressCountry). A supplier payout's originator needs it; the service
   * checks each part as the payout message reads it.
   */
  address: z
    .object({
      streetName: z.string().max(70).optional(),
      buildingName: z.string().max(35).optional(),
      postCode: z.string().max(16).optional(),
      townName: z.string().trim().min(1).max(35),
      countrySubDivision: z.string().max(35).optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const parsed = bodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'invalid profile' }, { status: 400 });
  let result;
  try {
    // The role is read from the membership (owners only), never from the request.
    result = await saveBusinessProfile(auth.session, parsed.data);
  } catch {
    return NextResponse.json({ error: 'onboarding_unavailable' }, { status: 503 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, ...(result.field ? { field: result.field } : {}) }, { status: result.status });
  return NextResponse.json({ ok: true, legalNameChanged: result.legalNameChanged, destinationsRevoked: result.destinationsRevoked });
}
