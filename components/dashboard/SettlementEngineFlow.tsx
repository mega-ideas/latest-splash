'use client';

/**
 * SettlementEngineFlow — the dashboard's signature "how the money moves" diagram.
 *
 * Inspired by Corefy's animated payment-orchestration chart (Goodface hack #4/#14):
 * sources on the left flow through a central routing core into modeled destinations on
 * the right, with energy visibly flowing along the connectors. One component, three
 * variants, so Overview, Treasury, and Batch tell the same visual story.
 *
 * Motion is pure CSS (flowing dashed connectors + a pulsing core) and is disabled
 * under `prefers-reduced-motion` via the `.dash-flow` rules in globals.css.
 */

import Image from 'next/image';
import { useEffect, useState } from 'react';

export type FlowNode = {
  label: string;
  sublabel?: string;
  /** Logo path under /public. Falls back to `flag` or initials when absent. */
  src?: string;
  /** Emoji flag for corridor nodes. */
  flag?: string;
};

type Variant = 'settlement' | 'treasury' | 'batch';

type CoreCopy = { kicker: string; title: string; sub: string };

const CORE: Record<Variant, CoreCopy> = {
  settlement: { kicker: 'Settlement engine', title: 'Splash · Sui', sub: 'Atomic settle-or-revert' },
  treasury:   { kicker: 'Treasury projection', title: 'USDY model', sub: 'Approval-gated simulation' },
  batch:      { kicker: 'Batch engine',      title: 'Payout run',   sub: 'Screen · authorize · settle' },
};

const DEFAULT_SOURCES: Record<Variant, FlowNode[]> = {
  settlement: [
    { label: 'Stripe', sublabel: 'USD collection', src: '/stripe-logo.svg' },
    { label: 'Airwallex', sublabel: 'Bank rails', src: '/airwallex-logo.png' },
  ],
  treasury: [
    { label: 'Idle USD', sublabel: 'Available balance' },
  ],
  batch: [
    { label: 'CSV upload', sublabel: 'Recipients' },
    { label: 'AML / KYT', sublabel: 'Pre-screen' },
  ],
};

const DEFAULT_DESTS: Record<Variant, FlowNode[]> = {
  settlement: [
    { label: 'PHP', sublabel: 'Live-model payout', flag: '🇵🇭' },
    { label: 'MYR', sublabel: 'Implemented in code', flag: '🇲🇾' },
    { label: 'IDR', sublabel: 'Implemented in code', flag: '🇮🇩' },
    { label: 'SGD', sublabel: 'Implemented in code', flag: '🇸🇬' },
  ],
  treasury: [
    { label: 'USDY yield', sublabel: 'variable · T-bill' },
    { label: 'Withdraw', sublabel: 'T+1–T+3 to Available' },
  ],
  batch: [
    { label: 'PHP', sublabel: 'Cleared', flag: '🇵🇭' },
    { label: 'IDR', sublabel: 'Cleared', flag: '🇮🇩' },
    { label: '+6 more', sublabel: 'Implemented in code' },
  ],
};

const DEFAULT_CAPTIONS: Record<Variant, string[]> = {
  settlement: ['400ms Sui finality', 'One live-model corridor', 'Walrus audit proof'],
  treasury:   ['Projected USDY rate', 'Human approval required', 'Execution gated'],
  batch:      ['One authorization', 'Every row screened', 'Receipts anchored'],
};

/** Even vertical centers for n stacked nodes, matching CSS `space-around`. */
function centers(n: number): number[] {
  return Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * 100);
}

function NodeChip({ node }: { node: FlowNode }) {
  return (
    <div className="dash-flow-node">
      <span className="dash-flow-node-mark" aria-hidden="true">
        {node.src ? (
          <Image src={node.src} alt="" width={48} height={28} className="dash-flow-node-logo" style={{ width: 'auto', height: 'auto' }} />
        ) : node.flag ? (
          <span className="dash-flow-node-flag">{node.flag}</span>
        ) : (
          <span className="dash-flow-node-initial">{node.label.slice(0, 1)}</span>
        )}
      </span>
      <span className="dash-flow-node-copy">
        <strong>{node.label}</strong>
        {node.sublabel && <small>{node.sublabel}</small>}
      </span>
    </div>
  );
}

/** Fanning connector that flows left→right. `dir="in"` fans many→one, `out` one→many. */
function Connector({ count, dir }: { count: number; dir: 'in' | 'out' }) {
  const ys = centers(count);
  return (
    <svg
      className="dash-flow-wires"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {ys.map((y, i) => {
        const d =
          dir === 'in'
            ? `M 0 ${y} C 50 ${y}, 50 50, 100 50`
            : `M 0 50 C 50 50, 50 ${y}, 100 ${y}`;
        return (
          <g key={i}>
            <path className="dash-flow-wire-base" d={d} vectorEffect="non-scaling-stroke" />
            <path
              className="dash-flow-wire-flow"
              d={d}
              vectorEffect="non-scaling-stroke"
              style={{ animationDelay: `${i * 0.4}s` }}
            />
          </g>
        );
      })}
    </svg>
  );
}

export default function SettlementEngineFlow({
  variant = 'settlement',
  sources,
  corridors,
  captions,
  className = '',
}: {
  variant?: Variant;
  sources?: FlowNode[];
  corridors?: FlowNode[];
  captions?: string[];
  className?: string;
}) {
  const left = sources ?? DEFAULT_SOURCES[variant];
  const right = corridors ?? DEFAULT_DESTS[variant];
  const caps = captions ?? DEFAULT_CAPTIONS[variant];
  const core = CORE[variant];

  const [capIndex, setCapIndex] = useState(0);
  useEffect(() => {
    if (caps.length < 2) return;
    const id = window.setInterval(() => setCapIndex((i) => (i + 1) % caps.length), 2600);
    return () => window.clearInterval(id);
  }, [caps.length]);

  return (
    <section className={`dash-block dash-block-accent dash-flow ${className}`} aria-label={`${core.title} flow`}>
      <header className="dash-flow-head">
        <span className="dash-kicker">{core.kicker}</span>
        <p className="dash-flow-caption" aria-live="polite">
          <i aria-hidden="true" /> {caps[capIndex]}
        </p>
      </header>

      <div className="dash-flow-stage">
        <div className="dash-flow-col dash-flow-col-sources">
          <span className="dash-flow-col-label">Sources</span>
          <div className="dash-flow-stack">
            {left.map((n) => (
              <NodeChip key={n.label} node={n} />
            ))}
          </div>
        </div>

        <Connector count={left.length} dir="in" />

        <div className="dash-flow-core">
          <div className="dash-flow-core-orb">
            <span className="dash-flow-core-ring" aria-hidden="true" />
            <Image src="/splash-main-icon.png" alt="" width={48} height={47} loading="eager" />
          </div>
          <strong>{core.title}</strong>
          <small>{core.sub}</small>
        </div>

        <Connector count={right.length} dir="out" />

        <div className="dash-flow-col dash-flow-col-dests">
          <span className="dash-flow-col-label">Destinations</span>
          <div className="dash-flow-stack">
            {right.map((n) => (
              <NodeChip key={n.label} node={n} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
