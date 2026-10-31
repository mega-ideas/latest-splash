/**
 * What the Wallet page reads first (v2 brief 5.5). Pure: the live wiring is
 * app/api/wallet/overview/route.ts, which takes the business from the session
 * and hands in functions that read only that business.
 *
 * Whatever cannot be read is said so, never guessed. A chain error is logged
 * where it happens and never leaves the server in a sentence a customer sees.
 */

export type WalletState = 'ready' | 'none' | 'pending' | 'unavailable';

export type OverviewDeps = {
  userId: string;
  role: string;
  readAccount(): Promise<{ wallet: string | null; pendingWallet: string | null; nominatedWallet: string | null }>;
  readUsdc?(address: string): Promise<{ coinMinor: bigint; addressBalanceMinor: bigint }>;
  /** USDC a payment may not use: every held or blocked deposit of the business. */
  heldUsdc?(wallet: string, balanceMinor: bigint): Promise<bigint>;
  /** The current wallet's signers as Splash recorded them, or null if it has none on record. */
  signers(): Promise<{ threshold: number; singleSigner: boolean; members: Array<{ userId: string; weight: number }> } | null>;
  /** Display names for members of THIS business only. */
  namesOf(userIds: string[]): Promise<Map<string, string>>;
};

export type WalletOverview = {
  role: string;
  walletState: WalletState;
  wallet: string | null;
  balance: { usdcMinor: string; heldMinor: string; availableMinor: string } | null;
  balanceError: string | null;
  signers: { threshold: number; totalWeight: number; singleSigner: boolean; members: Array<{ name: string; you: boolean; weight: number }> } | null;
  canManage: boolean;
};

const BALANCE_UNREADABLE = 'The balance could not be read from the chain right now. Try again shortly.';

export async function buildWalletOverview(deps: OverviewDeps): Promise<WalletOverview> {
  const base = { role: deps.role, canManage: deps.role === 'OWNER' };
  let account;
  try {
    account = await deps.readAccount();
  } catch {
    return { ...base, walletState: 'unavailable', wallet: null, balance: null, balanceError: null, signers: null };
  }
  if (!account.wallet) {
    const pending = Boolean(account.pendingWallet || account.nominatedWallet);
    return { ...base, walletState: pending ? 'pending' : 'none', wallet: null, balance: null, balanceError: null, signers: null };
  }

  let balance: WalletOverview['balance'] = null;
  let balanceError: string | null = null;
  if (!deps.readUsdc) balanceError = BALANCE_UNREADABLE;
  else {
    try {
      const funds = await deps.readUsdc(account.wallet);
      const total = funds.coinMinor + funds.addressBalanceMinor;
      let held = 0n;
      let known = true;
      try {
        held = deps.heldUsdc ? await deps.heldUsdc(account.wallet, total) : 0n;
      } catch {
        // When holds cannot be read nothing is offered as available.
        known = false;
      }
      const available = known && total > held ? total - held : 0n;
      balance = { usdcMinor: total.toString(), heldMinor: (known ? held : total).toString(), availableMinor: available.toString() };
    } catch {
      balanceError = BALANCE_UNREADABLE;
    }
  }

  let signers: WalletOverview['signers'] = null;
  try {
    const recorded = await deps.signers();
    if (recorded) {
      const names = await deps.namesOf(recorded.members.map((m) => m.userId));
      signers = {
        threshold: recorded.threshold,
        totalWeight: recorded.members.reduce((sum, m) => sum + m.weight, 0),
        singleSigner: recorded.singleSigner,
        members: recorded.members.map((m) => ({ name: names.get(m.userId) ?? 'A signer', you: m.userId === deps.userId, weight: m.weight })),
      };
    }
  } catch {
    signers = null;
  }
  return { ...base, walletState: 'ready', wallet: account.wallet, balance, balanceError, signers };
}
