/**
 * Walrus stores ciphertext only. Plaintext PII, bank details, and KYC data must
 * never be sent to the publisher.
 */
import { createHash } from 'node:crypto';

export interface WalrusBlob {
  blobId: string;
  encryptedData: string;
  sizeBytes: number;
  /**
   * The storage epochs a live store ASKED for. 0 for a demo blob, which buys no
   * Walrus storage; null on a read, because the aggregator does not say. What
   * Walrus actually holds a live blob until is `endEpoch`.
   */
  epochs: number | null;
  /** Live stores only: the Walrus epoch the blob expires at, as the publisher reported it; null if it did not say. */
  endEpoch?: number | null;
  /** Live stores only: whether the new blob is deletable, as the publisher reported it; null if it did not say. */
  deletable?: boolean | null;
  /**
   * Live stores only. `alreadyCertified` means Walrus found this blob already
   * stored and bought nothing: its Blob object is not the one sent to
   * `WALRUS_BLOB_OWNER`, so a renewal cannot extend it from Splash's address.
   */
  publisherOutcome?: 'newlyCreated' | 'alreadyCertified' | null;
  mode: 'demo' | 'live';
  createdAt: string;
}

export class WalrusAdapterError extends Error {
  // Plain fields rather than constructor parameter properties: the Node test
  // runner strips types only, and a parameter property is a transform.
  readonly status: number;
  /**
   * What a customer may be told. Usually the message itself; for a
   * configuration error it is generic, because the message names an
   * environment key and what it must be, which is the operator's business.
   */
  readonly publicMessage: string;

  constructor(message: string, status = 502, publicMessage = message) {
    super(message);
    this.status = status;
    this.publicMessage = publicMessage;
    this.name = 'WalrusAdapterError';
  }
}

const CONFIG_PUBLIC_MESSAGE = 'Walrus storage is not available right now. Nothing was stored; try again later.';

/** A server misconfiguration: the detail is for the log, never the customer. */
function walrusConfigError(detail: string, status = 500): WalrusAdapterError {
  return new WalrusAdapterError(detail, status, CONFIG_PUBLIC_MESSAGE);
}

/**
 * The answer a route gives a customer for a WalrusAdapterError. When the
 * customer is told less than the error says (a configuration error), the
 * full message is logged here, with where it happened, so the operator can
 * still find which key is wrong.
 */
export function walrusErrorReply(error: WalrusAdapterError, where: string): { status: number; error: string } {
  if (error.publicMessage !== error.message) console.error(`${where}: ${error.message}`);
  return { status: error.status, error: error.publicMessage };
}

/**
 * Pre-audit C1 (13 Nov 2026). Walrus stores a blob for ONE epoch when the
 * publisher is not told otherwise (two weeks on Mainnet), and newly stored
 * blobs are deletable by default (Walrus >= 1.33). Settlement evidence must
 * outlive both, so every live store asks for `WALRUS_STORE_EPOCHS` epochs
 * (default 53, the most storage can be bought for, about two years on
 * Mainnet) as a permanent blob, and sends the Blob object to
 * `WALRUS_BLOB_OWNER` when set, so Splash, not the publisher's sub-wallet,
 * holds what a renewal extends.
 *
 * Publisher API: https://docs.wal.app/usage/web-api.html ("Storing Blobs").
 * Maximum epochs: https://docs.wal.app/usage/networks.html (53 on Mainnet and
 * Testnet). `deletable` is deprecated and is never sent: with `permanent=true`
 * it is an INVALID_BLOB_PERSISTENCE error.
 */
export const WALRUS_MAX_EPOCHS = 53;

const SUI_ADDRESS = /^0x[a-fA-F0-9]{64}$/;

export function walrusStoreEpochs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WALRUS_STORE_EPOCHS ?? '').trim();
  if (!raw) return WALRUS_MAX_EPOCHS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > WALRUS_MAX_EPOCHS) {
    throw walrusConfigError(`WALRUS_STORE_EPOCHS must be a whole number from 1 to ${WALRUS_MAX_EPOCHS}.`);
  }
  return n;
}

export function walrusStoreUrl(publisher: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(`${publisher.replace(/\/+$/, '')}/v1/blobs`);
  url.searchParams.set('epochs', String(walrusStoreEpochs(env)));
  url.searchParams.set('permanent', 'true');
  const owner = (env.WALRUS_BLOB_OWNER ?? '').trim();
  if (owner) {
    // lib/env.ts checks this at boot too; a store must not send the Blob
    // object to an address nobody can sign for.
    if (!SUI_ADDRESS.test(owner)) throw walrusConfigError('WALRUS_BLOB_OWNER must be a 0x + 64 hex Sui address.');
    url.searchParams.set('send_object_to', owner);
  }
  return url.toString();
}

const globalBlobs = globalThis as typeof globalThis & { splashWalrusBlobs?: Map<string, WalrusBlob> };
const blobs = globalBlobs.splashWalrusBlobs ?? new Map<string, WalrusBlob>();
globalBlobs.splashWalrusBlobs = blobs;

function assertCiphertextOnly(payload: string) {
  const normalized = payload.trim().toLowerCase();
  if (
    (normalized.startsWith('{') || normalized.startsWith('[')) &&
    /"(account|swift|nric|iban|card)"\s*:/.test(normalized)
  ) {
    throw new WalrusAdapterError('Walrus rejected a plaintext payload containing an obvious PII key.', 400);
  }
}

function demoMode() {
  return process.env.USE_MOCK_APIS === 'true' || !process.env.WALRUS_PUBLISHER_URL;
}

type PublisherResult = {
  newlyCreated?: {
    blobObject?: {
      blobId?: string;
      deletable?: boolean;
      registeredEpoch?: number;
      certifiedEpoch?: number;
      storage?: { startEpoch?: number; endEpoch?: number };
    };
    blobId?: string;
  };
  alreadyCertified?: { blobId?: string; endEpoch?: number };
  blobId?: string;
};

const epochOrNull = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The epoch to measure a new blob's retention from: the latest epoch the
 * publisher's response names for it. `epochs` is counted ahead of the epoch
 * the store happened in, which the response does not state; but the blob was
 * registered and certified in the epochs it reports, so the network was at
 * least that far on. `storage.startEpoch` alone is not enough: a reused
 * storage resource (resourceOperation `reuseStorage`) can have started long
 * before this blob. The latest of the three is a floor for the store's
 * epoch, so the epochs counted from it are never fewer than the blob truly
 * has left: a blob this calls short is short. One it passes could still be
 * short by however far the network had moved past that floor, which the
 * response does not say. null when the response names none of them.
 */
function measuredFrom(created: NonNullable<PublisherResult['newlyCreated']>['blobObject']): number | null {
  const known = [created?.registeredEpoch, created?.certifiedEpoch, created?.storage?.startEpoch]
    .map(epochOrNull)
    .filter((e): e is number => e !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * What the evidence will not get, said once, by blob id, in the server log.
 * Nothing is refused: the payment behind the evidence has already happened,
 * and whether a short or deletable blob should stop it is a product decision.
 */
function retentionShortfalls(blob: WalrusBlob, asked: number, fromEpoch: number | null): string[] {
  const problems: string[] = [];
  if (blob.endEpoch === null || blob.endEpoch === undefined) {
    problems.push('the publisher reported no end epoch, so how long Walrus keeps it is unknown');
  } else if (blob.publisherOutcome === 'newlyCreated') {
    if (fromEpoch === null) {
      problems.push(
        `it lasts to epoch ${blob.endEpoch}, but the publisher named no epoch it was stored in, so whether that is the ${asked} asked for could not be measured`,
      );
    } else if (blob.endEpoch - fromEpoch < asked) {
      const left = Math.max(0, blob.endEpoch - fromEpoch);
      problems.push(
        `Walrus holds it to epoch ${blob.endEpoch}, at most ${left} epoch${left === 1 ? '' : 's'} on from epoch ${fromEpoch} (the latest epoch the publisher reported for it), not the ${asked} asked for`,
      );
    }
  }
  if (blob.deletable === true) {
    problems.push('the blob is deletable: the publisher ignored permanent=true, so the Blob object\'s owner can delete it before it expires');
  }
  if (blob.publisherOutcome === 'alreadyCertified') {
    problems.push(
      `it was already certified, so nothing was bought: it lasts to epoch ${blob.endEpoch ?? 'unknown'} and its Blob object was not made by this store (nor sent to WALRUS_BLOB_OWNER), so a renewal cannot extend it from Splash's address`,
    );
  }
  return problems;
}

export async function storeEncryptedInvoice(encryptedData: string): Promise<WalrusBlob> {
  assertCiphertextOnly(encryptedData);
  if (demoMode()) {
    const blobId = `DEMO_WALRUS_${createHash('sha256').update(encryptedData).digest('hex').slice(0, 24)}`;
    const blob: WalrusBlob = {
      blobId,
      encryptedData,
      sizeBytes: Buffer.byteLength(encryptedData),
      // Held in this process's memory only: no Walrus storage is bought.
      epochs: 0,
      endEpoch: null,
      deletable: null,
      publisherOutcome: null,
      mode: 'demo',
      createdAt: new Date().toISOString(),
    };
    blobs.set(blobId, blob);
    return blob;
  }

  let epochs: number;
  let blob: WalrusBlob;
  let fromEpoch: number | null;
  try {
    // A configuration error is thrown here, before anything is sent.
    epochs = walrusStoreEpochs();
    const response = await fetch(walrusStoreUrl(String(process.env.WALRUS_PUBLISHER_URL)), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: encryptedData,
    });
    if (!response.ok) throw new Error(`publisher returned ${response.status}`);
    const result = (await response.json()) as PublisherResult;
    const blobId =
      result.newlyCreated?.blobObject?.blobId ??
      result.newlyCreated?.blobId ??
      result.alreadyCertified?.blobId ??
      result.blobId;
    if (!blobId) throw new Error('publisher response did not include a blob ID');
    const created = result.newlyCreated?.blobObject;
    const outcome = result.newlyCreated ? 'newlyCreated' : result.alreadyCertified ? 'alreadyCertified' : null;
    fromEpoch = measuredFrom(created);
    blob = {
      blobId,
      encryptedData,
      sizeBytes: Buffer.byteLength(encryptedData),
      epochs,
      endEpoch: epochOrNull(outcome === 'newlyCreated' ? created?.storage?.endEpoch : result.alreadyCertified?.endEpoch),
      deletable: typeof created?.deletable === 'boolean' ? created.deletable : null,
      publisherOutcome: outcome,
      mode: 'live',
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof WalrusAdapterError) throw error;
    throw new WalrusAdapterError(`Walrus publish failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  const problems = retentionShortfalls(blob, epochs, fromEpoch);
  if (problems.length > 0) {
    console.warn(`walrus store: evidence blob ${blob.blobId} may not be retained as asked: ${problems.join('; ')}.`);
  }
  return blob;
}

export async function retrieveBlob(blobId: string): Promise<WalrusBlob | null> {
  if (blobId.startsWith('DEMO_WALRUS_') || demoMode()) {
    return blobs.get(blobId) ?? null;
  }
  const base = process.env.WALRUS_AGGREGATOR_URL;
  // The status a missing aggregator has always answered with is kept; only
  // what the customer is told changes.
  if (!base) throw walrusConfigError('WALRUS_AGGREGATOR_URL is not configured.', 502);
  try {
    const response = await fetch(`${base}/v1/blobs/${encodeURIComponent(blobId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`aggregator returned ${response.status}`);
    const encryptedData = await response.text();
    return {
      blobId,
      encryptedData,
      sizeBytes: Buffer.byteLength(encryptedData),
      // The aggregator returns the bytes only: how long the blob was bought
      // for is not known here, and is not invented.
      epochs: null,
      endEpoch: null,
      mode: 'live',
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new WalrusAdapterError(`Walrus retrieval failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
