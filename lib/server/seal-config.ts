import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { KeyServerConfig } from '@mysten/seal';

/**
 * Seal configuration: the key-server committee, threshold, package and
 * policy, read from a committed file — config/seal.<NODE_ENV>.json — rather
 * than from an environment variable.
 *
 * The list used to be SEAL_KEY_SERVER_ENDPOINTS: a JSON array of object IDs,
 * aggregator URLs and integer weights, hand-typed into each developer's
 * .env.local. This module validated it on twelve conditions, all at request
 * time, so two machines both booted cleanly and then diverged on the first
 * route that touched Seal. A committed file is identical on every machine by
 * construction, and the same twelve checks now run once at boot, from
 * validateEnvAtBoot() in lib/env.ts.
 *
 * The file is authoritative. If a moved key is still set in the environment
 * the loader refuses and names it — two sources for one setting is how the
 * divergence started. What stays in env is operational or sensitive, not
 * shared configuration: SEAL_HEALTH_TIMEOUT_MS, SEAL_ALERT_WEBHOOK_URL.
 *
 * Callers are unchanged: getSealConfig() returns the same ParsedSealConfig
 * that lib/server/seal.ts and lib/server/seal-health.ts always consumed.
 */

export type SealKeyServerMode = 'decentralized' | 'independent';

export type ParsedSealConfig = {
  configured: boolean;
  mode: SealKeyServerMode;
  serverConfigs: KeyServerConfig[];
  threshold: number;
  timeoutMs: number;
  packageId: string;
  policyObjectId: string;
  approveTarget: string;
  /** Where it came from, for doctor and /api/health. */
  source: string;
};

/** The on-disk shape. See config/README.md. */
export type SealConfigFile = {
  mode?: SealKeyServerMode;
  threshold?: number;
  packageId?: string;
  policyObjectId?: string;
  approveTarget?: string;
  servers?: Array<{ objectId: string; aggregatorUrl?: string; weight?: number }>;
};

const OBJECT_ID = /^0x[a-fA-F0-9]{64}$/;

/** Keys that moved into the file. Any of these still set in env is an error. */
export const MOVED_TO_FILE = [
  'SEAL_KEY_SERVER_ENDPOINTS',
  'SEAL_KEY_SERVER_URLS',
  'SEAL_KEY_SERVER_MODE',
  'SEAL_THRESHOLD',
  'SEAL_PACKAGE_ID',
  'SEAL_POLICY_OBJECT_ID',
  'SEAL_APPROVE_TARGET',
] as const;

function positiveInteger(value: unknown, fallback: number, name: string) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

/* ── Server-list validation — unchanged from the env-var era ──────────── */

function parseJsonEndpoints(raw: string): KeyServerConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Seal servers must be an array.');
  return normaliseServers(parsed);
}

function normaliseServers(parsed: unknown[]): KeyServerConfig[] {
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Seal servers[${index}] must be an object.`);
    const value = entry as Record<string, unknown>;
    return {
      objectId: String(value.objectId ?? '').trim(),
      aggregatorUrl: value.aggregatorUrl ? String(value.aggregatorUrl).trim() : undefined,
      weight: Number(value.weight ?? 1),
    };
  });
}

function parseCompactEndpoints(raw: string): KeyServerConfig[] {
  return raw.split(',').map((entry) => {
    const [objectId = '', aggregatorUrl = '', weight = '1'] = entry.split('|').map((part) => part.trim());
    return { objectId, aggregatorUrl: aggregatorUrl || undefined, weight: Number.parseInt(weight, 10) };
  });
}

/**
 * Validate a server list. Accepts the file's array, or — for the compact
 * string form some tooling still emits — a string. The twelve checks that
 * used to run at request time.
 */
export function parseSealServerConfigs(raw: string | unknown[], mode: SealKeyServerMode): KeyServerConfig[] {
  let configs: KeyServerConfig[];
  if (Array.isArray(raw)) {
    configs = normaliseServers(raw);
  } else {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    configs = trimmed.startsWith('[') ? parseJsonEndpoints(trimmed) : parseCompactEndpoints(trimmed);
  }

  const ids = new Set<string>();
  for (const config of configs) {
    if (!OBJECT_ID.test(config.objectId)) {
      throw new Error(`Invalid Seal key-server object ID: ${config.objectId || '(blank)'}.`);
    }
    if (!Number.isInteger(config.weight) || config.weight < 1) {
      throw new Error(`Seal key-server weight for ${config.objectId} must be a positive integer.`);
    }
    if (ids.has(config.objectId.toLowerCase())) {
      throw new Error(`Duplicate Seal key-server object ID: ${config.objectId}.`);
    }
    ids.add(config.objectId.toLowerCase());

    if (mode === 'decentralized' && !config.aggregatorUrl) {
      throw new Error(`Decentralized Seal server ${config.objectId} requires an aggregatorUrl.`);
    }
    if (config.aggregatorUrl) {
      const url = new URL(config.aggregatorUrl);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
        throw new Error(`Seal aggregator URL must use HTTPS: ${config.aggregatorUrl}.`);
      }
      config.aggregatorUrl = url.toString().replace(/\/$/, '');
    }
  }
  return configs;
}

/* ── File selection and loading ───────────────────────────────────────── */

/**
 * config/seal.<NODE_ENV>.json, or SEAL_CONFIG_FILE when set (tests).
 *
 * The file is a path chosen at run time (the override can be anything), and
 * Turbopack cannot trace that: it traced the WHOLE project, source and
 * public/, into every server output to cover it. So the path and the reads
 * carry `turbopackIgnore`, and the committed files are included explicitly
 * instead (`outputFileTracingIncludes` in next.config.ts), so production
 * still ships its Seal committee. An override file must already exist on the
 * host; it is never bundled.
 */
export function sealConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SEAL_CONFIG_FILE?.trim();
  if (override) return path.resolve(/*turbopackIgnore: true*/ process.cwd(), override);
  const mode = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  return path.resolve(process.cwd(), 'config', `seal.${mode}.json`);
}

function readFile(file: string): SealConfigFile {
  let text: string;
  try {
    text = readFileSync(/*turbopackIgnore: true*/ file, 'utf8');
  } catch (error) {
    throw new Error(`Seal config ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Seal config ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Seal config ${file} must be a JSON object; see config/README.md.`);
  }
  return parsed as SealConfigFile;
}

/**
 * Parse a file's contents into the runtime shape. Pure: tests call this
 * with literal objects.
 */
export function parseSealConfigFile(file: SealConfigFile, source: string, env: NodeJS.ProcessEnv = process.env): ParsedSealConfig {
  const rawMode = String(file.mode ?? 'decentralized').trim().toLowerCase();
  if (rawMode !== 'decentralized' && rawMode !== 'independent') {
    throw new Error(`${source}: mode must be decentralized or independent.`);
  }
  const mode: SealKeyServerMode = rawMode;

  const serverConfigs = parseSealServerConfigs(file.servers ?? [], mode);
  const threshold = positiveInteger(file.threshold, 1, `${source}: threshold`);
  const totalWeight = serverConfigs.reduce((sum, server) => sum + server.weight, 0);
  if (serverConfigs.length > 0 && threshold > totalWeight) {
    throw new Error(`${source}: threshold ${threshold} is not satisfiable by configured weight ${totalWeight}.`);
  }

  const packageId = String(file.packageId ?? '').trim();
  const policyObjectId = String(file.policyObjectId ?? '').trim();
  if (packageId && !OBJECT_ID.test(packageId)) throw new Error(`${source}: packageId must be a canonical Sui package ID.`);
  if (policyObjectId && !OBJECT_ID.test(policyObjectId)) {
    throw new Error(`${source}: policyObjectId must be a canonical Sui object ID.`);
  }

  return {
    configured: serverConfigs.length > 0 && Boolean(packageId && policyObjectId),
    mode,
    serverConfigs,
    threshold,
    timeoutMs: positiveInteger(env.SEAL_HEALTH_TIMEOUT_MS, 10_000, 'SEAL_HEALTH_TIMEOUT_MS'),
    packageId,
    policyObjectId,
    approveTarget: String(file.approveTarget ?? (packageId ? `${packageId}::allowlist::seal_approve` : '')).trim(),
    source,
  };
}

/** Refuse if a key that moved into the file is still set in the environment. */
export function assertNoLegacySealEnv(env: NodeJS.ProcessEnv = process.env): void {
  const stale = MOVED_TO_FILE.filter((key) => (env[key] ?? '').trim() !== '');
  if (stale.length) {
    throw new Error(
      `${stale.join(', ')} moved to config/seal.<env>.json and must not be set in the environment — ` +
        'remove it from .env.local and from the host. Two sources for one setting is how Seal diverged between machines.',
    );
  }
}

const cache = new Map<string, ParsedSealConfig>();

/**
 * The Seal configuration for this environment. Memoised per file path.
 *
 * Development and test with no file: unconfigured, which seal-health reports
 * and the demo records cover. Production with no file: an error naming the
 * file — Seal fails closed there, and that is the regulatory posture.
 */
export function getSealConfig(env: NodeJS.ProcessEnv = process.env): ParsedSealConfig {
  assertNoLegacySealEnv(env);

  const file = sealConfigPath(env);
  const hit = cache.get(file);
  if (hit) return hit;

  if (!existsSync(/*turbopackIgnore: true*/ file)) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`Seal config ${file} does not exist. Production refuses to start without its committed Seal committee; see config/README.md.`);
    }
    const unconfigured = parseSealConfigFile({}, `${file} (absent)`, env);
    cache.set(file, unconfigured);
    return unconfigured;
  }

  const parsed = parseSealConfigFile(readFile(file), path.relative(process.cwd(), file) || file, env);
  cache.set(file, parsed);
  return parsed;
}

/** Tests only: forget memoised files. */
export function resetSealConfigCache(): void {
  cache.clear();
}
