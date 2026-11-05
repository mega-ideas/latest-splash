/**
 * The Business Splash Wallet's multisig (v2, D1).
 *
 * A business wallet is a Sui native multisig whose members are the owners'
 * passkeys. This module turns the owners' enrolled passkey public keys into
 * that multisig, with the same rules `splash_core::multisig` applies on chain,
 * so a wallet the dashboard proposes is never refused at registration for a
 * reason the server could have seen first:
 *
 *   - 1 to 10 members, no key twice, every weight a whole number 1..255;
 *   - a threshold of at least 1 and no more than the sum of the weights;
 *   - "single-signer" means any ONE member's weight reaches the threshold
 *     (`multisig::is_single_signer`), not just `threshold < 2`.
 *
 * D1: the default is 2-of-N with every member weighted 1. A wallet one person
 * can sign for alone is built only when the business has chosen it
 * (`singleSignerChosen`), and then `register_wallet` carries the wallet's own
 * acknowledgement (`single_signer_ack = true`), signed by that wallet.
 *
 * Isomorphic: the server builds the wallet, and a signer's device can rebuild
 * it from the same keys to check the address it is about to register.
 *
 * zkLogin members (the D1 fallback) are not built here yet. A zkLogin member's
 * partial signature carries a zero-knowledge proof that has to be fetched per
 * epoch; that path is listed as open in docs/v2/phase2-business-wallet.md.
 */
import { PasskeyPublicKey } from '@mysten/sui/keypairs/passkey';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

/** Sui's own bound on multisig members. */
export const MAX_WALLET_MEMBERS = 10;
/** The default threshold (D1): two owners sign. */
export const DEFAULT_WALLET_THRESHOLD = 2;

export class BusinessWalletError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'BusinessWalletError';
    this.code = code;
  }
}

/** One owner's passkey, as `passkey_credentials` stores it. */
export type WalletMemberInput = {
  userId: string;
  /** 33-byte compressed secp256r1 point, base64. */
  publicKey: string;
  /** Defaults to 1. */
  weight?: number;
};

export type WalletMember = {
  userId: string;
  /** The member's own Sui address: blake2b256(0x06 || key). It must be an
   *  owner of the BusinessAccount, or `register_wallet` aborts (E_SIGNER_NOT_AN_OWNER). */
  address: string;
  /** flag || key, base64: what `register_wallet`'s `keys` carries. */
  suiPublicKey: string;
  weight: number;
};

export type BusinessMultisig = {
  address: string;
  threshold: number;
  members: WalletMember[];
  singleSigner: boolean;
  /** MultiSigPublicKey.toRawBytes(), base64: enough to rebuild the key and
   *  to combine partial signatures later. */
  multisigPublicKey: string;
};

function passkeyFromBase64(publicKey: string): PasskeyPublicKey {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(publicKey);
  } catch {
    throw new BusinessWalletError('a member passkey is not valid base64', 'bad_public_key');
  }
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
    throw new BusinessWalletError('a member passkey is not a 33-byte compressed secp256r1 key', 'bad_public_key');
  }
  return new PasskeyPublicKey(bytes);
}

/** Any one member's weight reaches the threshold: splash_core::multisig::is_single_signer. */
export function isSingleSigner(weights: readonly number[], threshold: number): boolean {
  return weights.some((w) => w >= threshold);
}

/**
 * The business wallet for these owners.
 *
 * `threshold` defaults to 2 (D1). With one member, or a threshold one member
 * reaches, the wallet is single-signer, which is refused unless the business
 * explicitly chose it.
 */
export function buildBusinessMultisig(input: {
  members: readonly WalletMemberInput[];
  threshold?: number;
  singleSignerChosen?: boolean;
}): BusinessMultisig {
  const members = input.members;
  if (members.length < 1) throw new BusinessWalletError('a business wallet needs at least one owner passkey', 'no_members');
  if (members.length > MAX_WALLET_MEMBERS) {
    throw new BusinessWalletError(`a business wallet can have at most ${MAX_WALLET_MEMBERS} members`, 'too_many_members');
  }

  const seenUsers = new Set<string>();
  const seenKeys = new Set<string>();
  const built = members.map((m) => {
    if (seenUsers.has(m.userId)) throw new BusinessWalletError('an owner is listed twice', 'duplicate_member');
    seenUsers.add(m.userId);
    const key = passkeyFromBase64(m.publicKey);
    const raw = toBase64(key.toRawBytes());
    if (seenKeys.has(raw)) throw new BusinessWalletError('one passkey is listed for two members', 'duplicate_key');
    seenKeys.add(raw);
    const weight = m.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1 || weight > 255) {
      throw new BusinessWalletError('a member weight must be a whole number from 1 to 255', 'bad_weight');
    }
    return { userId: m.userId, key, weight };
  });

  const weights = built.map((b) => b.weight);
  const total = weights.reduce((a, b) => a + b, 0);
  const threshold = input.threshold ?? Math.min(DEFAULT_WALLET_THRESHOLD, total);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > total || threshold > 0xffff) {
    throw new BusinessWalletError(`the threshold must be from 1 to ${total}`, 'bad_threshold');
  }

  const singleSigner = isSingleSigner(weights, threshold);
  if (singleSigner && input.singleSignerChosen !== true) {
    throw new BusinessWalletError(
      'one owner could sign for this wallet alone. Splash builds a wallet like that only when the business chooses it; otherwise add a second owner passkey.',
      'single_signer_not_chosen',
    );
  }

  const multisig = MultiSigPublicKey.fromPublicKeys({
    threshold,
    publicKeys: built.map((b) => ({ publicKey: b.key, weight: b.weight })),
  });

  return {
    address: multisig.toSuiAddress(),
    threshold,
    singleSigner,
    multisigPublicKey: toBase64(multisig.toRawBytes()),
    members: built.map((b) => ({
      userId: b.userId,
      address: b.key.toSuiAddress(),
      suiPublicKey: toBase64(b.key.toSuiBytes()),
      weight: b.weight,
    })),
  };
}

/** Rebuild the multisig key a request was created with. */
export function multisigFromBase64(raw: string): MultiSigPublicKey {
  return new MultiSigPublicKey(fromBase64(raw));
}

/** The `keys`, `weights` and `threshold` arguments `register_wallet` and
 *  `rotate_wallet` take, in member order. */
export function registrationArgs(wallet: BusinessMultisig): { keys: Uint8Array[]; weights: number[]; threshold: number } {
  return {
    keys: wallet.members.map((m) => fromBase64(m.suiPublicKey)),
    weights: wallet.members.map((m) => m.weight),
    threshold: wallet.threshold,
  };
}
