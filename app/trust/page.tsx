import type { Metadata } from 'next';

import TrustCompliance from '@/components/compliance/TrustCompliance';
import CopyBlock from '@/components/landing-v2/CopyBlock';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { brand } from '@/lib/brand';

const legalApproved = process.env.LEGAL_APPROVED === 'true';

export const metadata: Metadata = {
  title: `Trust & compliance — ${brand.name}`,
  description:
    'How Splash handles licensing, custody governance, and audit evidence: licensed partners of record today, an explicit licensing path, and Seal-encrypted, Walrus-anchored records.',
  // Draft until counsel signs off — keep the page out of indexes.
  robots: legalApproved ? undefined : { index: false, follow: false },
};

export default function TrustPage() {
  const showDraftWatermark = !legalApproved && process.env.NODE_ENV !== 'production';

  return (
    <SiteShell>
      {showDraftWatermark ? (
        <div className="trust-watermark" aria-hidden="true">
          DRAFT — PENDING COUNSEL REVIEW
        </div>
      ) : null}
      <PageHeader line1="Licensed partners today." line2="Our own licences next." lede="Trust in payments is earned in a specific order: controls first, partners of record second, licences third. This page states exactly where Splash is on that path — nothing more, nothing less." />
      <PageBody>
        <section id="verify" aria-labelledby="verify-title" className="grid gap-4 rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-6 md:grid-cols-[1.2fr_1fr] md:items-center">
          <div>
            <h2 id="verify-title" className="text-[20px] font-semibold">Why we can&apos;t hold your money</h2>
            <p className="mt-2 text-[14px] leading-[1.6] text-[var(--text-2)]">
              The mainnet package, <code className="font-mono">splash_core</code>, carries no <code className="font-mono">Balance&lt;T&gt;</code> and no struct that could hold customer funds. The capability is absent, not gated. Custody code publishes on-chain only when the licence tier permits. Run the check yourself; it fails the build if anything in the core package could hold a balance.
            </p>
          </div>
          <CopyBlock command="npm run check:core" />
        </section>
        <TrustCompliance />
      </PageBody>
    </SiteShell>
  );
}
