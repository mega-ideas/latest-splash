import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  assertFundingWebhookSecret,
  confirmUsdProviderDeposit,
} from '@/lib/server/funding-intake';
import { readJsonBody } from '@/lib/server/http';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';

const usdDepositSchema = z.object({
  sessionId: z.string().trim().min(1),
  provider: z.enum(['STRIPE', 'AIRWALLEX']),
  providerReference: z.string().trim().min(4),
  amountMicro: z.number().int().positive(),
});

export async function POST(request: Request) {
  try {
    assertFundingWebhookSecret(request.headers.get('x-funding-webhook-secret'));
    const outOfScope = refuseOutsideLaunchScope();
    if (outOfScope) return outOfScope;
    const parsed = usdDepositSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid USD deposit event' }, { status: 400 });
    return NextResponse.json({ session: confirmUsdProviderDeposit(parsed.data) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'USD deposit event could not be processed' },
      { status: 400 },
    );
  }
}
