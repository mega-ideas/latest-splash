import type { ReactNode } from 'react';

import SandboxRibbon from '@/components/brand/SandboxRibbon';
import Wordmark from '@/components/brand/Wordmark';
import { EmptyState as IsoScene } from '@/components/illustrations/iso';
import { brand } from '@/lib/brand';
import { getNetworkProfile } from '@/lib/network';

/**
 * Auth shell on the design system: form on the left, a quiet isometric
 * scene and the posture line on the right (hidden below lg). Replaces the
 * raster IsometricAuthShell for the login flow.
 */
export default function AuthShell({ title, description, children, aside }: { title: string; description: string; children: ReactNode; aside?: ReactNode }) {
  const { badges } = getNetworkProfile();
  return (
    <div className="min-h-dvh bg-[var(--paper)] text-[var(--text)]">
      <SandboxRibbon />
      <div className="mx-auto grid min-h-[calc(100dvh-2.5rem)] w-full max-w-[1200px] lg:grid-cols-12">
        <main className="flex flex-col px-5 py-8 md:px-8 lg:col-span-6 lg:py-12">
          <Wordmark size={28} />
          <div className="my-auto w-full max-w-[420px] py-10">
            <h1 className="text-[clamp(1.875rem,5vw,2.5rem)] font-semibold leading-[1.1] tracking-[-0.02em]">{title}</h1>
            <p className="mt-3 text-[15px] leading-[1.55] text-[var(--text-2)]">{description}</p>
            <div className="mt-8">{children}</div>
          </div>
          <p className="text-[12px] text-[var(--text-muted)]">{brand.postureLine}</p>
        </main>
        <aside className="hidden lg:col-span-6 lg:flex lg:flex-col lg:justify-center lg:gap-6 lg:border-l lg:border-[var(--divider)] lg:bg-[var(--surface)] lg:p-12" aria-label="About the workspace">
          <IsoScene kind="settlements" decorative className="mx-auto h-auto w-full max-w-[420px]" />
          <div className="text-center">
            <p className="text-[17px] font-semibold">{brand.agentName} prepares. You approve.</p>
            <p className="mt-1 text-[14px] text-[var(--text-2)]">Every payout settles atomically on Sui and leaves a receipt you can verify.</p>
            <p className="mt-4 font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{badges.live ?? badges.network}</p>
          </div>
          {aside}
        </aside>
      </div>
    </div>
  );
}
