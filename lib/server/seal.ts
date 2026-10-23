import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toHex } from '@mysten/sui/utils';

import { getSealConfig } from '@/lib/server/seal-config';
import { assertSealWritable } from '@/lib/server/seal-health';
import { canUseDemoCrypto } from '@/lib/server/runtime-mode';
import { getOperatorSigner } from '@/lib/server/operator-signer';
import { suiClient } from '@/lib/sui';

export type SealPolicy = {
  policyId: string;
  allowlist: string[];
  createdAt: string;
  mode: 'demo' | 'live';
  sealId?: string;
};

export interface SealAdapter {
  encrypt(data: string, allowlist: string[]): Promise<{ ciphertext: string; policy: SealPolicy }>;
  canDecrypt(policyId: string, identity: string): Promise<boolean>;
  decrypt(ciphertext: string, policyId: string, identity: string): Promise<string | null>;
}

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export function shouldUseMockSeal(env: NodeJS.ProcessEnv = process.env) {
  return canUseDemoCrypto(env);
}

const DATA_DIR = process.env.SPLASH_DATA_DIR ?? path.join(process.cwd(), 'data');
const POLICY_PATH = path.join(DATA_DIR, 'seal-policies.json');
const globalPolicies = globalThis as typeof globalThis & {
  splashSealPolicies?: Map<string, SealPolicy>;
  splashSealClient?: SealClient;
};

function readPolicies() {
  try {
    const parsed = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')) as SealPolicy[];
    return new Map(parsed.filter((policy) => policy?.policyId).map((policy) => [policy.policyId, policy]));
  } catch {
    return new Map<string, SealPolicy>();
  }
}

const policies = globalPolicies.splashSealPolicies ?? readPolicies();
globalPolicies.splashSealPolicies = policies;

function persistPolicies() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempPath = `${POLICY_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify([...policies.values()], null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, POLICY_PATH);
}

function rememberPolicy(policy: SealPolicy) {
  policies.set(policy.policyId, policy);
  persistPolicies();
}

function secretKey() {
  return createHash('sha256').update(process.env.ADMIN_SESSION_SECRET || 'splash-seal-mock-development-key').digest();
}

function normalizedAllowlist(allowlist: string[]) {
  return [...new Set(allowlist.map((identity) => identity.trim().toLowerCase()).filter(Boolean))].sort();
}

export const mockSealAdapter: SealAdapter = {
  async encrypt(data, allowlist) {
    const createdAt = new Date().toISOString();
    const normalized = normalizedAllowlist(allowlist);
    const policyId = `DEMO_SEAL_${createHash('sha256').update(`${normalized.join('|')}:${createdAt}`).digest('hex').slice(0, 16)}`;
    const policy: SealPolicy = { policyId, allowlist: normalized, createdAt, mode: 'demo' };
    rememberPolicy(policy);

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, encrypted]).toString('base64'),
      policy,
    };
  },
  async canDecrypt(policyId, identity) {
    return policies.get(policyId)?.allowlist.includes(identity.trim().toLowerCase()) ?? false;
  },
  async decrypt(ciphertext, policyId, identity) {
    if (!(await this.canDecrypt(policyId, identity))) return null;
    const payload = Buffer.from(ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  },
};

function liveClient() {
  if (globalPolicies.splashSealClient) return globalPolicies.splashSealClient;
  const config = getSealConfig();
  if (!config.configured) {
    throw new NotConfiguredError('Live Seal package, policy object, or key-server committee is not configured.');
  }
  globalPolicies.splashSealClient = new SealClient({
    suiClient,
    serverConfigs: config.serverConfigs,
    verifyKeyServers: config.mode !== 'decentralized',
    timeout: config.timeoutMs,
  });
  return globalPolicies.splashSealClient;
}

function sealIdFor(policyId: string) {
  const policy = policies.get(policyId);
  return policy?.sealId ?? (policyId.startsWith('SEAL:') ? policyId.slice(5) : null);
}

export const liveSealAdapter: SealAdapter = {
  async encrypt(data, allowlist) {
    await assertSealWritable();
    const config = getSealConfig();
    const sealId = toHex(new Uint8Array([...fromHex(config.policyObjectId), ...randomBytes(5)]));
    const { encryptedObject } = await liveClient().encrypt({
      threshold: config.threshold,
      packageId: config.packageId,
      id: sealId,
      data: new TextEncoder().encode(data),
    });
    const policy: SealPolicy = {
      policyId: `SEAL:${sealId}`,
      allowlist: normalizedAllowlist(allowlist),
      createdAt: new Date().toISOString(),
      mode: 'live',
      sealId,
    };
    rememberPolicy(policy);
    return { ciphertext: Buffer.from(encryptedObject).toString('base64'), policy };
  },
  async canDecrypt(policyId, identity) {
    const policy = policies.get(policyId);
    if (!policy || !sealIdFor(policyId)) return false;
    return policy.allowlist.includes(identity.trim().toLowerCase());
  },
  async decrypt(ciphertext, policyId, identity) {
    await assertSealWritable();
    if (!(await this.canDecrypt(policyId, identity))) return null;
    const sealId = sealIdFor(policyId);
    if (!sealId) return null;
    const config = getSealConfig();
    const signer = await getOperatorSigner();
    if (!signer) throw new NotConfiguredError('The operator signer (OPERATOR_KMS_KEY_ID, or OPERATOR_SUI_PRIVATE_KEY outside production) is required for live Seal decryption.');

    const sessionKey = await SessionKey.create({
      address: signer.toSuiAddress(),
      packageId: config.packageId,
      ttlMin: 10,
      signer,
      suiClient,
    });
    const tx = new Transaction();
    tx.moveCall({
      target: config.approveTarget as `${string}::${string}::${string}`,
      arguments: [tx.pure.vector('u8', fromHex(sealId)), tx.object(config.policyObjectId)],
    });
    const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
    const plaintext = await liveClient().decrypt({
      data: Buffer.from(ciphertext, 'base64'),
      sessionKey,
      txBytes,
      checkShareConsistency: true,
    });
    return new TextDecoder().decode(plaintext);
  },
};

export const sealAdapter: SealAdapter = {
  encrypt(data, allowlist) {
    return shouldUseMockSeal()
      ? mockSealAdapter.encrypt(data, allowlist)
      : liveSealAdapter.encrypt(data, allowlist);
  },
  async canDecrypt(policyId, identity) {
    if (policyId.startsWith('DEMO_SEAL_')) {
      return shouldUseMockSeal() ? mockSealAdapter.canDecrypt(policyId, identity) : false;
    }
    return liveSealAdapter.canDecrypt(policyId, identity);
  },
  async decrypt(ciphertext, policyId, identity) {
    if (policyId.startsWith('DEMO_SEAL_')) {
      return shouldUseMockSeal() ? mockSealAdapter.decrypt(ciphertext, policyId, identity) : null;
    }
    return liveSealAdapter.decrypt(ciphertext, policyId, identity);
  },
};

export function readSealPolicy(policyId: string) {
  return policies.get(policyId) ?? null;
}
