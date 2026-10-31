/**
 * What a signer's own device shows before it signs (review item B10).
 *
 * The server sends a request's exact bytes with its own decoding of them.
 * A compromised server could send bytes and a decoding that disagree, so the
 * signing screen must not render the server's decoding. It runs this on the
 * bytes it received, renders only what comes back, and signs those bytes:
 *
 *   - the bytes are decoded here, with the same reader the server uses
 *     (lib/wallet/wallet-tx-describe.ts), so payee, amount, asset, fee bound
 *     and rate are read from the transaction itself;
 *   - the digest and the content hash are computed here from the bytes, and
 *     must equal what the request claims, or nothing is shown.
 *
 * The transaction code a person compares between WhatsApp and the signing
 * screen is 16 hex characters (64 bits) of that hash, in four groups.
 *
 * Isomorphic: no server import, no network. The Phase 3 signing screen calls
 * `reviewOnDevice` on the request it fetched.
 */
import {
  describeWalletTransaction,
  walletTxDigest,
  WalletTxRefused,
  type WalletTxDescription,
  type WalletTxExpectations,
} from './wallet-tx-describe.ts';

/** 16 hex characters of the bytes' blake2b hash, as `abcd efgh ijkl mnop`. */
export function transactionCode(bytesHash: string): string {
  const head = bytesHash.slice(0, 16).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(head)) throw new WalletTxRefused('not a transaction hash', 'bad_hash');
  return head.match(/.{4}/g)!.join(' ');
}

export type DeviceReview = WalletTxDescription & { code: string };

/**
 * Decode a request on the device. Throws WalletTxRefused if the bytes do not
 * decode, or if their digest or hash is not the one the request names.
 */
export function reviewOnDevice(request: {
  transactionBytes: string;
  digest: string;
  bytesHash: string;
  expect: WalletTxExpectations;
}): DeviceReview {
  const computed = walletTxDigest(Uint8Array.from(atob(request.transactionBytes), (c) => c.charCodeAt(0)));
  if (computed.digest !== request.digest || computed.bytesHash !== request.bytesHash) {
    throw new WalletTxRefused('the transaction code does not match its bytes; do not sign it', 'digest_mismatch');
  }
  const description = describeWalletTransaction(request.transactionBytes, request.expect);
  return { ...description, code: transactionCode(description.bytesHash) };
}
