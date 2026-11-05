/**
 * The scheduled payer: the one key that pays an automatic scheduled batch
 * (v2 Phase 3, "pay automatically within my limits").
 *
 * What it is. A Sui address whose private key lives in AWS KMS and never
 * enters this process, held through the same path as the operator
 * (lib/server/operator-signer.ts) but as a SEPARATE key. The operator key
 * sponsors gas and records audit anchors; this key only ever signs as the
 * spender of an allowance the owners signed, so neither can do the other's
 * job (separation of duties, docs/KEY-POLICY.md). It holds no funds and no
 * SUI: the gas is the operator's, the money is the business's.
 *
 * What it can do if it is stolen. Whoever holds it can ask splash_spend to pay
 * a verified recipient of a business that gave it an allowance, up to that
 * allowance's per-payment limit, its monthly cap and its expiry, and nothing
 * else: it cannot pay an address the owners did not verify, raise a limit,
 * add a recipient, or touch the business's wallet. The owners revoke it
 * whenever they like (docs/v2/phase3-scheduled-batches.md).
 *
 * Resolution, in order:
 *   production    SCHEDULED_PAYER_KMS_KEY_ID and its address must both be
 *                 set; the KMS public key must derive that address; and the
 *                 address must not be the operator's or the sponsor's. Anything
 *                 else is a refusal ("not configured"), never a stand-in: no
 *                 sandbox signer is reachable in production, so no run can be
 *                 paid automatically without the key, and every run is handed
 *                 back to "ask me first".
 *   development   the KMS key when one is named, otherwise a sandbox signer
 *   and test      that signs nothing on chain (kind `sandbox`): the run is
 *                 worked through and recorded, but no transaction is sent.
 *
 * Canon D-0004: nothing under lib/agent, lib/oxwal, lib/ai or lib/chain may
 * reach this module (tests/scheduled-payer.test.mjs checks it).
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { awsCredentialProvider, type KmsSignerFactory } from './operator-signer.ts';
import type { AwsCredentialProvider } from '@mysten/aws-kms-signer';

export type ScheduledPayerKind = 'kms' | 'sandbox';

export type ScheduledPayer = {
  kind: ScheduledPayerKind;
  address: string;
  /** The signature over transaction bytes, serialized for the network. A sandbox payer returns a marker the network would refuse. */
  sign(bytes: Uint8Array): Promise<string>;
};

export type PayerRefusalCode = 'not_configured' | 'incomplete' | 'address_mismatch' | 'same_as_operator' | 'same_as_sponsor' | 'unavailable';
export type PayerResult = { ok: true; payer: ScheduledPayer } | { ok: false; code: PayerRefusalCode; reason: string };

type Env = Record<string, string | undefined>;

export type ScheduledPayerDeps = {
  env?: Env;
  /** Builds the KMS signer. Defaults to `AwsKmsSigner.fromKeyId`; tests inject one so nothing reaches AWS. */
  kmsFactory?: KmsSignerFactory;
  credentials?: AwsCredentialProvider;
  /** The gas sponsor's address, which the payer may never be. Defaults to the operator's. */
  sponsorAddress?: string | null;
};

const blank = (v: string | undefined) => (v ?? '').trim();

/** A fixed key for the sandbox signer. It is public on purpose: it can hold nothing and is refused in production. */
const SANDBOX_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 0x5c) & 0xff);
const sandboxKey = () => Ed25519Keypair.fromSecretKey(SANDBOX_SEED);

/** The sandbox payer's address: what an owner in development is offered as the spender of the allowance. */
export function sandboxPayerAddress(): string {
  return normalizeSuiAddress(sandboxKey().toSuiAddress());
}

/** Which key would pay, without reaching it: production names it in the environment, development falls back to the sandbox address. */
export function scheduledPayerKind(env: Env = process.env): ScheduledPayerKind | 'none' {
  const keyId = blank(env.SCHEDULED_PAYER_KMS_KEY_ID);
  if (!keyId) return env.NODE_ENV === 'production' ? 'none' : 'sandbox';
  return 'kms';
}

/**
 * The address automatic payments are drawn by, or null when none is
 * configured. It is only a name: nothing is signed with it here. Owners give
 * an allowance to this address; spending standing treats it as a spender that
 * belongs to Splash's payer, not a person who left.
 */
export function scheduledPayerAddress(env: Env = process.env): string | null {
  const named = blank(env.SCHEDULED_PAYER_SUI_ADDRESS);
  const keyId = blank(env.SCHEDULED_PAYER_KMS_KEY_ID);
  if (!keyId) {
    // No key: in production there is no payer to name, however the address is set; in development the sandbox payer stands in.
    if (env.NODE_ENV === 'production') return null;
    return named ? normalizeSuiAddress(named) : sandboxPayerAddress();
  }
  return named ? normalizeSuiAddress(named) : null;
}

let cached: Promise<PayerResult> | undefined;

/** The payer, or why there is none. Memoised for the default environment; a call with injected deps resolves afresh. */
export function getScheduledPayer(deps?: ScheduledPayerDeps): Promise<PayerResult> {
  if (deps) return resolve(deps);
  cached ??= resolve({}).then((result) => {
    // A refusal caused by an outage must not stick: the next run tries again.
    if (!result.ok && result.code === 'unavailable') cached = undefined;
    return result;
  });
  return cached;
}

export function resetScheduledPayerCache(): void {
  cached = undefined;
}

async function resolve(deps: ScheduledPayerDeps): Promise<PayerResult> {
  const env = deps.env ?? process.env;
  const production = env.NODE_ENV === 'production';
  const keyId = blank(env.SCHEDULED_PAYER_KMS_KEY_ID);

  if (!keyId) {
    if (production) {
      return { ok: false, code: 'not_configured', reason: 'No scheduled-payer KMS key is configured (SCHEDULED_PAYER_KMS_KEY_ID), so nothing is paid automatically.' };
    }
    const key = sandboxKey();
    return { ok: true, payer: { kind: 'sandbox', address: normalizeSuiAddress(key.toSuiAddress()), sign: async () => 'sandbox-signature-not-valid-on-any-network' } };
  }

  const region = blank(env.AWS_REGION);
  const named = blank(env.SCHEDULED_PAYER_SUI_ADDRESS);
  if (!region || !named) {
    return { ok: false, code: 'incomplete', reason: 'The scheduled-payer KMS key needs AWS_REGION and SCHEDULED_PAYER_SUI_ADDRESS, so nothing is paid automatically.' };
  }
  if (keyId === blank(env.OPERATOR_KMS_KEY_ID)) {
    return { ok: false, code: 'same_as_operator', reason: 'The scheduled-payer key is the operator key. The key that sponsors gas must not also be the key that pays.' };
  }

  let signer;
  try {
    const factory: KmsSignerFactory =
      deps.kmsFactory ??
      (async (id, options) => {
        const { AwsKmsSigner } = await import('@mysten/aws-kms-signer');
        return AwsKmsSigner.fromKeyId(id, options);
      });
    signer = await factory(keyId, { region, credentials: deps.credentials ?? awsCredentialProvider(env as NodeJS.ProcessEnv) });
  } catch {
    // The reason is the operator's to read in the log; it carries no key. The caller words it for the owners.
    return { ok: false, code: 'unavailable', reason: 'The scheduled-payer KMS key could not be reached, so nothing is paid automatically right now.' };
  }

  const address = normalizeSuiAddress(signer.toSuiAddress());
  if (address !== normalizeSuiAddress(named)) {
    return { ok: false, code: 'address_mismatch', reason: 'The scheduled-payer KMS key does not derive SCHEDULED_PAYER_SUI_ADDRESS, so nothing is paid automatically.' };
  }
  const operator = blank(env.OPERATOR_SUI_ADDRESS);
  if (operator && address === normalizeSuiAddress(operator)) {
    return { ok: false, code: 'same_as_operator', reason: 'The scheduled payer is the operator address. The gas sponsor and the payer must be different keys.' };
  }
  const sponsor = deps.sponsorAddress ?? null;
  if (sponsor && address === normalizeSuiAddress(sponsor)) {
    return { ok: false, code: 'same_as_sponsor', reason: 'The scheduled payer is the gas sponsor. They must be different keys.' };
  }
  return {
    ok: true,
    payer: {
      kind: 'kms',
      address,
      sign: async (bytes) => (await signer.signTransaction(bytes)).signature,
    },
  };
}
