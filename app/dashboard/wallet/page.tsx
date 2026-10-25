import SendUsdcDesk from '@/components/stablecoin/SendUsdcDesk';

export const dynamic = 'force-dynamic';

/**
 * Wallet (v2 brief 5.5), built from the Send USDC page and keeping its look.
 * Section 5.5 adds balances, Add funds, Withdraw, signers and spending rules
 * here; sending itself moves into Transfer (5.4).
 */
export default function WalletPage() {
  return <SendUsdcDesk />;
}
