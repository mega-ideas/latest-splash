import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { z } from 'zod';

import { readJsonBody } from '@/lib/server/http';
import { INTENTS, setIntent } from '@/lib/server/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  intent: z.enum(INTENTS),
  /** Only Settings sends this; the first choice is otherwise immutable. */
  allowChange: z.boolean().optional(),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const parsed = bodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'invalid intent' }, { status: 400 });
  try {
    const result = await setIntent(auth.session, parsed.data.intent, {
      allowChange: parsed.data.allowChange ?? false,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'onboarding_unavailable' }, { status: 503 });
  }
}
