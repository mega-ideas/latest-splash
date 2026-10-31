'use client';

import { useCallback, useState } from 'react';
import { Lock, RefreshCw } from 'lucide-react';

import DashPageHeader from '@/components/dashboard/DashPageHeader';
import { QuietButton } from '@/components/transfer/ui';
import WalletActivity from '@/components/stablecoin/WalletActivity';
import type { GovernanceBannerAlert } from '@/lib/server/governance-events';
import AddFunds from './AddFunds';
import AlertsCard from './AlertsCard';
import BalanceCard from './BalanceCard';
import FundingHistory from './FundingHistory';
import FundingSources from './FundingSources';
import Migration from './Migration';
import RulesCard from './RulesCard';
import SetupWallet from './SetupWallet';
import SignersCard from './SignersCard';
import SigningInbox from './SigningInbox';
import Withdraw from './Withdraw';
import { Card, Loading, Note, useLoad } from './parts';
import type { FundingOptions, Overview } from './types';

/**
 * Wallet (v2 brief 5.5), built from the Send USDC page and keeping its look:
 * the same blocks, tokens and spacing. Sending a payment is Transfer's;
 * USDY is Treasury's. This page is the business's own wallet: its balance,
 * how money gets in (Add funds) and out to its own bank (Withdraw), where it
 * may come from (funding sources), what happened, who signs, the spending
 * rules, and what Splash has announced.
 *
 * Whatever cannot be read is said so, never guessed. Every section reads
 * the signed-in person's own business only; none takes a business, a wallet
 * or an address from the page.
 */
export default function WalletPage({ alerts }: { alerts: GovernanceBannerAlert[] }) {
  const overview = useLoad<Overview>('/api/wallet/overview', 'Your wallet could not be loaded.');
  const ready = overview.data?.walletState === 'ready';
  const funding = useLoad<FundingOptions>(ready ? '/api/wallet/funding' : null, 'Your funding options could not be loaded.');
  const [version, setVersion] = useState(0);
  const { reload: reloadOverview } = overview;
  const { reload: reloadFunding } = funding;
  const changed = useCallback(() => {
    reloadOverview();
    reloadFunding();
    setVersion((v) => v + 1);
  }, [reloadOverview, reloadFunding]);

  const header = (
    <DashPageHeader
      kicker="USDC on Sui · mainnet"
      title="Wallet"
      description="Your business’s USDC, held in a wallet your owners sign for. Splash has no key to it. To pay someone, use Transfer."
    />
  );

  if (overview.loading) return <Frame>{header}<Loading label="Reading your wallet…" /></Frame>;
  if (!overview.data) {
    return (
      <Frame>
        {header}
        <Note tone="error">{overview.error}</Note>
        <div><QuietButton type="button" onClick={overview.reload}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton></div>
      </Frame>
    );
  }
  const o = overview.data;
  const owner = o.role === 'OWNER';

  if (o.walletState === 'off') {
    return (
      <Frame>
        {header}
        <div role="status" className="flex items-start gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4 text-sm text-[#1F4452]">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />
          <span>Business wallets are not open for your workspace yet. Nothing has been changed, and your Splash contact will tell you when they are.</span>
        </div>
      </Frame>
    );
  }
  if (o.walletState === 'unavailable') {
    return (
      <Frame>
        {header}
        <Note tone="error">Splash could not reach the chain to read your wallet. Nothing was changed.</Note>
        <div><QuietButton type="button" onClick={overview.reload}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton></div>
      </Frame>
    );
  }
  if (o.walletState === 'none' || o.walletState === 'pending') {
    return (
      <Frame>
        {header}
        <SigningInbox onChanged={changed} />
        {o.walletState === 'pending' ? (
          <Card id="wallet-pending" title="Your business wallet is being set up">
            <Note>The first step is signed. Each owner signs the next on their own device; it is under Needs your signature on their Wallet page. When enough owners have signed, this page shows your balance.</Note>
          </Card>
        ) : owner ? (
          <SetupWallet onChanged={changed} />
        ) : (
          <Card id="no-wallet" title="No business wallet yet"><Note>An owner creates the business wallet. You will see it here when it exists.</Note></Card>
        )}
      </Frame>
    );
  }

  const fundingReady = funding.data;
  return (
    <Frame>
      {header}
      <SigningInbox onChanged={changed} />
      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <BalanceCard overview={o} />
          {fundingReady ? (
            <AddFunds funding={fundingReady} canAdd={o.role !== 'VIEWER'} onChanged={changed} />
          ) : (
            <Card id="top-up" title="Add funds">{funding.error ? <Note tone="error">{funding.error}</Note> : <Loading label="Loading…" />}</Card>
          )}
          <Withdraw canAsk={o.role === 'OWNER' || o.role === 'MAKER' || o.role === 'APPROVER'} owner={owner} onChanged={changed} />
          <FundingHistory refreshKey={version} />
          {fundingReady ? <FundingSources funding={fundingReady} owner={owner} onChanged={changed} /> : null}
          {o.wallet ? <WalletActivity address={o.wallet} splash={false} refreshKey={version} /> : null}
        </div>
        <aside className="space-y-4">
          <SignersCard overview={o} onChanged={changed} />
          <RulesCard owner={owner} />
          <Migration onChanged={changed} />
          <AlertsCard alerts={alerts} owner={owner} />
        </aside>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl space-y-5">{children}</div>;
}
