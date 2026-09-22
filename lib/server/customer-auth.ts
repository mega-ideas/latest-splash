import { evaluateIdle } from '@/lib/auth/idle-timeout';
import 'server-only';

import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { customerRequestOriginAllowed } from '@/lib/auth/customer-request';
import { sessionCredentialIsCurrent } from '@/lib/auth/accounts';
import { isKilledEntityEmail } from '@/lib/auth/killed-entities';
import {
  CUSTOMER_SESSION_COOKIE,
  FALLBACK_CUSTOMER_ORGANIZATION,
  createCustomerSessionFromIdentity,
  createCustomerSessionToken,
  readCustomerSessionToken,
  type CustomerSession,
  type CustomerWorkspaceRole,
} from '@/lib/auth/customer-session';

export type { CustomerSession } from '@/lib/auth/customer-session';
export { CUSTOMER_SESSION_COOKIE, createCustomerSessionToken, readCustomerSessionToken } from '@/lib/auth/customer-session';

const isProduction = process.env.NODE_ENV === 'production';
const DEV_SECRET_FILE = join(process.cwd(), '.customer-session-secret.local');
const defaultSessionTtlSeconds = 60 * 60 * 12;
const rememberedSessionTtlSeconds = 60 * 60 * 24 * 30;

let cachedDevSecret: string | null = null;

function resolveSecret(): string | null {
  const configured = process.env.CUSTOMER_SESSION_SECRET?.trim();
  if (configured) return configured;

  if (isProduction) return null;

  if (!cachedDevSecret) cachedDevSecret = loadOrCreateDevSecret();
  return cachedDevSecret;
}

function loadOrCreateDevSecret(): string {
  try {
    if (existsSync(DEV_SECRET_FILE)) {
      const existing = readFileSync(DEV_SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch {
    // Fall through and regenerate.
  }

  const secret = randomBytes(32).toString('hex');
  try {
    writeFileSync(DEV_SECRET_FILE, secret, { flag: 'wx', mode: 0o600 });
    console.warn(
      '[customer-auth] CUSTOMER_SESSION_SECRET is not set. Generated a local dev ' +
        'secret at .customer-session-secret.local (gitignored). Set CUSTOMER_SESSION_SECRET before deploying.',
    );
    return secret;
  } catch {
    try {
      const existing = readFileSync(DEV_SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch {
      // Last resort: keep this process working in local development.
    }
    return secret;
  }
}

function sessionFromIdentity(input: {
  email: string;
  organization?: string;
  now?: Date;
  ttlSeconds?: number;
  userRole?: CustomerWorkspaceRole;
  suiAddress?: string;
  orgId?: string;
  credentialVersion?: number;
}): CustomerSession {
  return createCustomerSessionFromIdentity({
    ...input,
    fallbackOrganization: process.env.CUSTOMER_ORGANIZATION || FALLBACK_CUSTOMER_ORGANIZATION,
  });
}

/**
 * A session for an account whose password has already been verified against
 * the database by lib/auth/accounts.ts.
 *
 * This replaces two functions.
 *
 * `validateCustomerCredentials` compared the submitted pair against
 * CUSTOMER_EMAIL / CUSTOMER_PASSWORD: one plaintext credential for the whole
 * deployment, so whoever held the .env file was the user, and there was no
 * way to have two of them.
 *
 * `createSignupSession` minted a valid session from any email with no
 * verification at all — the entry point of the approval bypass.
 *
 * A session proves identity. It carries no role: authority is read from a
 * membership row on every request, so a session cannot be a stale grant.
 */
export function sessionForAccount(account: { email: string; name?: string; credentialVersion: number }): CustomerSession {
  const email = account.email.trim().toLowerCase();

  // Wallet spec §2.4 — a killed entity must not bind in through the auth layer.
  if (isKilledEntityEmail(email)) {
    throw new Error('killed-entity domain');
  }

  // The version is what lets a verification or a reset end this session
  // from the server side; a session minted without one is refused on read.
  return sessionFromIdentity({ email, credentialVersion: account.credentialVersion });
}

/**
 * The current session, or null.
 *
 * Enforces the fifteen-minute idle timeout on read. A session past it is
 * treated as absent rather than refreshed: the point of an idle window is
 * that an unattended browser stops being authenticated, and reading a
 * session is exactly the moment to decide that.
 *
 * Re-stamping happens in setCustomerSessionCookie on the routes that write a
 * response. A read alone does not extend the window, so a page that only
 * polls cannot keep an abandoned session alive forever.
 */
export async function getCustomerSession(): Promise<CustomerSession | null> {
  const secret = resolveSecret();
  if (!secret) return null;

  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_SESSION_COOKIE)?.value;
  const session = readCustomerSessionToken(token, secret);
  if (!session) return null;

  const lastSeen = session.lastSeenAt ? Date.parse(session.lastSeenAt) : undefined;
  const verdict = evaluateIdle(Number.isNaN(lastSeen as number) ? undefined : lastSeen);
  if (verdict.state === 'expired') return null;

  // The session must have been minted under the account's current
  // credentials. Verification and password reset bump the row's version, so
  // a cookie an attacker held before the mailbox owner verified stops
  // reading as a session at that moment — no session table, nothing to
  // sweep. Without a database there is no row to compare against; the
  // password route refuses to mint in that state, and a zkLogin session is
  // accepted as-is because there is nothing it could be checked against.
  if (process.env.DATABASE_URL) {
    const { getDb } = await import('@/lib/db/client');
    const current = await sessionCredentialIsCurrent(getDb() as never, session);
    if (!current) return null;
  }

  return session;
}

export async function requireCustomerSession(): Promise<
  { session: CustomerSession; response: null } | { session: null; response: NextResponse }
> {
  const session = await getCustomerSession();
  return session ? { session, response: null } : { session: null, response: customerAuthRequiredResponse() };
}

export async function requireCustomerRequest(request: Request): Promise<
  { session: CustomerSession; response: null } | { session: null; response: NextResponse }
> {
  const auth = await requireCustomerSession();
  if (auth.response) return auth;

  if (!customerRequestOriginAllowed(request)) {
    return {
      session: null,
      response: NextResponse.json(
        { error: 'Request origin is not allowed', code: 'invalid_request_origin' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      ),
    };
  }

  return auth;
}

export async function setCustomerSessionCookie(
  session: CustomerSession,
  options: { remember?: boolean; secure?: boolean } = {},
) {
  const secret = resolveSecret();
  if (!secret) {
    throw new Error('Cannot create customer session: CUSTOMER_SESSION_SECRET is not configured.');
  }

  const maxAge = options.remember ? rememberedSessionTtlSeconds : defaultSessionTtlSeconds;
  // Rebuild only to refresh issuedAt/expiresAt — every other field must be
  // threaded through, or it is silently lost on re-issue (which is how a
  // session quietly reverts to a stale role/address).
  const refreshedSession = sessionFromIdentity({
    email: session.email,
    organization: session.organization,
    ttlSeconds: maxAge,
    userRole: session.userRole,
    suiAddress: session.suiAddress,
    orgId: session.orgId,
    credentialVersion: session.credentialVersion,
  });
  const cookieStore = await cookies();

  cookieStore.set(CUSTOMER_SESSION_COOKIE, createCustomerSessionToken(refreshedSession, secret), {
    httpOnly: true,
    maxAge,
    path: '/',
    sameSite: 'lax',
    secure: options.secure ?? isProduction,
  });

  return refreshedSession;
}

export async function clearCustomerSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(CUSTOMER_SESSION_COOKIE);
}

export function customerAuthRequiredResponse() {
  return NextResponse.json(
    { error: 'Business authentication required', code: 'customer_auth_required' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}
