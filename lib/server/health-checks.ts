/**
 * The health checks, once. GET /api/health and `npm run doctor` both call
 * these — one implementation of "is X healthy", so the endpoint an operator
 * curls and the table a developer reads can never disagree about the same
 * machine.
 *
 * Every check returns a Check: ok, a one-line detail, and never a secret.
 * DATABASE_URL is reported as its host; keys are reported as present or not.
 * Each network probe is bounded by a timeout so a dead dependency shows as
 * `ok: false` in a few seconds rather than hanging the page.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { getEnv } from '@/lib/env';
import { checkFeeAddress, checkLaneNode, checkPasskeyDomain, checkPeg, checkScreening, checkTwilio, checkUsdyPrice } from '@/lib/server/go-live-checks';
import { getSealHealthSnapshot } from '@/lib/server/seal-health';
import { getSealConfig } from '@/lib/server/seal-config';
import { suiClient, SPLASH_PACKAGE_ID, SUI_NETWORK, SUI_RPC_URL } from '@/lib/sui';

export type Check = {
  ok: boolean;
  /** 'skipped' when the thing is deliberately not configured in this
   *  environment. Invariant: ok === (status !== 'fail'), so a consumer
   *  reading either field reaches the same conclusion. */
  status: 'ok' | 'fail' | 'skipped';
  detail: string;
  latencyMs?: number;
  data?: Record<string, unknown>;
};

const TIMEOUT_MS = 6_000;

async function timed<T>(label: string, run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await Promise.race([
    run(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
  ]);
  return { value, ms: Date.now() - started };
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ── Sui RPC ──────────────────────────────────────────────────────────── */

export async function checkRpc(): Promise<Check> {
  const host = (() => { try { return new URL(SUI_RPC_URL).host; } catch { return SUI_RPC_URL; } })();
  try {
    const { value, ms } = await timed('Sui RPC', () => suiClient.getReferenceGasPrice());
    const price = (value as { referenceGasPrice?: unknown }).referenceGasPrice ?? value;
    return { ok: true, status: 'ok', detail: `${SUI_NETWORK} via ${host} — reference gas price ${String(price)}`, latencyMs: ms, data: { network: SUI_NETWORK, host } };
  } catch (e) {
    return { ok: false, status: 'fail', detail: `${SUI_NETWORK} via ${host} — ${reason(e)}`, data: { network: SUI_NETWORK, host } };
  }
}

/* ── Published package ────────────────────────────────────────────────── */

export async function checkPackage(): Promise<Check> {
  if (!SPLASH_PACKAGE_ID) {
    return { ok: false, status: 'fail', detail: 'SPLASH_PACKAGE_ID is not set — nothing can be composed against 0x0' };
  }
  try {
    // The same call lib/server/sui-settlement.ts makes for on-chain objects.
    const { value, ms } = await timed('package lookup', () =>
      suiClient.getObject({ objectId: SPLASH_PACKAGE_ID, include: { json: true } }),
    );
    const object = (value as { object?: { objectId?: string; version?: unknown } }).object;
    if (!object) return { ok: false, status: 'fail', detail: `${SPLASH_PACKAGE_ID} did not resolve on ${SUI_NETWORK}` };
    return { ok: true, status: 'ok', detail: `${SPLASH_PACKAGE_ID} resolves on ${SUI_NETWORK}`, latencyMs: ms, data: { packageId: SPLASH_PACKAGE_ID } };
  } catch (e) {
    return { ok: false, status: 'fail', detail: `${SPLASH_PACKAGE_ID} on ${SUI_NETWORK} — ${reason(e)}` };
  }
}

/* ── Postgres ─────────────────────────────────────────────────────────── */

function migrationFilesOnDisk(): number {
  try {
    return readdirSync(path.join(process.cwd(), 'drizzle')).filter((f) => f.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

export async function checkDb(): Promise<Check> {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    return { ok: true, status: 'skipped', detail: 'DATABASE_URL not set — authority and persistence fall back to local demo state' };
  }
  const host = (() => { try { return new URL(env.DATABASE_URL).host; } catch { return '(unparseable url)'; } })();
  try {
    const { getDb } = await import('@/lib/db/client');
    const { sql } = await import('drizzle-orm');
    const db = getDb();
    const { ms } = await timed('SELECT 1', () => db.execute(sql`select 1`));

    // drizzle-kit's default journal table. Applied rows vs .sql files on disk
    // is what "migrated" means; a fresh cluster has the table missing.
    const onDisk = migrationFilesOnDisk();
    let applied = -1;
    try {
      const rows = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      const shape = rows as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const first = Array.isArray(shape) ? shape[0] : shape.rows?.[0];
      applied = Number(first?.n ?? -1);
    } catch {
      applied = 0;
    }
    const migrated = onDisk > 0 && applied >= onDisk;
    return {
      ok: migrated,
      status: migrated ? 'ok' : 'fail',
      detail: migrated
        ? `${host} reachable, ${applied}/${onDisk} migrations applied`
        : `${host} reachable, but ${applied}/${onDisk} migrations applied — run npm run db:migrate`,
      latencyMs: ms,
      data: { host, applied, onDisk },
    };
  } catch (e) {
    return { ok: false, status: 'fail', detail: `${host} — ${reason(e)}`, data: { host } };
  }
}

/* ── Seal ─────────────────────────────────────────────────────────────── */

export async function checkSeal(): Promise<Check> {
  let source = '';
  try {
    const config = getSealConfig();
    source = config.source;
    const snapshot = getSealHealthSnapshot();
    const data = {
      source,
      configured: config.configured,
      mode: config.mode,
      threshold: config.threshold,
      servers: config.serverConfigs.length,
      status: snapshot.status,
      reachableWeight: snapshot.reachableWeight,
      configuredWeight: snapshot.configuredWeight,
    };
    if (!config.configured) {
      const prod = getEnv().NODE_ENV === 'production';
      return { ok: !prod, status: prod ? 'fail' : 'skipped', detail: `${source} — unconfigured (no committee); ${prod ? 'production fails closed' : 'development uses demo records'}`, data };
    }
    const ok = snapshot.status === 'healthy';
    return {
      ok,
      status: ok ? 'ok' : 'fail',
      detail: `${source} — ${config.serverConfigs.length} servers, threshold ${config.threshold}, ${snapshot.status} (${snapshot.reachableWeight}/${snapshot.configuredWeight} weight reachable)${snapshot.reason ? ` — ${snapshot.reason}` : ''}`,
      data,
    };
  } catch (e) {
    return { ok: false, status: 'fail', detail: reason(e), data: { source } };
  }
}

/* ── Enoki ────────────────────────────────────────────────────────────── */

/**
 * The application makes no Enoki call, and needs none: USDC wallet transfers
 * carry no gas on Sui (lib/payments/stablecoin-lane.ts, Gas), and settlement
 * pays its own. ENOKI_API_KEY stays optional for a later sponsor.
 * This probe is therefore the codebase's only Enoki request: an authenticated
 * read of the app record, which is what a valid key unlocks and an invalid
 * one does not. It proves the key, not the integration.
 */
export async function checkEnoki(): Promise<Check> {
  const key = getEnv().ENOKI_API_KEY;
  if (!key) return { ok: true, status: 'skipped', detail: 'ENOKI_API_KEY not set — not needed: USDC transfers carry no gas, and nothing calls Enoki' };
  try {
    const { value, ms } = await timed('Enoki', async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        return await fetch('https://api.enoki.mystenlabs.com/v1/app', {
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }
    });
    if (value.status === 401 || value.status === 403) {
      return { ok: false, status: 'fail', detail: `key rejected (HTTP ${value.status})`, latencyMs: ms };
    }
    if (!value.ok) return { ok: false, status: 'fail', detail: `Enoki answered HTTP ${value.status}`, latencyMs: ms };
    return { ok: true, status: 'ok', detail: 'key accepted by Enoki', latencyMs: ms };
  } catch (e) {
    return { ok: false, status: 'fail', detail: reason(e) };
  }
}

/* ── Flags ────────────────────────────────────────────────────────────── */

export function featureFlags(): Record<string, string | boolean> {
  const env = getEnv();
  return {
    NODE_ENV: env.NODE_ENV,
    SUI_NETWORK: env.SUI_NETWORK,
    SUI_SETTLEMENT_MODE: env.SUI_SETTLEMENT_MODE,
    USE_MOCK_APIS: env.USE_MOCK_APIS,
    NEXT_PUBLIC_DEMO_MODE: env.NEXT_PUBLIC_DEMO_MODE,
    FEATURE_ZKLOGIN: env.FEATURE_ZKLOGIN,
    FEATURE_KYB_GATE: env.FEATURE_KYB_GATE,
    FEATURE_DUAL_FUNDING: env.FEATURE_DUAL_FUNDING,
    OXWAL_CHAIN_MODE: env.OXWAL_CHAIN_MODE,
    CARD_FUNDING_ENABLED: env.CARD_FUNDING_ENABLED,
    TREASURY_EXECUTION_ENABLED: env.TREASURY_EXECUTION_ENABLED,
  };
}

/* ── Everything ───────────────────────────────────────────────────────── */

export type HealthReport = {
  ok: boolean;
  checkedAt: string;
  flags: Record<string, string | boolean>;
  checks: {
    rpc: Check; package: Check; db: Check; seal: Check; enoki: Check;
    /* Go-live: the setup a person does by hand (lib/server/go-live-checks.ts). */
    laneNode: Check; peg: Check; usdyPrice: Check; feeAddress: Check; twilio: Check; passkeyDomain: Check; screening: Check;
  };
};

export async function runHealthChecks(): Promise<HealthReport> {
  const [rpc, pkg, db, seal, enoki, laneNode, peg, usdyPrice, feeAddress, twilio, screening] = await Promise.all([
    checkRpc(), checkPackage(), checkDb(), checkSeal(), checkEnoki(),
    checkLaneNode(), checkPeg(), checkUsdyPrice(), checkFeeAddress(), checkTwilio(), checkScreening(),
  ]);
  const checks = {
    rpc, package: pkg, db, seal, enoki,
    laneNode, peg, usdyPrice, feeAddress, twilio, passkeyDomain: checkPasskeyDomain(), screening,
  };
  // 'skipped' is not a failure: it is a deliberate absence in this env.
  const ok = Object.values(checks).every((c) => c.status !== 'fail');
  return { ok, checkedAt: new Date().toISOString(), flags: featureFlags(), checks };
}
