import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { sealAdapter } from '@/lib/server/seal';

const schema = z.object({ policyId: z.string().min(1), identity: z.string().min(1) });

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // An access decision is a key-server round trip: bounded per network.
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.sealAccessIp, key: clientIp(request) });
  if (limited) return limited;

  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'policyId and identity are required' }, { status: 400 });
  return NextResponse.json({ granted: await sealAdapter.canDecrypt(parsed.data.policyId, parsed.data.identity) });
}
