import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { isKilledEntityEmail } from './killed-entities.ts';

/** Workspace role as stored on the DB `users` row (schema.ts `userRole`). */
export type CustomerWorkspaceRole = 'maker' | 'checker' | 'admin' | 'viewer';

const WORKSPACE_ROLES: readonly CustomerWorkspaceRole[] = ['maker', 'checker', 'admin', 'viewer'];

export type CustomerSession = {
  email: string;
  name: string;
  organization: string;
  /** Legacy display label. Kept literal so existing UI (DashboardHeader) is
   *  unchanged; it is NOT an authorization signal. */
  role: 'business_admin';
  /**
   * Real workspace role from the DB, carried for DISPLAY ONLY (wallet spec §4.1).
   *
   * Never authorize on this. The cookie payload is signed but base64 — readable
   * by the client — and Invariant #8 requires authority to be derived
   * server-side. `lib/auth/authority.ts` re-reads the role from the users table
   * on every money route; this field only lets the UI say "Approver".
   */
  userRole?: CustomerWorkspaceRole;
  /** zkLogin signer address for this human (wallet spec §2.3). Display/lookup
   *  only — the authority resolver re-derives org and role from the DB. */
  suiAddress?: string;
  orgId?: string;
  /**
   * The account's credential version at mint time (users.credential_version).
   *
   * Bumped whenever the credentials change — verification, password reset —
   * and re-read from the row on every session read. A mismatch, or a session
   * with no version at all, is treated as no session. This is how "the
   * mailbox owner verifies and every earlier session dies" is enforced.
   */
  credentialVersion?: number;
  issuedAt: string;
  expiresAt: string;
  /**
   * Server-stamped last activity, for the fifteen-minute idle timeout.
   *
   * Written by the server and covered by the cookie HMAC, so a client cannot
   * extend its own session by editing it: the value it sends back is the one
   * the server last signed. Optional because sessions minted before idle
   * tracking existed have none, and those are stamped on first use rather
   * than logged out en masse by a deploy.
   */
  lastSeenAt?: string;
};

export function isCustomerWorkspaceRole(value: unknown): value is CustomerWorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

type CustomerTokenPayload = CustomerSession & {
  nonce: string;
  iat: number;
  exp: number;
};

export const CUSTOMER_SESSION_COOKIE = 'splash_customer_session';
/* FALLBACK_CUSTOMER_EMAIL and FALLBACK_CUSTOMER_PASSWORD are gone. They were
   a working login for anyone with the source, guarded only by a NODE_ENV
   check; accounts live in the database now. */
export const FALLBACK_CUSTOMER_ORGANIZATION = 'Splash Workspace';

export function timingSafeStrEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function createCustomerSessionFromIdentity(input: {
  email: string;
  organization?: string;
  now?: Date;
  ttlSeconds?: number;
  fallbackOrganization?: string;
  userRole?: CustomerWorkspaceRole;
  suiAddress?: string;
  orgId?: string;
  credentialVersion?: number;
  lastSeenAt?: Date;
}): CustomerSession {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? 60 * 60 * 12) * 1000);
  const normalizedEmail = input.email.trim().toLowerCase();
  const localPart = normalizedEmail.split('@')[0] || 'operator';

  return {
    email: normalizedEmail,
    name: localPart.replace(/[._-]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
    organization: input.organization?.trim() || input.fallbackOrganization || FALLBACK_CUSTOMER_ORGANIZATION,
    role: 'business_admin',
    ...(input.userRole ? { userRole: input.userRole } : {}),
    ...(input.suiAddress ? { suiAddress: input.suiAddress } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(typeof input.credentialVersion === 'number' ? { credentialVersion: input.credentialVersion } : {}),
    lastSeenAt: (input.lastSeenAt ?? now).toISOString(),
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function createCustomerSessionToken(
  session: CustomerSession,
  secret: string,
  nowMs = Date.now(),
): string {
  const payload: CustomerTokenPayload = {
    ...session,
    nonce: randomBytes(12).toString('hex'),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(new Date(session.expiresAt).getTime() / 1000),
  };
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function readCustomerSessionToken(
  token: string | undefined,
  secret: string,
  nowMs = Date.now(),
): CustomerSession | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const encoded = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = signPayload(encoded, secret);
  if (!timingSafeStrEqual(mac, expected)) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(encoded)) as Partial<CustomerTokenPayload>;
    if (!payload.email || !payload.name || !payload.organization || payload.role !== 'business_admin') return null;
    if (!payload.exp || payload.exp * 1000 <= nowMs) return null;

    // Wallet spec §2.4 — enforce the killed-entity denylist at every session
    // mint, not just at signup, so a cookie issued before a domain was killed
    // stops verifying immediately instead of lingering until it expires.
    if (isKilledEntityEmail(payload.email)) return null;

    // NOTE: this reconstruction is field-by-field on purpose (never spread the
    // decoded payload — that would let a forged-but-unsigned field through).
    // Any new CustomerSession field MUST be copied here or it is silently
    // dropped even though it survived the signature check.
    return {
      email: payload.email,
      name: payload.name,
      organization: payload.organization,
      role: payload.role,
      ...(isCustomerWorkspaceRole(payload.userRole) ? { userRole: payload.userRole } : {}),
      ...(typeof payload.suiAddress === 'string' && payload.suiAddress ? { suiAddress: payload.suiAddress } : {}),
      ...(typeof payload.orgId === 'string' && payload.orgId ? { orgId: payload.orgId } : {}),
      ...(Number.isInteger(payload.credentialVersion) ? { credentialVersion: payload.credentialVersion as number } : {}),
      // The idle clock. It was missing from this list, which meant every read
      // saw "no stamp" and the fifteen-minute logout could never fire.
      ...(typeof payload.lastSeenAt === 'string' && payload.lastSeenAt ? { lastSeenAt: payload.lastSeenAt } : {}),
      issuedAt: payload.issuedAt || new Date((payload.iat ?? 0) * 1000).toISOString(),
      expiresAt: payload.expiresAt || new Date(payload.exp * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * The same session, seen now. Only `lastSeenAt` moves: the absolute expiry
 * is not a sliding window, and re-stamping the idle clock must never turn
 * it into one.
 */
export function stampLastSeen(session: CustomerSession, now = new Date()): CustomerSession {
  return { ...session, lastSeenAt: now.toISOString() };
}
