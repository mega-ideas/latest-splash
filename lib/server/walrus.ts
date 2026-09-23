/**
 * Walrus stores ciphertext only. Plaintext PII, bank details, and KYC data must
 * never be sent to the publisher.
 */
import { createHash } from 'node:crypto';

export interface WalrusBlob {
  blobId: string;
  encryptedData: string;
  sizeBytes: number;
  epochs: number;
  mode: 'demo' | 'live';
  createdAt: string;
}

export class WalrusAdapterError extends Error {
  // A plain field rather than a constructor parameter property: the Node test
  // runner strips types only, and a parameter property is a transform.
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
    this.name = 'WalrusAdapterError';
  }
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

export async function storeEncryptedInvoice(encryptedData: string): Promise<WalrusBlob> {
  assertCiphertextOnly(encryptedData);
  if (demoMode()) {
    const blobId = `DEMO_WALRUS_${createHash('sha256').update(encryptedData).digest('hex').slice(0, 24)}`;
    const blob: WalrusBlob = {
      blobId,
      encryptedData,
      sizeBytes: Buffer.byteLength(encryptedData),
      epochs: 5,
      mode: 'demo',
      createdAt: new Date().toISOString(),
    };
    blobs.set(blobId, blob);
    return blob;
  }

  try {
    const response = await fetch(`${process.env.WALRUS_PUBLISHER_URL}/v1/blobs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: encryptedData,
    });
    if (!response.ok) throw new Error(`publisher returned ${response.status}`);
    const result = (await response.json()) as {
      newlyCreated?: { blobObject?: { blobId?: string }; blobId?: string };
      alreadyCertified?: { blobId?: string };
      blobId?: string;
    };
    const blobId =
      result.newlyCreated?.blobObject?.blobId ??
      result.newlyCreated?.blobId ??
      result.alreadyCertified?.blobId ??
      result.blobId;
    if (!blobId) throw new Error('publisher response did not include a blob ID');
    return {
      blobId,
      encryptedData,
      sizeBytes: Buffer.byteLength(encryptedData),
      epochs: 5,
      mode: 'live',
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new WalrusAdapterError(`Walrus publish failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export async function retrieveBlob(blobId: string): Promise<WalrusBlob | null> {
  if (blobId.startsWith('DEMO_WALRUS_') || demoMode()) {
    return blobs.get(blobId) ?? null;
  }
  const base = process.env.WALRUS_AGGREGATOR_URL;
  if (!base) throw new WalrusAdapterError('WALRUS_AGGREGATOR_URL is not configured.');
  try {
    const response = await fetch(`${base}/v1/blobs/${encodeURIComponent(blobId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`aggregator returned ${response.status}`);
    const encryptedData = await response.text();
    return {
      blobId,
      encryptedData,
      sizeBytes: Buffer.byteLength(encryptedData),
      epochs: 5,
      mode: 'live',
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new WalrusAdapterError(`Walrus retrieval failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
