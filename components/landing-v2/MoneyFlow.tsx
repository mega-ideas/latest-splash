'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useState, type ReactNode } from 'react';

import { PillToggle } from '@/components/system';
import { getNetworkProfile } from '@/lib/network';
import { cn } from '@/lib/utils';

import { Mono, Section, TwoTone } from './ui';

/**
 * Money-flow section (§3.3, docs/money-flow-spec.md).
 *
 * Five node groups left→right on desktop, stacked on mobile; dotted
 * connectors with three traveling dots per segment (static under reduced
 * motion); exactly ONE dark card — the settlement node; contrast badges under
 * the line; step cards 01–05 whose copy swaps with the Send | Batch toggle.
 * The 01–05 numbering is real sequence: the order is the order money moves.
 */

type Mode = 'send' | 'batch';

const STEPS: Record<Mode, Array<{ title: string; body: string }>> = {
  send: [
    { title: 'You fund in fiat', body: 'USD wire, ACH or FPX into your operating account. No wallets, no gas.' },
    { title: 'We verify and price', body: "KYB'd counterparties, sanctions screening, live FX from Pyth — the rate you see is the rate on-chain." },
    { title: 'Sui settles atomically', body: 'Intent confirmed, treasury allocated, audit record anchored — all or nothing.' },
    { title: 'Partners pay out locally', body: "PHP and IDR to your supplier's bank through a licensed payout partner." },
    { title: 'You get proof', body: 'An on-chain settlement digest your auditor can verify.' },
  ],
  batch: [
    { title: 'Upload the payout file', body: 'Fifty suppliers, two countries, one CSV.' },
    { title: 'We verify and price', body: 'Every row screened and priced before anything is prepared.' },
    { title: 'One atomic batch', body: 'Settles in chunks as single transactions; everyone in a chunk gets paid, or nobody does.' },
    { title: 'Partners fan out locally', body: 'One batch, multiple corridors, one partner at the far end of each.' },
    { title: 'You get proof', body: 'One digest per chunk, one receipt per supplier.' },
  ],
};

const FOOTNOTE = '*On-chain settlement ~400ms; total delivery time depends on local payout rails. Illustrative — see pricing.';

function Node({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-2 rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-4', className)}>
      <h4 className="text-[15px] font-semibold">{title}</h4>
      {children}
    </div>
  );
}

function Connector({ badge }: { badge?: ReactNode }) {
  return (
    <div className="lv2-connector relative flex items-center justify-center md:w-12 md:self-stretch" aria-hidden="true">
      <span className="lv2-track" />
      <span className="lv2-dot" style={{ animationDelay: '0s' }} />
      <span className="lv2-dot" style={{ animationDelay: '-0.8s' }} />
      <span className="lv2-dot" style={{ animationDelay: '-1.6s' }} />
      {badge ? <span className="absolute right-0 top-1/2 -translate-y-1/2 md:hidden">{badge}</span> : null}
    </div>
  );
}

function AmberBadge() {
  return <span className="inline-flex h-7 items-center rounded-[999px] border border-[var(--amber-100)] bg-[var(--amber-100)] px-2.5 font-mono text-[12px] text-[var(--amber-700)]">Legacy rails: 2–3 days</span>;
}
function GreenBadge() {
  return <span className="inline-flex h-7 items-center rounded-[999px] border border-[var(--green-100)] bg-[var(--green-100)] px-2.5 font-mono text-[12px] text-[var(--green-700)]">Splash: minutes, end to end*</span>;
}

export default function MoneyFlow() {
  const [mode, setMode] = useState<Mode>('send');
  const reduced = useReducedMotion();
  const corridors = getNetworkProfile().corridors;

  return (
    <Section id="money-flow" tone="surface" labelledBy="money-flow-title" className="scroll-mt-16">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.1em] text-[var(--teal-600)]">How it settles</p>
          <TwoTone id="money-flow-title" className="mt-2" line1="Fiat in. Local bank out." line2="One atomic transaction in between." />
        </div>
        <div className="sticky top-16 z-10 -mx-5 bg-[var(--surface)]/95 px-5 py-2 backdrop-blur md:static md:m-0 md:bg-transparent md:p-0">
          <PillToggle
            label="Flow"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'send', label: 'Send' },
              { value: 'batch', label: 'Batch payout' },
            ]}
          />
        </div>
      </div>

      {/* Node row */}
      <div className="mt-10 flex flex-col md:flex-row md:items-stretch" role="list" aria-label="Money flow">
        <Node title="Your business" className="md:flex-[1]">
          <div className="flex flex-wrap gap-1">
            {['USD wire', 'ACH', 'FPX'].map((rail) => (
              <Mono key={rail}>{rail}</Mono>
            ))}
          </div>
          <p className="text-[13px] text-[var(--text-2)]">Fund in fiat. No wallets, no gas.</p>
        </Node>
        <Connector badge={<AmberBadge />} />
        <Node title="Splash orchestration" className="md:flex-[1]">
          <p className="font-mono text-[12px] text-[var(--text-2)]">KYB · screening · FX</p>
          <Mono className="self-start text-[var(--teal-600)]">Live FX via Pyth</Mono>
        </Node>
        <Connector />
        {/* HERO NODE — the only dark card in this section */}
        <div className="flex min-w-0 flex-col gap-2 rounded-[16px] bg-[var(--ink-900)] p-5 text-white ring-4 ring-[var(--teal-600)]/20 md:flex-[1.2] md:scale-[1.03]">
          <h4 className="text-[16px] font-semibold">One atomic transaction</h4>
          <ul className="grid gap-1 font-mono text-[13px] text-[var(--green-100)]">
            <li>pay</li>
            <li>allocate</li>
            <li>prove</li>
          </ul>
          <p className="mt-auto font-mono text-[10px] uppercase tracking-[0.12em] text-white/70">Settled on-chain · ~400ms finality</p>
        </div>
        <Connector badge={<GreenBadge />} />
        <Node title="Licensed payout partners" className="md:flex-[1]">
          <ul className="grid gap-1.5">
            {corridors.map((corridor) => (
              <li key={corridor.code} className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px]">
                <span className="font-medium">{corridor.country}</span>
                <span className="block text-[11px] text-[var(--text-2)]">{corridor.partnerLabel}</span>
              </li>
            ))}
            <li className="rounded-[10px] border border-dashed border-[var(--line)] px-2.5 py-1.5 text-[12px] text-[var(--text-muted)]">More corridors</li>
          </ul>
        </Node>
        <Connector />
        <Node title="Supplier's bank account" className="md:flex-[1]">
          <div className="flex flex-wrap gap-1">
            <Mono>₱ PHP</Mono>
            <Mono>Rp IDR</Mono>
            <Mono className="border-dashed bg-transparent text-[var(--text-muted)]">$ SGD</Mono>
            <Mono className="border-dashed bg-transparent text-[var(--text-muted)]">₫ VND</Mono>
            <Mono className="border-dashed bg-transparent text-[var(--text-muted)]">฿ THB</Mono>
          </div>
          <p className="text-[13px] text-[var(--text-2)]">Local bank transfer. They never touch crypto.</p>
        </Node>
      </div>

      {/* Contrast badges under the line (desktop); inline on mobile via connectors */}
      <div className="mt-3 hidden grid-cols-[1fr_3rem_1fr_3rem_1.2fr_3rem_1fr_3rem_1fr] items-center md:grid" aria-hidden="true">
        <div className="col-span-3 flex justify-center">
          <AmberBadge />
        </div>
        <div className="col-span-2" />
        <div className="col-span-4 flex justify-center">
          <GreenBadge />
        </div>
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-muted)]">{FOOTNOTE}</p>

      {/* Step cards 01–05 */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.ol
          key={mode}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.25 }}
          className="-mx-5 mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0"
          aria-label={mode === 'send' ? 'Send steps' : 'Batch payout steps'}
        >
          {STEPS[mode].map((step, index) => (
            <li key={step.title} className="min-w-[85%] snap-start rounded-[16px] border border-[var(--line)] bg-[var(--paper)] p-4 md:min-w-0">
              <div className="font-mono text-[12px] font-semibold text-[var(--teal-600)]">0{index + 1}</div>
              <h4 className="mt-2 text-[17px] font-semibold leading-tight">{step.title}</h4>
              <p className="mt-2 text-[14px] leading-[1.5] text-[var(--text-2)]">{step.body}</p>
            </li>
          ))}
        </motion.ol>
      </AnimatePresence>
    </Section>
  );
}
