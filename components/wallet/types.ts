/** What GET /api/wallet/overview answers (lib/server/wallet-overview.ts), as the page reads it. */
export type Overview = {
  role: string;
  walletState: 'ready' | 'none' | 'pending' | 'unavailable' | 'off';
  wallet: string | null;
  balance: { usdcMinor: string; heldMinor: string; availableMinor: string } | null;
  balanceError: string | null;
  signers: { threshold: number; totalWeight: number; singleSigner: boolean; members: Array<{ name: string; you: boolean; weight: number }> } | null;
  canManage: boolean;
};

export type FundingSource = {
  id: string;
  kind: 'bank_account' | 'card' | 'wallet';
  label: string;
  status: string;
  last4: string | null;
  chain: string | null;
  address: string | null;
  provider: string | null;
  verifiedAt: string | null;
};

/** GET /api/wallet/funding. */
export type FundingOptions = {
  wallet: string;
  channels: {
    provider: Array<{ id: string; label: string; methods: string[]; available: boolean; reason: string | null }>;
    wallet: { address: string; assets: Array<{ asset: string; converts: boolean }> };
    cctp: { chains: Array<{ chain: string; label: string; fast: boolean }> };
    swap: { routes: Array<{ id: string; label: string }> };
  };
  sources: FundingSource[];
  heldMinor: string;
};

export type Deposit = {
  id: string;
  digest: string;
  asset: string;
  amountMinor: string;
  status: string;
  holdReasons: string[];
  arrivedAt: string | null;
  sourceId: string | null;
};
