import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

import { resolveSessionSecret } from '@/lib/server/customer-auth';

export const WALLET_CHALLENGE_COOKIE = 'splash_wallet_challenge';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Which wallets may sign in, and as whom.
 *
 * A signature proves control of an address and nothing more. Authority here
 * still comes from an account row and its membership, so a wallet is mapped
 * to an existing account rather than standing in for one. The mapping lives
 * in the environment, which keeps it out of the database and makes revoking a
 * wallet a config change rather than a migration.
 *
 *   CUSTOMER_WALLETS="0xabc…=ops@acme.com,0xdef…=cfo@acme.com"
 */
export function walletMap(): Map<string, string> {
  const entries = String(process.env.CUSTOMER_WALLETS ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [address, email] = pair.split('=').map((part) => part?.trim().toLowerCase() ?? '');
      return [address, email] as const;
    })
    .filter(([address, email]) => /^0x[0-9a-f]{64}$/.test(address) && email.includes('@'));
  return new Map(entries);
}

export function walletSignInConfigured(): boolean {
  return walletMap().size > 0;
}

/** The account a wallet signs in as, or null if it is not mapped. */
export function accountEmailForWallet(address: string): string | null {
  return walletMap().get(address.trim().toLowerCase()) ?? null;
}

export const isSuiAddress = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value.trim());

/**
 * The exact text a wallet is asked to sign.
 *
 * Built on the server at both ends and never taken from the client: the nonce
 * ties it to one attempt, the address stops a signature being replayed for a
 * different wallet, and the host stops one made for another site being reused
 * here.
 */
export function challengeMessage(input: { nonce: string; address: string; host: string }): string {
  return [
    'Splash Finance',
    '',
    `Sign in to ${input.host}`,
    `Wallet: ${input.address.trim().toLowerCase()}`,
    `Nonce: ${input.nonce}`,
    '',
    'Signing costs nothing and authorises no transaction.',
  ].join('\n');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** A nonce carried in a short-lived signed cookie, so no store is needed. */
export async function issueChallenge(): Promise<{ nonce: string } | null> {
  const secret = resolveSessionSecret();
  if (!secret) return null;

  const nonce = randomBytes(24).toString('hex');
  const payload = `${nonce}.${Date.now()}`;
  const cookieStore = await cookies();
  cookieStore.set(WALLET_CHALLENGE_COOKIE, `${payload}.${sign(payload, secret)}`, {
    httpOnly: true,
    maxAge: Math.floor(CHALLENGE_TTL_MS / 1000),
    path: '/',
    sameSite: 'lax',
    secure: isProduction,
  });
  return { nonce };
}

/** Reads the pending nonce, rejecting anything tampered with or stale. */
export async function takeChallengeNonce(): Promise<string | null> {
  const secret = resolveSessionSecret();
  if (!secret) return null;

  const cookieStore = await cookies();
  const raw = cookieStore.get(WALLET_CHALLENGE_COOKIE)?.value;
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [nonce, issuedAt, mac] = parts;

  const expected = sign(`${nonce}.${issuedAt}`, secret);
  const given = Buffer.from(mac, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > CHALLENGE_TTL_MS) return null;

  return nonce;
}

/** A challenge is good for one attempt, successful or not. */
export async function clearChallenge() {
  const cookieStore = await cookies();
  cookieStore.delete(WALLET_CHALLENGE_COOKIE);
}

export function requestHost(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_HOST?.trim();
  if (configured) return configured;
  try {
    return new URL(request.url).host;
  } catch {
    return 'splashz.xyz';
  }
}

/**
 * True only when the signature is this address's, over exactly the message the
 * server would have issued. The message is rebuilt here rather than trusted.
 */
export async function verifyWalletSignature(input: {
  address: string;
  signature: string;
  nonce: string;
  host: string;
}): Promise<boolean> {
  const message = challengeMessage({ nonce: input.nonce, address: input.address, host: input.host });
  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(message), input.signature, {
      address: input.address.trim().toLowerCase(),
    });
    return true;
  } catch {
    return false;
  }
}
