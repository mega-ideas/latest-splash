import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  assertFundingWebhookSecret,
  ingestStablecoinDeposit,
} from '@/lib/server/funding-intake';
import { readJsonBody } from '@/lib/server/http';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';

const depositSchema = z.object({
  sessionId: z.string().trim().min(1),
  sourceTxDigest: z.string().trim().min(4),
  receivedCoinType: z.string().trim().min(1),
  destinationCoinType: z.string().trim().min(1).optional(),
  amountMicro: z.number().int().positive(),
  sourceType: z.enum(['regulated_vasp', 'self_custody']),
  riskScore: z.number().min(0).max(100),
  sanctionsMatch: z.boolean().optional(),
  travelRuleOriginatorCaptured: z.boolean().optional(),
  sourceOfFundsTraced: z.boolean().optional(),
  cctpMessageStatus: z.enum(['pending', 'minted']).optional(),
});

export async function POST(request: Request) {
  try {
    assertFundingWebhookSecret(request.headers.get('x-funding-webhook-secret'));
    const outOfScope = refuseOutsideLaunchScope();
    if (outOfScope) return outOfScope;
    const parsed = depositSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid deposit event' }, { status: 400 });
    const session = await ingestStablecoinDeposit(parsed.data);
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Deposit event could not be processed' },
      { status: 400 },
    );
  }
}
