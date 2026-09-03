import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import Footer from '@/components/landing-v2/Footer';
import { Button } from '@/components/system';
import { brand } from '@/lib/brand';
import { formatAmount, formatMoney } from '@/lib/money';
import { routeAlternatives } from '@/lib/payments/clearance';
import { cn } from '@/lib/utils';

import ClearanceNav from './ClearanceNav';
import ClearanceStrip, { type StripData } from './ClearanceStrip';

const container = 'mx-auto w-full max-w-[1200px] px-5 md:px-8';

const SEND_USD = 5000;

function stripData(): StripData {
  const comparison = routeAlternatives('PHP', SEND_USD);
  const partner = comparison.rows[0];
  return {
    id: 'CLR-2026-0903-0142',
    sendUsd: SEND_USD,
    delivered: partner.delivered,
    currency: 'PHP',
    feeUsd: partner.feeUsd,
    feePct: partner.feePct,
    rate: partner.delivered / (SEND_USD - partner.feeUsd),
    effective: partner.delivered / SEND_USD,
  };
}

const PROOF = [
  'Sui Overflow 2026 · Top 4, DeFi & Payments',
  'Sandbox · no customer funds until MFCA activation',
  'Labuan FSA licensing in process · BNM MSB and BSP planned',
  'Settlement finality ~400 ms on Sui',
];

const MODEL = [
  { title: 'Observe real conditions', body: 'Liquidity, FX, fees, limits, compliance and partner health, read from the systems of record rather than typed in.' },
  { title: 'Clear the best compliant path', body: 'Every eligible route compared on delivered amount, timing, reliability and policy outcome, with the reasons attached.' },
  { title: 'Prove final settlement', body: 'Partner confirmation, internal ledger and network receipt matched to one outcome, with the evidence kept.' },
];

const CORRIDORS = [
  { code: 'USD → PHP', city: 'Manila', state: 'Sandbox', note: 'Regulated partner rail · same day', tone: 'verified' },
  { code: 'USD → IDR', city: 'Jakarta', state: 'Staged', note: 'Partner controls in activation', tone: 'attention' },
  { code: 'USD → MYR', city: 'Kuala Lumpur', state: 'Modelled', note: 'Pricing modelled · not executable', tone: 'muted' },
  { code: 'USD → SGD', city: 'Singapore', state: 'Modelled', note: 'Pricing modelled · not executable', tone: 'muted' },
  { code: 'USD → VND', city: 'Ho Chi Minh City', state: 'Modelled', note: 'Pricing modelled · not executable', tone: 'muted' },
  { code: 'USD → THB', city: 'Bangkok', state: 'Modelled', note: 'Pricing modelled · not executable', tone: 'muted' },
] as const;

const RULES = [
  { when: 'amount ≥ USD 10,000.00', then: 'dual approval · maker ≠ checker' },
  { when: 'beneficiary review ≠ verified', then: 'blocked before quote' },
  { when: 'quote age > 30 s', then: 'refresh quote before execute' },
  { when: 'corridor flagged high-risk', then: 'blocked · exception opened' },
];

const RECORDS = [
  { source: 'Partner confirmation', detail: 'Payout reference and credited amount from the licensed payout partner.' },
  { source: 'Internal ledger', detail: 'Double-entry movement in your workspace, in minor units.' },
  { source: 'Network receipt', detail: 'Sui transaction digest and the anchored evidence blob.' },
];

/**
 * Marketing landing in the clearance language. The page alternates ink and
 * paper regions; the single signal colour traces one route through it: the
 * strip's path, the comparison's recommended row, the atlas's live corridor
 * and the final action. No gradients, no floating mockups.
 */
export default function ClearanceLanding() {
  const strip = stripData();
  const comparison = routeAlternatives('PHP', SEND_USD);

  return (
    <div className="clearance-landing bg-[var(--surface-canvas)] text-[var(--text)]">
      <ClearanceNav />
      <main id="main">
        {/* 1. Hero and clearance strip: the record lands from the ink region into the paper region. */}
        <section aria-labelledby="hero-title" className="bg-[var(--surface-navigation)] text-[var(--text-on-dark)]">
          <div className={cn(container, 'pb-0 pt-16 md:pt-24')}>
            <p className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--teal-300)]">Global payment clearance · USD to Southeast Asia</p>
            <h1 id="hero-title" className="mt-4 max-w-[14ch] text-[40px] font-semibold leading-[1.02] tracking-[-0.03em] sm:text-[56px] md:text-[68px]">
              Global payments, cleared for landing.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[17px] leading-[1.5] text-[var(--text-on-dark)]/80 md:text-[19px]">
              One control plane to verify, price, approve, route and reconcile every cross-border payment.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/login" size="lg">Clear a payment</Button>
              <Link href="#platform" className="inline-flex h-11 items-center gap-2 rounded-[var(--r-control)] border border-white/20 px-4 text-[14px] font-medium text-[var(--text-on-dark)] hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal-300)]">
                See how it works <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="relative mt-14 translate-y-16 md:mt-16 md:translate-y-20">
              <ClearanceStrip data={strip} />
            </div>
          </div>
        </section>

        {/* 2. Proof band */}
        <section aria-label="Proof points" className="border-b border-[var(--border-default)] bg-[var(--surface-canvas)] pt-20 md:pt-24">
          <ul className={cn(container, 'grid divide-y divide-[var(--border-default)] border-t border-[var(--border-default)] md:grid-cols-4 md:divide-x md:divide-y-0')}>
            {PROOF.map((item) => (
              <li key={item} className="flex min-h-12 items-center px-1 py-3 font-mono text-[11.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)] md:justify-center md:px-4 md:text-center">
                {item}
              </li>
            ))}
          </ul>
        </section>

        {/* 3. Operating model */}
        <Region id="platform" eyebrow="Operating model" title="Payments don’t need another rail. They need traffic control." lede={`${brand.name} observes real balances, verified beneficiaries, live FX, compliance, policy and partner availability. It clears the best eligible path and proves final settlement.`}>
          <ol className="grid gap-px border border-[var(--border-default)] bg-[var(--border-default)] md:grid-cols-3">
            {MODEL.map((step, index) => (
              <li key={step.title} className="grid content-start gap-3 bg-[var(--surface-raised)] p-6">
                <span className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--signal)]">Step {index + 1}</span>
                <h3 className="text-[19px] font-semibold tracking-[-0.01em]">{step.title}</h3>
                <p className="text-[14px] leading-[1.55] text-[var(--text-2)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </Region>

        {/* 4. Route comparison */}
        <Region dark eyebrow="Route comparison" title="One decision. Every reason attached." lede="Policy, compliance, cost, delivered amount, execution probability and evidence freshness, side by side, for the same USD 5,000.00 to Manila.">
          <div className="overflow-x-auto border border-white/12">
            <table className="w-full min-w-[640px] text-[13px]">
              <caption className="sr-only">Route comparison for USD 5,000.00 to PHP</caption>
              <thead>
                <tr className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/60">
                  <th scope="col" className="h-11 px-4 text-left font-medium">Route</th>
                  <th scope="col" className="h-11 px-4 text-right font-medium">They receive</th>
                  <th scope="col" className="h-11 px-4 text-right font-medium">All-in cost</th>
                  <th scope="col" className="h-11 px-4 text-right font-medium">Delivery</th>
                  <th scope="col" className="h-11 px-4 text-right font-medium">Confidence</th>
                  <th scope="col" className="h-11 px-4 text-left font-medium">Policy</th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row) => (
                  <tr key={row.id} className={cn('h-12 border-t border-white/12', row.recommended ? 'bg-white/[0.06] shadow-[inset_2px_0_0_var(--teal-300)]' : '')}>
                    <td className="px-4">
                      <span className="grid">
                        <span className="font-medium">{row.route}</span>
                        <span className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/55">{row.recommended ? 'Recommended · executable' : 'Reviewed baseline'}</span>
                      </span>
                    </td>
                    <td className={cn('px-4 text-right font-mono tabular-nums', row.recommended && 'text-[var(--teal-300)]')}>{formatAmount('PHP', row.delivered)}</td>
                    <td className="px-4 text-right font-mono tabular-nums">{formatMoney('USD', row.feeUsd)} <span className="text-[var(--text-on-dark)]/55">({row.feePct.toFixed(2)}%)</span></td>
                    <td className="px-4 text-right font-mono">{row.eta}</td>
                    <td className="px-4 text-right font-mono tabular-nums">{row.confidence}%</td>
                    <td className="px-4 font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--teal-300)]">Passed</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/55">Illustrative · sandbox pricing · bank and MTO rows are reviewed category baselines</p>
        </Region>

        {/* 5. Corridor atlas */}
        <Region id="network" eyebrow="Network" title="Clear visibility. Two corridors first." lede="Corridors launch in a staggered order. USD to the Philippines runs in sandbox today, Indonesia is staged, and the rest stay modelled until partner controls are active.">
          <ol className="grid gap-px border border-[var(--border-default)] bg-[var(--border-default)] sm:grid-cols-2 lg:grid-cols-3">
            {CORRIDORS.map((corridor) => (
              <li key={corridor.code} className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-2 bg-[var(--surface-raised)] p-5', corridor.tone === 'verified' && 'shadow-[inset_2px_0_0_var(--signal)]')}>
                <div className="grid gap-1">
                  <span className="font-mono text-[15px] font-semibold tabular-nums">{corridor.code}</span>
                  <span className="text-[13px] text-[var(--text-2)]">{corridor.city}</span>
                  <span className="text-[12px] text-[var(--text-muted)]">{corridor.note}</span>
                </div>
                <span className={cn('h-6 self-start border px-2 font-mono text-[11px] font-medium leading-6', corridor.tone === 'verified' && 'border-[var(--green-700)]/40 bg-[var(--surface-verified)] text-[var(--state-verified)]', corridor.tone === 'attention' && 'border-[var(--amber-700)]/40 bg-[var(--surface-attention)] text-[var(--state-attention)]', corridor.tone === 'muted' && 'border-[var(--border-default)] text-[var(--text-muted)]')}>{corridor.state}</span>
              </li>
            ))}
          </ol>
        </Region>

        {/* 6. Policy and governance */}
        <Region id="governance" dark eyebrow="Governance" title="Policy travels with the payment." lede="Rules are evaluated on the server at every checkpoint. The interface shows the outcome; it never decides it.">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <ul className="grid gap-px border border-white/12 bg-white/12">
              {RULES.map((rule) => (
                <li key={rule.when} className="grid gap-1 bg-[var(--surface-navigation)] px-4 py-3 font-mono text-[12.5px] sm:grid-cols-[3rem_minmax(0,1fr)_3.5rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                  <span className="uppercase tracking-[var(--tracking-label)] text-[var(--teal-300)]">If</span>
                  <span>{rule.when}</span>
                  <span className="uppercase tracking-[var(--tracking-label)] text-[var(--teal-300)]">Then</span>
                  <span>{rule.then}</span>
                </li>
              ))}
            </ul>
            <dl className="grid content-start gap-4 text-[14px] leading-[1.55] text-[var(--text-on-dark)]/80">
              <div>
                <dt className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/55">Maker-checker</dt>
                <dd>Every material movement needs a checker distinct from the maker. Approval is a decision; execution is a separate step bound to the approval hash the checker saw.</dd>
              </div>
              <div>
                <dt className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/55">Evidence, not assurances</dt>
                <dd>Beneficiary verification, FX lock, policy outcome, approval, execution and proof each leave a timestamped entry that travels with the record.</dd>
              </div>
              <div>
                <dt className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/55">Posture</dt>
                <dd>{brand.postureLine} Licensed partners are the system of record for regulated activity today. <Link href="/trust" className="text-[var(--teal-300)] underline underline-offset-4">Trust and compliance</Link>.</dd>
              </div>
            </dl>
          </div>
        </Region>

        {/* 7. Three-way reconciliation */}
        <Region eyebrow="Reconciliation" title="Three records enter. One truth leaves." lede="Partner confirmation, internal ledger and network receipt are matched to a single outcome. Anything that does not match becomes an exception with the difference named.">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_auto_minmax(0,1.2fr)] lg:items-center">
            <ol className="grid gap-px border border-[var(--border-default)] bg-[var(--border-default)] md:grid-cols-3">
              {RECORDS.map((record) => (
                <li key={record.source} className="grid content-start gap-2 bg-[var(--surface-raised)] p-5">
                  <span className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{record.source}</span>
                  <p className="text-[13.5px] leading-[1.5] text-[var(--text-2)]">{record.detail}</p>
                </li>
              ))}
            </ol>
            <div className="hidden h-px w-10 bg-[var(--signal)] lg:block" aria-hidden="true" />
            <div className="grid gap-2 border border-[var(--green-700)]/40 bg-[var(--surface-verified)] p-5">
              <span className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--state-verified)]">Outcome</span>
              <span className="text-[19px] font-semibold tracking-[-0.01em]">Reconciled</span>
              <span className="font-mono text-[12px] text-[var(--text-2)]">amounts equal · digest anchored · partner ref matched</span>
            </div>
          </div>
        </Region>

        {/* 8. Developer integration */}
        <Region id="developers" dark eyebrow="Developers" title="Built for developers." lede="A REST API with signed requests, idempotency keys, verifiable webhooks and realistic sandbox scenarios. The same clearance record your operators see is the one your systems receive.">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <pre className="overflow-x-auto border border-white/12 bg-black/25 p-5 font-mono text-[12.5px] leading-[1.6] text-[var(--text-on-dark)]/90" aria-label="Example request">
{`POST /api/transfers/authorize
Idempotency-Key: 8f0b4e2a-…

{
  "recipient": { "name": "Manila Textiles", "country": "PH" },
  "amount":    { "value": "5000.00", "targetCurrency": "PHP" },
  "fundingSelection": { "type": "held", "source": "SPLASH_BALANCE" }
}

← 202 Accepted
{ "state": "AWAITING_CHECKER", "proposalId": "prp_…", "approvalHash": "0x…" }`}
            </pre>
            <ul className="grid content-start gap-3 text-[14px] leading-[1.55] text-[var(--text-on-dark)]/80">
              <li><span className="font-medium text-[var(--text-on-dark)]">Webhooks you can verify.</span> Every event is signed; replay it against the clearance record to check the state you hold.</li>
              <li><span className="font-medium text-[var(--text-on-dark)]">Sandbox that behaves.</span> Quote expiry, policy blocks, partner exceptions and reconciliation mismatches are all reproducible.</li>
              <li><span className="font-medium text-[var(--text-on-dark)]">Evidence bundle.</span> Digest, content hashes, amounts and timeline, exportable per record.</li>
              <li><Link href="/docs" className="inline-flex items-center gap-1.5 text-[var(--teal-300)] underline underline-offset-4">Read the API docs <ArrowRight className="size-4" aria-hidden="true" /></Link></li>
            </ul>
          </div>
        </Region>

        {/* 9. Final CTA */}
        <section aria-labelledby="cta-title" className="border-t border-[var(--border-default)] bg-[var(--surface-canvas)]">
          <div className={cn(container, 'grid gap-6 py-16 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:py-24')}>
            <div>
              <h2 id="cta-title" className="text-[32px] font-semibold leading-[1.05] tracking-[-0.025em] md:text-[44px]">Clear your first corridor.</h2>
              <p className="mt-3 max-w-[48ch] text-[16px] text-[var(--text-2)]">See real routes, sandbox pricing and real evidence in minutes. No customer funds move until MFCA activation.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button href={`mailto:${brand.supportEmail}`} variant="secondary" size="lg">Talk to our team</Button>
              <Button href="/sandbox" size="lg">Open sandbox</Button>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function Region({ id, eyebrow, title, lede, dark = false, children }: { id?: string; eyebrow: string; title: string; lede: string; dark?: boolean; children: ReactNode }) {
  const headingId = `${id ?? eyebrow.toLowerCase().replace(/[^a-z]+/g, '-')}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className={cn(dark ? 'bg-[var(--surface-navigation)] text-[var(--text-on-dark)]' : 'bg-[var(--surface-canvas)] text-[var(--text)]')}>
      <div className={cn(container, 'grid gap-8 py-16 md:py-24')}>
        <div className="grid gap-4 md:max-w-[62ch]">
          <p className={cn('font-mono text-[11px] uppercase tracking-[var(--tracking-label)]', dark ? 'text-[var(--teal-300)]' : 'text-[var(--signal)]')}>{eyebrow}</p>
          <h2 id={headingId} className="text-[28px] font-semibold leading-[1.08] tracking-[-0.025em] md:text-[40px]">{title}</h2>
          <p className={cn('text-[16px] leading-[1.55]', dark ? 'text-[var(--text-on-dark)]/75' : 'text-[var(--text-2)]')}>{lede}</p>
        </div>
        {children}
      </div>
    </section>
  );
}
