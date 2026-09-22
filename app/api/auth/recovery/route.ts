import { NextResponse } from 'next/server';
import { z } from 'zod';

import { BRAND } from '@/content/brand';
import { readJsonBody } from '@/lib/server/http';

const recoverySchema = z.object({
  email: z.string().trim().email(),
});

function recoveryContact() {
  return (
    process.env.CUSTOMER_RECOVERY_EMAIL ||
    BRAND.supportEmail
  ).trim();
}

export async function POST(request: Request) {
  const parsed = recoverySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid business email address', code: 'invalid_recovery_email' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    {
      message:
        'For treasury safety, workspace recovery is handled by verified support. Contact support from your business email and include your company name.',
      recoveryEmail: recoveryContact(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
