import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Server-side zkLogin JWT verification (wallet spec §4.1, threat T1).
 *
 * This is the half that must never live in the browser. The client runs the
 * OAuth → ephemeral-key → ZK-proof dance; the server independently proves the
 * token is real and is *for us* before any session is minted.
 *
 * Directly implements the IACR 2026/227 mitigations:
 *   (i)   strict, canonical JWT parsing — exactly three base64url segments,
 *         no padding, no stray characters, claims read by explicit typed
 *         extraction (never spread), so a malformed or duplicate-key token
 *         cannot smuggle a field through;
 *   (ii)  a short-lived auth token is NOT treated as durable authorization —
 *         `iss` is allowlisted, `aud` must equal OUR client id for THIS
 *         environment, `sub` must be present, `exp`/`iat` must be fresh, and
 *         the `nonce` must bind the ephemeral key the client claims to hold;
 *   (iii) a separate OAuth client per environment, enforced by the `aud` check.
 *
 * Deliberately dependency-free beyond node:crypto and the already-installed
 * @mysten/sui — no new packages, matching the crypto style already used in
 * admin-auth.ts and funding-sessions.ts.
 *
 * REMEMBER: verifying this JWT authenticates *who is logged in*. It NEVER
 * authorizes money movement — that requires the payer's own signature over
 * real Coin<T> plus the policy engine (spec §4.2).
 */

export type ZkLoginProvider = 'google' | 'microsoft';

export type ZkLoginClaims = {
  iss: string;
  sub: string;
  aud: string;
  email?: string;
  /** True only when the token carries the boolean claim `email_verified: true`.
   *  Absent, false, or the string "true" are all false: the account is not
   *  marked verified on a guess. */
  emailVerified: boolean;
  nonce?: string;
  exp: number;
  iat: number;
};

export class ZkLoginVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ZkLoginVerificationError';
    this.code = code;
  }
}

/** Issuer allowlist. Google publishes two spellings; Microsoft is per-tenant. */
const ISSUER_PATTERNS: Record<ZkLoginProvider, RegExp[]> = {
  google: [/^https:\/\/accounts\.google\.com$/, /^accounts\.google\.com$/],
  microsoft: [/^https:\/\/login\.microsoftonline\.com\/[0-9a-fA-F-]+\/v2\.0$/],
};

const JWKS_URI: Record<ZkLoginProvider, string> = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  // `common` validates tokens from any tenant (Workspace-equivalent 365 orgs).
  microsoft: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
};

export function zkLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEATURE_ZKLOGIN === 'true';
}

/** Our OAuth client id for THIS environment — the cross-app impersonation guard. */
export function expectedAudience(provider: ZkLoginProvider, env: NodeJS.ProcessEnv = process.env): string {
  const key = provider === 'google' ? 'ZKLOGIN_GOOGLE_CLIENT_ID' : 'ZKLOGIN_MICROSOFT_CLIENT_ID';
  return (env[key] ?? '').trim();
}

// ── Strict JWT decoding ─────────────────────────────────────────────────────

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string, what: string): unknown {
  // Canonical base64url only: no '=' padding, no '+' or '/', nothing exotic.
  if (!BASE64URL_SEGMENT.test(segment)) {
    throw new ZkLoginVerificationError('malformed_token', `${what} is not canonical base64url`);
  }
  let json: string;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new ZkLoginVerificationError('malformed_token', `${what} could not be decoded`);
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new ZkLoginVerificationError('malformed_token', `${what} is not valid JSON`);
  }
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ZkLoginVerificationError('missing_claim', `${key} claim is missing or not a string`);
  }
  return value;
}

function requireNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ZkLoginVerificationError('missing_claim', `${key} claim is missing or not a number`);
  }
  return value;
}

/**
 * The OIDC `email_verified` claim, read strictly. Google sends a boolean;
 * Microsoft does not send it at all; nobody's string "true" counts. This is
 * what decides whether a zkLogin sign-in marks the mailbox proven — the same
 * fact a delivered link proves — so it must not be inferred.
 */
export function readEmailVerifiedClaim(payload: Record<string, unknown>): boolean {
  return payload.email_verified === true;
}

// ── JWKS ────────────────────────────────────────────────────────────────────

type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string };

const jwksCache = new Map<ZkLoginProvider, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 10 * 60 * 1000;

async function fetchJwks(provider: ZkLoginProvider): Promise<Jwk[]> {
  const cached = jwksCache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const response = await fetch(JWKS_URI[provider], { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new ZkLoginVerificationError('jwks_unavailable', `${provider} JWKS returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) {
    throw new ZkLoginVerificationError('jwks_unavailable', `${provider} JWKS contained no keys`);
  }
  jwksCache.set(provider, { keys, fetchedAt: Date.now() });
  return keys;
}

/** Test seam — lets the suite inject a key set without network access. */
export function primeJwksCacheForTesting(provider: ZkLoginProvider, keys: Jwk[]): void {
  jwksCache.set(provider, { keys, fetchedAt: Date.now() });
}

export function clearJwksCacheForTesting(): void {
  jwksCache.clear();
}

// ── Verification ────────────────────────────────────────────────────────────

export type VerifyZkLoginInput = {
  jwt: string;
  provider: ZkLoginProvider;
  /** Expected nonce, recomputed by the caller from the ephemeral key the client
   *  presented (see `expectedNonce`). Omit only when nonce binding is not in
   *  use — which weakens mitigation (ii), so callers should always pass it. */
  expectedNonce?: string;
  now?: Date;
  /** Allowed clock skew for exp/iat, seconds. */
  skewSeconds?: number;
  env?: NodeJS.ProcessEnv;
};

export async function verifyZkLoginJwt(input: VerifyZkLoginInput): Promise<ZkLoginClaims> {
  const env = input.env ?? process.env;
  const nowMs = (input.now ?? new Date()).getTime();
  const skew = input.skewSeconds ?? 60;

  const segments = input.jwt.split('.');
  if (segments.length !== 3) {
    throw new ZkLoginVerificationError('malformed_token', 'JWT must have exactly three segments');
  }
  const [headerSeg, payloadSeg, signatureSeg] = segments;

  const header = decodeSegment(headerSeg, 'header') as Record<string, unknown>;
  const payload = decodeSegment(payloadSeg, 'payload') as Record<string, unknown>;
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    throw new ZkLoginVerificationError('malformed_token', 'header and payload must be JSON objects');
  }

  // Only RS256. Refusing to read `alg` loosely is what blocks alg-confusion.
  if (header.alg !== 'RS256') {
    throw new ZkLoginVerificationError('bad_algorithm', `unsupported alg ${String(header.alg)}; only RS256 is accepted`);
  }
  if (!BASE64URL_SEGMENT.test(signatureSeg)) {
    throw new ZkLoginVerificationError('malformed_token', 'signature is not canonical base64url');
  }

  // ── signature ──
  const keys = await fetchJwks(input.provider);
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const candidates = kid ? keys.filter((key) => key.kid === kid) : keys;
  if (candidates.length === 0) {
    throw new ZkLoginVerificationError('unknown_key', `no JWKS key matched kid ${kid || '(none)'}`);
  }

  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8');
  const signature = Buffer.from(signatureSeg, 'base64url');
  const signatureValid = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      return cryptoVerify('RSA-SHA256', signingInput, key, signature);
    } catch {
      return false;
    }
  });
  if (!signatureValid) {
    throw new ZkLoginVerificationError('bad_signature', 'JWT signature did not verify against the provider JWKS');
  }

  // ── claims (all checked AFTER the signature, never before) ──
  const iss = requireString(payload, 'iss');
  if (!ISSUER_PATTERNS[input.provider].some((pattern) => pattern.test(iss))) {
    throw new ZkLoginVerificationError('bad_issuer', `issuer ${iss} is not allowlisted for ${input.provider}`);
  }

  const sub = requireString(payload, 'sub');
  const aud = requireString(payload, 'aud');
  const expectedAud = expectedAudience(input.provider, env);
  if (!expectedAud) {
    throw new ZkLoginVerificationError('not_configured', `no OAuth client id configured for ${input.provider}`);
  }
  if (aud !== expectedAud) {
    // The cross-app impersonation guard — a token minted for another app is
    // cryptographically valid and still must be refused.
    throw new ZkLoginVerificationError('bad_audience', 'token audience does not match this environment');
  }

  const exp = requireNumber(payload, 'exp');
  if (exp * 1000 + skew * 1000 <= nowMs) {
    throw new ZkLoginVerificationError('expired', 'token has expired');
  }
  const iat = requireNumber(payload, 'iat');
  if (iat * 1000 - skew * 1000 > nowMs) {
    throw new ZkLoginVerificationError('not_yet_valid', 'token was issued in the future');
  }

  const nonce = typeof payload.nonce === 'string' ? payload.nonce : undefined;
  if (input.expectedNonce !== undefined) {
    if (!nonce || nonce !== input.expectedNonce) {
      // Without this the token is a bearer credential detached from the key
      // that will actually sign — the core IACR (ii) failure.
      throw new ZkLoginVerificationError('bad_nonce', 'token nonce does not bind the presented ephemeral key');
    }
  }

  return {
    iss,
    sub,
    aud,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: readEmailVerifiedClaim(payload),
    nonce,
    exp,
    iat,
  };
}

/**
 * Recompute the nonce the provider should have echoed, from the ephemeral key
 * material the client presented. Uses the already-installed Mysten SDK so the
 * derivation matches zkLogin exactly.
 */
export async function expectedNonce(input: {
  ephemeralPublicKeyB64: string;
  maxEpoch: number;
  randomness: string;
}): Promise<string> {
  const [{ generateNonce }, { Ed25519PublicKey }] = await Promise.all([
    import('@mysten/sui/zklogin'),
    import('@mysten/sui/keypairs/ed25519'),
  ]);
  const publicKey = new Ed25519PublicKey(Buffer.from(input.ephemeralPublicKeyB64, 'base64'));
  return generateNonce(publicKey, input.maxEpoch, input.randomness);
}

/**
 * Derive the user's zkLogin Sui address from a verified JWT plus their salt.
 *
 * `legacyAddress: false` — the current derivation. Never flip this once
 * addresses are persisted in `wallet_identities`: the same identity would
 * derive a different address and orphan the row.
 */
export async function deriveZkLoginAddress(jwt: string, userSalt: string): Promise<string> {
  const { jwtToAddress } = await import('@mysten/sui/zklogin');
  return jwtToAddress(jwt, userSalt, false);
}

/** Never log `sub` raw — it is a provider user id (PII). */
export function hashSubjectForLog(iss: string, sub: string, aud: string): string {
  return createHash('sha256').update(`${iss}|${sub}|${aud}`).digest('hex').slice(0, 16);
}
