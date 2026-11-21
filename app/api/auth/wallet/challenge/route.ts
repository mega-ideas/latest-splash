import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readJsonBody } from '@/lib/server/http';
import {
  challengeMessage,
  isSuiAddress,
  issueChallenge,
  requestHost,
  walletSignInConfigured,
} from '@/lib/server/wallet-auth';

const schema = z.object({ address: z.string().trim() });

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  if (!walletSignInConfigured()) {
    return NextResponse.json(
      { error: 'Wallet sign-in is not enabled', code: 'wallet_signin_disabled' },
      { status: 404, headers: NO_STORE },
    );
  }

  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success || !isSuiAddress(parsed.data.address)) {
    return NextResponse.json({ error: 'A Sui address is required' }, { status: 400, headers: NO_STORE });
  }

  const issued = await issueChallenge();
  if (!issued) {
    return NextResponse.json(
      { error: 'Wallet sign-in is unavailable', code: 'session_secret_missing' },
      { status: 503, headers: NO_STORE },
    );
  }

  // The wallet signs exactly this. The nonce stays in an httpOnly cookie, so a
  // challenge cannot be minted in one browser and answered from another.
  return NextResponse.json(
    {
      message: challengeMessage({
        nonce: issued.nonce,
        address: parsed.data.address,
        host: requestHost(request),
      }),
    },
    { headers: NO_STORE },
  );
}
