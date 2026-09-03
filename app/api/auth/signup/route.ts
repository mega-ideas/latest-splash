import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createSignupSession, setCustomerSessionCookie } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { emitEvent } from '@/lib/server/events';

const signupSchema = z.object({
  company: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  region: z.string().trim().min(2).max(80),
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/\d/),
  accepted: z.literal(true),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production' && process.env.CUSTOMER_SELF_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'Business workspaces are provisioned by Splash in production' },
      { status: 403 },
    );
  }

  const parsed = signupSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'A valid company, business email, strong password, and acceptance are required' },
      { status: 400 },
    );
  }

  const session = createSignupSession({
    email: parsed.data.email,
    organization: parsed.data.company,
  });
  const refreshedSession = await setCustomerSessionCookie(session, { remember: true });
  void emitEvent({
    name: 'account_created',
    orgId: refreshedSession.orgId ?? refreshedSession.email,
    actorId: refreshedSession.email,
    props: { region: parsed.data.region, selfSignup: true },
  });

  return NextResponse.json(
    {
      session: refreshedSession,
      region: parsed.data.region,
    },
    { status: 201 },
  );
}
