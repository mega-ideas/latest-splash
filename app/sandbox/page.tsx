import type { Metadata } from 'next';

import CopyBlock from '@/components/landing-v2/CopyBlock';
import { Badge, Button } from '@/components/system';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { FALLBACK_CUSTOMER_EMAIL, FALLBACK_CUSTOMER_PASSWORD } from '@/lib/auth/customer-session';
import { brand } from '@/lib/brand';
import { getNetworkProfile } from '@/lib/network';

export const metadata: Metadata = {
  title: `Sandbox — ${brand.name}`,
  description: 'Try the payment desk with sandbox credentials. Sui testnet, no customer funds.',
};

export const dynamic = 'force-dynamic';

const STEPS = [
  { title: 'Sign in with the sandbox workspace', body: 'The credentials below open a demo organisation with sample balances and recipients. Nothing real moves.' },
  { title: 'Send one payout', body: 'Recipient → amount → review → processing → receipt. Watch the delivery state machine settle on Sui testnet.' },
  { title: `Ask ${brand.agentName} for a proposal`, body: 'It reads state and prepares an unsigned proposal. Approve or reject it in Approvals; that is the only path that moves money.' },
  { title: 'Verify the receipt', body: 'Open the settlement digest on the explorer and share the read-only receipt link.' },
];

export default function SandboxPage() {
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  const { badges } = getNetworkProfile();
  const email = process.env.CUSTOMER_EMAIL || FALLBACK_CUSTOMER_EMAIL;
  const password = process.env.CUSTOMER_PASSWORD || FALLBACK_CUSTOMER_PASSWORD;

  return (
    <SiteShell>
      <PageHeader line1="A sandbox that behaves" line2="exactly like the product." lede="Same screens, same guards, same proofs — on Sui testnet with sample counterparties. No customer funds until MFCA activation.">
        <div className="mt-5">
          <Badge tone="amber">{badges.network}</Badge>
        </div>
      </PageHeader>
      <PageBody>
        <section aria-labelledby="creds-title" className="grid gap-4 rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-6">
          <h2 id="creds-title" className="text-[20px] font-semibold">Sandbox credentials</h2>
          {demo ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">Email</div>
                  <CopyBlock command={email} />
                </div>
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">Password</div>
                  <CopyBlock command={password} />
                </div>
              </div>
              <p className="text-[13px] text-[var(--text-2)]">Shared demo workspace: other visitors may see the same sample data. Do not enter real counterparties.</p>
              <div>
                <Button href="/login?demo=1">Open payment desk</Button>
              </div>
            </>
          ) : (
            <p className="text-[14px] leading-[1.6] text-[var(--text-2)]">
              Sandbox credentials are issued per workspace in this environment. Ask for access at{' '}
              <a href={`mailto:${brand.supportEmail}`} className="text-[var(--teal-600)] underline underline-offset-4">
                {brand.supportEmail}
              </a>
              .
            </p>
          )}
        </section>

        <section aria-labelledby="steps-title" className="grid gap-4">
          <h2 id="steps-title" className="text-[clamp(1.5rem,4vw,1.75rem)] font-semibold tracking-[-0.02em]">
            Four things to try
          </h2>
          <ol className="grid gap-4 md:grid-cols-2">
            {STEPS.map((step, index) => (
              <li key={step.title} className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
                <div className="font-mono text-[12px] font-semibold text-[var(--teal-600)]">0{index + 1}</div>
                <h3 className="mt-2 text-[17px] font-semibold">{step.title}</h3>
                <p className="mt-2 text-[14px] leading-[1.55] text-[var(--text-2)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-[16px] bg-[var(--surface-2)] p-6 text-[14px] leading-[1.6] text-[var(--text-2)]">
          <h2 className="text-[17px] font-semibold text-[var(--text)]">What the sandbox does not do</h2>
          <p className="mt-2">It does not move customer funds, it does not reach a real payout partner, and it does not pay a treasury rate. Balances are sample data with truthful labels (USDC, USD claim, USDY); the treasury position is a projection.</p>
        </section>
      </PageBody>
    </SiteShell>
  );
}
