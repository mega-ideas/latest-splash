import QRCode from 'qrcode';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { FundingRegistryError, type FundingSelection } from '@/lib/funding/registry';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { createFundingSession } from '@/lib/server/funding-sessions';
import { readJsonBody } from '@/lib/server/http';
import { isForeignAccountId, requireSessionAccount } from '@/lib/server/session-account';

const usdSelectionSchema = z.object({
  source: z.literal('BANK_USD'),
  type: z.literal('fiat'),
  provider: z.enum(['STRIPE', 'AIRWALLEX']),
  feeTier: z.literal('STANDARD'),
});

const stablecoinSelectionSchema = z.object({
  source: z.enum(['USDC', 'USDSUI', 'USDT']),
  type: z.literal('stablecoin'),
  asset: z.enum(['USDC', 'USDSUI', 'USDT']),
  rail: z.enum(['SUI_NATIVE', 'CCTP']),
  sourceChain: z.enum(['ETHEREUM', 'SOLANA', 'BASE', 'ARBITRUM']).optional(),
  feeTier: z.literal('DISCOUNT'),
});

const sessionSchema = z.object({
  amountUsd: z.number().positive().max(10_000_000),
  businessAccountId: z.string().trim().min(1).optional(),
  selection: z.discriminatedUnion('type', [usdSelectionSchema, stablecoinSelectionSchema]),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const parsed = sessionSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid funding session request' }, { status: 400 });

  // The session's account decides who gets CREDITed when the deposit lands, so
  // it is resolved from the caller's org — a body-supplied value would let one
  // org credit a deposit to (and later spend it from) another org's ledger.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { accountId, orgId } = accountCheck.account;
  if (isForeignAccountId(parsed.data.businessAccountId, accountId)) {
    return NextResponse.json({ error: 'businessAccountId does not belong to this organization' }, { status: 403 });
  }

  try {
    const amountExpectedMicro = Math.round(parsed.data.amountUsd * 1_000_000);
    const session = createFundingSession({
      orgId,
      businessAccountId: accountId,
      selection: parsed.data.selection as FundingSelection,
      amountExpectedMicro,
    });
    const qrDataUrl = session.depositUri
      ? await QRCode.toDataURL(session.depositUri, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 224,
          color: { dark: '#0C3E48', light: '#F6F0ED' },
        })
      : null;
    return NextResponse.json({
      session,
      qrDataUrl,
      demoMode: process.env.NODE_ENV !== 'production' || process.env.USE_MOCK_APIS === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Funding session could not be created';
    return NextResponse.json(
      { error: message },
      { status: error instanceof FundingRegistryError ? 400 : 503 },
    );
  }
}
