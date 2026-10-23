/**
 * The operator signer — the one place Splash's hot settlement key is resolved.
 *
 * WS4. Production signs with an AWS KMS key through `@mysten/aws-kms-signer`.
 * The private key is generated inside KMS and never leaves it: this process
 * holds a key id and a public key, sends transaction bytes to KMS, and gets a
 * signature back. A compromised server can ask KMS to sign while it is
 * compromised, and the outflow monitor exists for exactly that window
 * (lib/server/operator-outflows.ts) — but it cannot copy the key and keep
 * signing after the host is rebuilt, which a raw env key always allowed.
 *
 * Resolution, in order:
 *
 *   1. OPERATOR_KMS_KEY_ID set  -> the KMS signer. The raw key, if one is also
 *      set, is never decoded.
 *   2. production, no KMS key   -> a raw key is refused (it is also refused at
 *      boot by lib/env.ts); with no key at all the answer is null, and every
 *      caller already treats null as "settlement is not configured".
 *   3. development and test     -> OPERATOR_SUI_PRIVATE_KEY (or the older
 *      SUI_SPONSOR_PRIVATE_KEY spelling), for testnet smoke tests.
 *
 * Canon D-0004: the operator key is never read into the agent's (Zeke,
 * internally `oxwal`) process or any agent tool. Nothing under lib/agent,
 * lib/oxwal, lib/ai, lib/chain or the agent routes imports this module, and
 * tests/operator-custody.test.mjs fails the build if one starts to.
 */
import type { Signer } from '@mysten/sui/cryptography';

import type { AwsClientOptions, AwsCredentialIdentity, AwsCredentialProvider } from '@mysten/aws-kms-signer';

export type KmsSignerFactory = (keyId: string, options: AwsClientOptions) => Promise<Signer>;

export type OperatorSignerKind = 'kms' | 'raw-key' | 'none';

type Env = Record<string, string | undefined>;

export type OperatorSignerDeps = {
  /** Defaults to process.env. Tests pass a literal object. */
  env?: Env;
  /** The address the signer must have. Defaults to OPERATOR_SUI_ADDRESS via
   *  the contract config; '' skips the check (nothing is configured yet). */
  expectedAddress?: string;
  /** Builds the KMS signer. Defaults to `AwsKmsSigner.fromKeyId`; tests inject
   *  one so nothing reaches AWS. */
  kmsFactory?: KmsSignerFactory;
  /** Overrides credential resolution. */
  credentials?: AwsCredentialProvider;
};

const blank = (v: string | undefined) => (v ?? '').trim();

export function operatorSignerKind(env: Env = process.env): OperatorSignerKind {
  if (blank(env.OPERATOR_KMS_KEY_ID)) return 'kms';
  if (blank(env.OPERATOR_SUI_PRIVATE_KEY) || blank(env.SUI_SPONSOR_PRIVATE_KEY)) return 'raw-key';
  return 'none';
}

let cached: Promise<Signer | null> | undefined;

/**
 * The operator signer, or null when none is configured. Memoised for the
 * default environment; a call with injected deps always resolves afresh.
 */
export function getOperatorSigner(deps?: OperatorSignerDeps): Promise<Signer | null> {
  if (deps) return resolveOperatorSigner(deps);
  cached ??= resolveOperatorSigner({}).catch((error) => {
    // A failed resolution (KMS unreachable, wrong key) must not be cached:
    // the next settlement should try again rather than inherit the outage.
    cached = undefined;
    throw error;
  });
  return cached;
}

/** For tests and for the rotation runbook's dry run. */
export function resetOperatorSignerCache(): void {
  cached = undefined;
}

async function resolveOperatorSigner(deps: OperatorSignerDeps): Promise<Signer | null> {
  const env = deps.env ?? process.env;
  const kind = operatorSignerKind(env);
  const production = env.NODE_ENV === 'production';

  let signer: Signer | null;
  if (kind === 'kms') {
    signer = await kmsSigner(env, deps);
  } else if (kind === 'raw-key') {
    if (production) {
      throw new Error(
        'A raw operator key (OPERATOR_SUI_PRIVATE_KEY / SUI_SPONSOR_PRIVATE_KEY) is set in production. ' +
          'Production signs only through KMS: set OPERATOR_KMS_KEY_ID and remove the raw key from the host.',
      );
    }
    signer = await rawKeySigner(env);
  } else {
    signer = null;
  }

  if (signer) {
    const expected = (deps.expectedAddress ?? (await configuredOperatorAddress())).trim().toLowerCase();
    const actual = signer.toSuiAddress().toLowerCase();
    if (expected && actual !== expected) {
      const source = kind === 'kms' ? 'the KMS key OPERATOR_KMS_KEY_ID' : 'OPERATOR_SUI_PRIVATE_KEY';
      throw new Error(`${source} does not match OPERATOR_SUI_ADDRESS`);
    }
  }
  return signer;
}

async function configuredOperatorAddress(): Promise<string> {
  const { getContractConfig } = await import('./contract-config.ts');
  return getContractConfig().operatorAddress ?? '';
}

async function kmsSigner(env: Env, deps: OperatorSignerDeps): Promise<Signer> {
  const keyId = blank(env.OPERATOR_KMS_KEY_ID);
  const region = blank(env.AWS_REGION);
  if (!region) throw new Error('OPERATOR_KMS_KEY_ID is set but AWS_REGION is not; the KMS signer needs the key\'s region.');

  const factory: KmsSignerFactory = deps.kmsFactory ?? (async (id, options) => {
    const { AwsKmsSigner } = await import('@mysten/aws-kms-signer');
    return AwsKmsSigner.fromKeyId(id, options);
  });
  return factory(keyId, { region, credentials: deps.credentials ?? awsCredentialProvider(env) });
}

async function rawKeySigner(env: Env): Promise<Signer> {
  const encoded = blank(env.OPERATOR_SUI_PRIVATE_KEY) || blank(env.SUI_SPONSOR_PRIVATE_KEY);
  try {
    const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
    const parsed = decodeSuiPrivateKey(encoded);
    if (parsed.scheme === 'ED25519') {
      const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
      return Ed25519Keypair.fromSecretKey(parsed.secretKey);
    }
    if (parsed.scheme === 'Secp256k1') {
      const { Secp256k1Keypair } = await import('@mysten/sui/keypairs/secp256k1');
      return Secp256k1Keypair.fromSecretKey(parsed.secretKey);
    }
    throw new Error(`unsupported key scheme ${parsed.scheme}; Splash supports ED25519 and Secp256k1`);
  } catch (error) {
    // The decoder's message never contains the key; ours must not either.
    throw new Error(`Invalid OPERATOR_SUI_PRIVATE_KEY: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── AWS credentials ────────────────────────────────────────────────────

   Role credentials are the default (OPERATOR_KMS_CREDENTIALS=role): short-
   lived, issued to the machine, rotated by AWS, and never written into a file
   anyone can copy. Resolved per request by the KMS client and cached here
   until five minutes before they expire. Sources, in order:

     - temporary credentials already in the environment (an access key WITH a
       session token — what Lambda, IAM Roles Anywhere's credential helper and
       `aws sts assume-role` wrappers provide);
     - the ECS / EKS container endpoint (AWS_CONTAINER_CREDENTIALS_*);
     - the EC2 instance profile, over IMDSv2.

   OPERATOR_KMS_CREDENTIALS=static reads a long-lived access key pair from the
   environment. It exists for hosts AWS cannot issue a role to (a DigitalOcean
   Droplet); the key policy must then grant that IAM user kms:Sign and
   kms:GetPublicKey on this one key and nothing else. See SECURITY.md, WS4. */

const IMDS = 'http://169.254.169.254';
const ECS_HOST = 'http://169.254.170.2';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type RoleCredentialJson = { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };

export function awsCredentialProvider(env: Env = process.env, fetchImpl: typeof fetch = fetch): AwsCredentialProvider {
  const mode = blank(env.OPERATOR_KMS_CREDENTIALS) || 'role';
  if (mode === 'static') {
    return async () => {
      const accessKeyId = blank(env.AWS_ACCESS_KEY_ID);
      const secretAccessKey = blank(env.AWS_SECRET_ACCESS_KEY);
      if (!accessKeyId || !secretAccessKey) {
        throw new Error('OPERATOR_KMS_CREDENTIALS=static needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
      }
      const sessionToken = blank(env.AWS_SESSION_TOKEN) || undefined;
      return { accessKeyId, secretAccessKey, sessionToken };
    };
  }

  let current: { identity: AwsCredentialIdentity; expiresAt: number } | null = null;
  return async () => {
    if (current && Date.now() < current.expiresAt - REFRESH_MARGIN_MS) return current.identity;
    current = await resolveRoleCredentials(env, fetchImpl);
    return current.identity;
  };
}

async function resolveRoleCredentials(
  env: Env,
  fetchImpl: typeof fetch,
): Promise<{ identity: AwsCredentialIdentity; expiresAt: number }> {
  const envKey = blank(env.AWS_ACCESS_KEY_ID);
  const envSecret = blank(env.AWS_SECRET_ACCESS_KEY);
  const envToken = blank(env.AWS_SESSION_TOKEN);
  if (envKey && envSecret && envToken) {
    // Whoever put them there refreshes them; re-read every 15 minutes.
    return { identity: { accessKeyId: envKey, secretAccessKey: envSecret, sessionToken: envToken }, expiresAt: Date.now() + 15 * 60 * 1000 + REFRESH_MARGIN_MS };
  }

  const relative = blank(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
  const full = blank(env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  if (relative || full) {
    const token = blank(env.AWS_CONTAINER_AUTHORIZATION_TOKEN);
    const response = await fetchImpl(relative ? `${ECS_HOST}${relative}` : full, {
      headers: token ? { Authorization: token } : {},
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`the container credential endpoint answered ${response.status}`);
    return fromRoleJson((await response.json()) as RoleCredentialJson, 'the container credential endpoint');
  }

  const tokenResponse = await fetchImpl(`${IMDS}/latest/api/token`, {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
    signal: AbortSignal.timeout(1_000),
  }).catch(() => null);
  if (!tokenResponse?.ok) {
    throw new Error(
      'No AWS role credentials are available to the KMS signer: no temporary credentials in the environment, ' +
        'no container credential endpoint, and no EC2 instance profile (IMDSv2). Attach a role, or set ' +
        'OPERATOR_KMS_CREDENTIALS=static with a key scoped to kms:Sign on this key only.',
    );
  }
  const imdsToken = await tokenResponse.text();
  const headers = { 'X-aws-ec2-metadata-token': imdsToken };
  const roleResponse = await fetchImpl(`${IMDS}/latest/meta-data/iam/security-credentials/`, { headers, signal: AbortSignal.timeout(1_000) });
  const role = roleResponse.ok ? (await roleResponse.text()).split('\n')[0]?.trim() : '';
  if (!role) throw new Error('the EC2 instance has no IAM role attached, so the KMS signer has no credentials');
  const credentialResponse = await fetchImpl(`${IMDS}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers, signal: AbortSignal.timeout(1_000) });
  if (!credentialResponse.ok) throw new Error(`the instance profile answered ${credentialResponse.status}`);
  return fromRoleJson((await credentialResponse.json()) as RoleCredentialJson, 'the instance profile');
}

function fromRoleJson(json: RoleCredentialJson, source: string): { identity: AwsCredentialIdentity; expiresAt: number } {
  if (!json.AccessKeyId || !json.SecretAccessKey) throw new Error(`${source} returned no credentials`);
  const expiresAt = json.Expiration ? Date.parse(json.Expiration) : Date.now() + 15 * 60 * 1000;
  return {
    identity: { accessKeyId: json.AccessKeyId, secretAccessKey: json.SecretAccessKey, sessionToken: json.Token },
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 15 * 60 * 1000,
  };
}
