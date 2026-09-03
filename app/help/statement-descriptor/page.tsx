import type { Metadata } from 'next';
import Link from 'next/link';

import PostureFooter from '@/components/brand/PostureFooter';
import SandboxRibbon from '@/components/brand/SandboxRibbon';
import Wordmark from '@/components/brand/Wordmark';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Why does my bank statement show the partner?',
  description: 'Local payouts are issued by a licensed payout partner on its own licence; the statement shows the partner as sender and your reference in the description.',
};

export default function StatementDescriptorHelp() {
  return (
    <main className="min-h-screen bg-[var(--paper)] text-[var(--text)]">
      <SandboxRibbon />
      <div className="mx-auto max-w-[68ch] px-4 py-10 md:px-8">
        <Wordmark />
        <h1 className="mt-8 text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Why does the bank statement show the partner&apos;s name?</h1>
        <div className="mt-6 grid gap-4 text-[16px] leading-[1.6] text-[var(--text-2)]">
          <p>
            {brand.name} settles your payment on Sui in one atomic transaction and hands the delivery leg to a licensed payout partner in the destination country. That partner issues the local bank transfer on its own licence, so the supplier&apos;s bank statement shows the partner&apos;s legal name as the sender.
          </p>
          <p>
            Your payment reference travels with the transfer and appears in the statement description, which is how the supplier matches the deposit to your invoice. The receipt you share from the desk names the partner and carries the same reference and the on-chain settlement digest.
          </p>
          <p>
            {brand.name} never holds the funds: the partner is the system of record for the local leg, and the Sui digest is the proof of settlement you can verify independently. Partner legal names are shown to the transaction parties only.
          </p>
          <p>
            Something on the statement does not match your receipt? Open the receipt from Receipts, compare the reference, and contact support from the desk with the receipt link.
          </p>
        </div>
        <p className="mt-8 text-[14px]">
          <Link href="/trust" className="text-[var(--teal-600)] underline underline-offset-4">
            Trust &amp; compliance
          </Link>
        </p>
        <div className="mt-12 border-t border-[var(--divider)] pt-6 text-[var(--text-2)]">
          <PostureFooter />
        </div>
      </div>
    </main>
  );
}
