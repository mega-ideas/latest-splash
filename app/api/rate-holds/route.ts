import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getCorridorFeeBps } from '@/lib/fx/corridors';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { createRateHold, listRateHoldsFor, readRateHoldFor } from '@/lib/server/operations';
import { requireSessionAccount } from '@/lib/server/session-account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  corridorCurrency: z.string().trim().length(3),
  rate: z.coerce.number().positive(),
});

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // A rate hold is a commitment made to one customer, and a list of them is
  // a read of that customer's corridor positions and timing. Both were
  // returned to anyone signed in.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { orgId } = accountCheck.account;

  const holdId = new URL(request.url).searchParams.get('id');
  if (holdId) {
    const hold = readRateHoldFor(orgId, holdId);
    return hold
      ? NextResponse.json(hold)
      : NextResponse.json({ error: 'Rate hold not found' }, { status: 404 });
  }
  return NextResponse.json({ items: listRateHoldsFor(orgId) });
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const parsed = createSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A valid corridor and rate are required' }, { status: 400 });
  }
  const corridorCurrency = parsed.data.corridorCurrency.toUpperCase();
  const hold = createRateHold({
    orgId: accountCheck.account.orgId,
    corridorCurrency,
    rate: String(parsed.data.rate),
    feeBps: getCorridorFeeBps(corridorCurrency),
  });
  return NextResponse.json(hold, { status: 201 });
}
