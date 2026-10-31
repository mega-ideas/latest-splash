'use client';

import Link from 'next/link';
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, ShieldCheck } from 'lucide-react';

import { formatUsdc } from '@/lib/fees/copy';
import { Address, CopyButton, Note } from './parts';
import type { Overview } from './types';

/**
 * The business wallet's balance (v2 brief 5.5), read from Sui: USDC held by
 * the business, what is on hold and so not spendable, and what can be paid.
 * "Held by the business" is literal: Splash has no key to this wallet.
 */
export default function BalanceCard({ overview }: { overview: Overview }) {
  const b = overview.balance;
  const unknown = Boolean(b?.holdsUnknown);
  const held = b && !unknown ? BigInt(b.heldMinor) : 0n;
  return (
    <section className="dash-block dash-block-accent p-4 sm:p-5" aria-labelledby="balance-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="balance-title" className="dash-kicker">Splash Wallet balance</h2>
          <p className="mt-2 font-mono text-3xl font-bold tabular-nums text-[#0c3e48]">
            {b ? formatUsdc(BigInt(b.availableMinor)) : 'Not available'}
            {b ? <span className="ml-2 text-sm font-medium text-[#326273]">USDC to spend</span> : null}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#6FB4A0]/15 px-3 py-1.5 text-[12px] font-semibold text-[#0c3e48]">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Held by your business
        </span>
      </div>
      {overview.balanceError ? <div className="mt-3"><Note tone="error">{overview.balanceError}</Note></div> : null}
      {b ? (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] tabular-nums text-[#326273] sm:grid-cols-2">
          <div className="flex justify-between gap-3"><dt>In the wallet</dt><dd className="font-mono font-semibold text-[#0c3e48]">{formatUsdc(BigInt(b.usdcMinor))} USDC</dd></div>
          {unknown ? (
            <div className="flex justify-between gap-3"><dt>On hold</dt><dd className="font-semibold text-[#0c3e48]">Could not be checked</dd></div>
          ) : (
            <div className="flex justify-between gap-3"><dt>On hold, not spent</dt><dd className="font-mono font-semibold text-[#0c3e48]">{formatUsdc(held)} USDC</dd></div>
          )}
        </dl>
      ) : null}
      {unknown ? (
        <p className="mt-2 text-[13px] leading-5 text-[#326273]">Money on hold could not be checked just now, so nothing is offered to spend. Try again shortly.</p>
      ) : null}
      {held > 0n ? (
        <p className="mt-2 text-[13px] leading-5 text-[#326273]">
          Money that arrives is screened first. Held money is not spent until it clears.{' '}
          <a href="#funding-history" className="font-semibold text-[var(--info)] underline underline-offset-2">See why</a>
        </p>
      ) : null}
      {overview.wallet ? (
        <div className="mt-4 rounded-xl bg-[#F6F0ED]/70 p-3">
          <p className="text-[12px] font-semibold text-[#326273]">Wallet address on Sui</p>
          <div className="mt-1 flex items-center gap-2">
            <Address value={overview.wallet} />
            <CopyButton value={overview.wallet} label="Copy the wallet address" />
          </div>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <a href="#top-up" className="dash-btn inline-flex min-h-11 items-center !px-4 !py-2 !text-[13px]"><ArrowDownToLine className="h-4 w-4" aria-hidden="true" />Add funds</a>
        <a href="#withdraw" className="dash-btn-ghost inline-flex min-h-11 items-center !px-4 !py-2 !text-[13px]"><ArrowUpFromLine className="h-4 w-4" aria-hidden="true" />Withdraw to your bank</a>
        <Link href="/dashboard/transfer" className="dash-btn-ghost inline-flex min-h-11 items-center !px-4 !py-2 !text-[13px]">Send a payment<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
      </div>
    </section>
  );
}
