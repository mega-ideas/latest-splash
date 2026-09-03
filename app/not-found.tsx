import Link from 'next/link';

import PostureFooter from '@/components/brand/PostureFooter';
import Wordmark from '@/components/brand/Wordmark';
import { NotFoundScene } from '@/components/illustrations/iso';
import { Button } from '@/components/system';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col bg-[var(--paper)] px-4 py-8 text-[var(--text)] md:px-8">
      <Wordmark />
      <div className="mx-auto grid w-full max-w-[560px] flex-1 content-center justify-items-center gap-6 py-12 text-center">
        <div className="w-full max-w-[420px]">
          <NotFoundScene decorative />
        </div>
        <div className="grid gap-2">
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">This page is not on the ledger.</h1>
          <p className="max-w-[48ch] text-[15px] leading-[1.55] text-[var(--text-2)]">The link may have expired or moved. Nothing in flight is affected: every settlement keeps its receipt.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button href="/">Back to Splash</Button>
          <Button href="/dashboard" variant="ghost">Open the desk</Button>
        </div>
        <Link href="/trust" className="text-[13px] text-[var(--teal-600)] underline underline-offset-4">Trust &amp; compliance</Link>
      </div>
      <div className="border-t border-[var(--divider)] pt-4 text-[var(--text-2)]"><PostureFooter /></div>
    </main>
  );
}
