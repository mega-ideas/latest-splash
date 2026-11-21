import { NextResponse } from 'next/server';
import { z } from 'zod';

import { findAccount } from '@/lib/auth/accounts';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  recordFailedLogin,
} from '@/lib/auth/login-rate-limit';
import { sessionForAccount, setCustomerSessionCookie } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import {
  accountEmailForWallet,
  clearChallenge,
  isSuiAddress,
  requestHost,
  takeChallengeNonce,
  verifyWalletSignature,
  walletSignInConfigured,
} from '@/lib/server/wallet-auth';

/**
 * Sign in by proving control of a wallet.
 *
 * The signature establishes identity only. Authority still comes from the
 * account row the wallet is mapped to and its membership, exactly as it does
 * after a password login, so a wallet can never reach more than its account.
 */

const schema = z.object({
  address: z.string().trim().min(1).max(100),
  signature: z.string().trim().min(1).max(2000),
  remember: z.boolean().optional(),
});

/** One message for every failure. Which of them it was is not the caller's
 *  business, and saying would enumerate both wallets and accounts. */
const INVALID = 'That wallet cannot sign in here';
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
    return NextResponse.json({ error: 'A Sui address and signature are required' }, { status: 400, headers: NO_STORE });
  }

  if (!process.env.DATABASE_URL) {
    console.error('[auth] Refusing wallet sign-in: DATABASE_URL is not configured, so there are no accounts to check.');
    return NextResponse.json({ error: INVALID }, { status: 401, headers: NO_STORE });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;
  const ip = clientIp(request);
  const address = parsed.data.address.trim().toLowerCase();

  // Mapping is an environment lookup, not a database read, so doing it first
  // gives the limiter the same key the password path uses without revealing
  // anything: every failure below answers identically.
  const email = accountEmailForWallet(address);
  const limiterEmail = email ?? `wallet:${address}`;

  // Before the signature check, not after: a limiter consulted afterwards
  // still lets an attacker grind attempts it then declines to answer.
  const verdict = await checkLoginRateLimit(db, { email: limiterEmail, ip });
  if (!verdict.allowed) {
    return NextResponse.json(
      {
        error:
          verdict.scope === 'email'
            ? 'Too many failed attempts for this wallet. Try again shortly.'
            : 'Too many failed attempts from this network. Try again shortly.',
      },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(verdict.retryAfterSeconds) } },
    );
  }

  const nonce = await takeChallengeNonce();
  // One attempt per challenge, whatever the outcome.
  await clearChallenge();

  const fail = async () => {
    await recordFailedLogin(db, { email: limiterEmail, ip });
    return NextResponse.json({ error: INVALID }, { status: 401, headers: NO_STORE });
  };

  if (!nonce) {
    return NextResponse.json(
      { error: 'That sign-in request expired. Try again.', code: 'challenge_expired' },
      { status: 400, headers: NO_STORE },
    );
  }

  const verified = await verifyWalletSignature({
    address,
    signature: parsed.data.signature,
    nonce,
    host: requestHost(request),
  });
  if (!verified) return fail();
  if (!email) return fail();

  const account = await findAccount(db, email);
  if (!account) return fail();

  await clearLoginFailures(db, limiterEmail);

  const session = await setCustomerSessionCookie(sessionForAccount(account), {
    remember: parsed.data.remember,
  });
  return NextResponse.json({ session, wallet: address }, { headers: NO_STORE });
}
