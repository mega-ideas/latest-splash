'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';

import { formatUsdcMinor } from '@/lib/dashboard/home';
import { Figure, FigureSkeleton } from './parts';
import type { WalletState } from './wallet-state';

/** "Your own passkey wallet holds 12.50 USDC." Theirs, never the business's. */
function PasskeyLine({ minor }: { minor: string | null }) {
  if (minor === null) return null;
  return (
    <>
      Your own passkey wallet holds <span className="dash-num font-semibold text-[#1F4452]">{formatUsdcMinor(minor)} USDC</span>.{' '}
    </>
  );
}

function OpenWalletLink() {
  return (
    <Link href="/dashboard/wallet" className="font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
      Open Wallet
    </Link>
  );
}

/**
 * What the Splash Wallet card says, for the desktop card and the phone's
 * balance alike. Only a failed read offers Try again: no wallet yet, one being
 * set up, wallets switched off on this server and no access each stay true
 * until something else changes, and a retry would only show the same thing.
 */
export default function WalletBody({ wallet, onRetry, large = false }: { wallet: WalletState; onRetry: () => void; large?: boolean }) {
  if (wallet.kind === 'loading') return <FigureSkeleton />;
  if (wallet.kind === 'business') {
    return (
      <>
        <Figure value={formatUsdcMinor(wallet.usdcMinor)} unit="USDC" large={large} />
        <p className="mt-1 text-[13px] font-medium text-[#326273]">Held by your business</p>
      </>
    );
  }
  if (wallet.kind === 'none') {
    return (
      <>
        <p className="mt-2 text-lg font-bold text-[#0c3e48]">No business wallet yet</p>
        <p className="mt-1 text-[13px] font-medium text-[#326273]">
          <PasskeyLine minor={wallet.passkeyUsdcMinor} />
          <OpenWalletLink />
        </p>
      </>
    );
  }
  if (wallet.kind === 'pending') {
    return (
      <>
        <p className="mt-2 text-lg font-bold text-[#0c3e48]">Wallet being set up</p>
        <p className="mt-1 text-[13px] font-medium text-[#326273]">
          Waiting for the owners to sign. <PasskeyLine minor={wallet.passkeyUsdcMinor} />
          <OpenWalletLink />
        </p>
      </>
    );
  }
  if (wallet.kind === 'off' || wallet.kind === 'no_access') {
    return (
      <>
        <p className="mt-2 text-lg font-bold text-[#0c3e48]">Business wallet not available</p>
        <p className="mt-1 text-[13px] font-medium text-[#326273]">
          {wallet.kind === 'off' ? (
            <>
              Splash hasn&rsquo;t switched business wallets on for this workspace. <PasskeyLine minor={wallet.passkeyUsdcMinor} />
            </>
          ) : (
            <>Your membership doesn&rsquo;t cover this business&rsquo;s wallet. Ask an owner. </>
          )}
          <OpenWalletLink />
        </p>
      </>
    );
  }
  return (
    <>
      <p className="mt-2 text-lg font-bold text-[#0c3e48]">Balance unavailable</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] font-medium text-[#326273]" role="status">
        We couldn&rsquo;t read it from Sui.
        <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
          <RefreshCw size={13} aria-hidden="true" />
          Try again
        </button>
      </p>
    </>
  );
}
