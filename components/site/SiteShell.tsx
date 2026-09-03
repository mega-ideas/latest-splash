import type { ReactNode } from 'react';

import SandboxRibbon from '@/components/brand/SandboxRibbon';
import Footer from '@/components/landing-v2/Footer';
import LandingNav from '@/components/landing-v2/LandingNav';
import { container, TwoTone } from '@/components/landing-v2/ui';
import { cn } from '@/lib/utils';

/** Public page chrome: the landing's nav and footer around a titled page. */
export function SiteShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="min-h-dvh bg-[var(--paper)] text-[var(--text)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--r-sm)] focus:bg-[var(--surface)] focus:px-3 focus:py-2">
        Skip to content
      </a>
      <SandboxRibbon />
      <LandingNav />
      <main id="main" className={cn('pb-16 md:pb-24', className)}>
        {children}
      </main>
      <Footer />
    </div>
  );
}

export function PageHeader({ line1, line2, lede, children }: { line1: string; line2?: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <header className={cn(container, 'pb-10 pt-10 md:pb-14 md:pt-16')}>
      <TwoTone as="h1" id="page-title" size="display" line1={line1} line2={line2} />
      {lede ? <p className="mt-5 max-w-[62ch] text-[17px] leading-[1.55] text-[var(--text-2)]">{lede}</p> : null}
      {children}
    </header>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(container, 'grid gap-10', className)}>{children}</div>;
}
