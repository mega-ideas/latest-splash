/**
 * What Settings offers for the state the business wallet is in (v2 brief 5.9).
 * With no wallet there is no team to give rules to, no signers, no funding
 * sources and no request to sign, so the page says so once and shows only what
 * does not need a wallet. A request waiting for an owner's signature is shown
 * while the wallet is being set up, because setting it up is a signature.
 * Pure and client-safe.
 */
export type WalletState = 'ready' | 'none' | 'pending' | 'unavailable' | 'off';

export type SettingsWallet = {
  /** Show "Needs your signature". */
  inbox: boolean;
  /** Read and offer the team, the policy, the rules, the signers and the funding sources. */
  manage: boolean;
  /** What the one note says, or null when there is nothing to say. */
  note: 'loading' | 'pending' | 'none' | 'off' | 'unavailable' | null;
};

export function settingsWallet(state: WalletState | undefined): SettingsWallet {
  if (state === undefined) return { inbox: false, manage: false, note: 'loading' };
  if (state === 'ready') return { inbox: true, manage: true, note: null };
  if (state === 'pending') return { inbox: true, manage: false, note: 'pending' };
  return { inbox: false, manage: false, note: state };
}
