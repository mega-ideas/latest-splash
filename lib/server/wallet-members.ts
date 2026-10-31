/**
 * Which passkey stands for which owner in the Business Splash Wallet, and
 * who the founder is. Pure: the rows come from Postgres, the account from the
 * chain (lib/server/wallet-deps.ts), so the rules can be tested alone.
 *
 * Founder. The founder is whoever the BusinessAccount names as `owner` on
 * chain, the only address `nominate_wallet` accepts. It is not guessed from
 * the database (a membership nobody granted can be several people, since
 * `grantMembership` defaults `grantedBy` to null).
 *
 * One passkey per owner. Postgres allows one active passkey per person per
 * site (passkey_credentials_active_user_rp_unique, migration 0005), so a
 * person has at most one usable here. A person can still have passkeys on
 * other sites or revoked ones, and those addresses can hold funds: they are
 * listed for detection (`memberWalletAddresses`), never as signers.
 *
 * Nobody is left out silently: an owner without a usable passkey is returned
 * in `missing`, and the wallet is not built until the founder confirms by
 * name that they are excluded (lib/server/business-wallet.ts).
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { WalletCandidate } from '@/lib/server/business-wallet';

export type PasskeyRow = {
  userId: string;
  role: string;
  /** Null when this member has no passkey at all (a left join). */
  publicKey: string | null;
  address: string | null;
  rpId: string | null;
  revokedAt: Date | null;
  createdAt: Date | null;
};

/** Owners who can sign here, and owners who cannot. */
export function pickWalletMembers(
  rows: PasskeyRow[],
  account: { owner: string; owners: string[] },
  rpId: string,
): { candidates: Array<WalletCandidate & { onChainOwner: boolean }>; missing: string[] } {
  const owner = normalizeSuiAddress(account.owner);
  const onChain = new Set(account.owners.map((o) => normalizeSuiAddress(o)));
  const byUser = new Map<string, PasskeyRow[]>();
  for (const r of rows) {
    if (r.role !== 'admin') continue;
    byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  }
  const candidates: Array<WalletCandidate & { onChainOwner: boolean }> = [];
  const missing: string[] = [];
  for (const [userId, list] of [...byUser.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const usable = list
      .filter((r) => r.publicKey && r.address && r.rpId === rpId && r.revokedAt === null)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    // The one that is already the founder's or an owner's key, else the newest.
    const chosen =
      usable.find((r) => normalizeSuiAddress(r.address as string) === owner) ??
      usable.find((r) => onChain.has(normalizeSuiAddress(r.address as string))) ??
      usable[0];
    if (!chosen) {
      missing.push(userId);
      continue;
    }
    const address = normalizeSuiAddress(chosen.address as string);
    candidates.push({ userId, publicKey: chosen.publicKey as string, address, founder: address === owner, onChainOwner: onChain.has(address) });
  }
  return { candidates, missing };
}

/**
 * Every address a member of the org has held funds under: each of their
 * passkeys, on any site, revoked or not. `canSign` is true only for the one
 * active passkey on this site, the only one that can sign a transfer here.
 */
export function memberWalletAddresses(
  rows: PasskeyRow[],
  rpId: string,
): Array<{ userId: string; address: string; publicKey: string; canSign: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ userId: string; address: string; publicKey: string; canSign: boolean }> = [];
  for (const r of rows) {
    if (!r.publicKey || !r.address) continue;
    const address = normalizeSuiAddress(r.address);
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({ userId: r.userId, address, publicKey: r.publicKey, canSign: r.rpId === rpId && r.revokedAt === null });
  }
  return out;
}
