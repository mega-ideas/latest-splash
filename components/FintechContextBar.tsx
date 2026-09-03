'use client';

import Image from 'next/image';
import { usePathname } from 'next/navigation';

type ContextMeta = {
  eyebrow: string;
  title: string;
  copy: string;
  icon: string;
  signal: string;
};

const dashboardMeta: Array<[string, ContextMeta]> = [
  ['/dashboard/transfer', { eyebrow: 'Payment intent', title: 'Move money with certainty', copy: 'Quote, authorize, settle, and verify in one operating flow.', icon: '/isometric/arrow-icon.svg', signal: 'Atomic settlement' }],
  ['/dashboard/batch', { eyebrow: 'Batch operations', title: 'Orchestrate payout windows', copy: 'Screen every row, authorize once, and monitor the complete batch.', icon: '/isometric/blocks-icon.svg', signal: 'Compliance pre-check' }],
  ['/dashboard/treasury', { eyebrow: 'Smart treasury', title: 'Keep operating cash productive', copy: 'Manage liquidity, yield, and settlement availability from one view.', icon: '/isometric/stats-icon.svg', signal: 'Treasury active' }],
  ['/dashboard/invoices', { eyebrow: 'Invoice vault', title: 'Receipts that remain verifiable', copy: 'Seal financial records on Walrus while keeping audit access ready.', icon: '/isometric/checklist-icon.svg', signal: 'Walrus retained' }],
  ['/dashboard/copilot', { eyebrow: 'AI Copilot', title: 'Decisions with operating memory', copy: 'Surface patterns, explain movement, and prepare the next action.', icon: '/isometric/star-icon.svg', signal: 'MemWal online' }],
  ['/dashboard/recipients', { eyebrow: 'Global directory', title: 'Know every destination', copy: 'Manage verified beneficiaries across approved settlement corridors.', icon: '/isometric/global-icon.svg', signal: 'Live corridor + modeled routes' }],
  ['/dashboard/history', { eyebrow: 'Settlement history', title: 'Trace every money movement', copy: 'Follow authorization, settlement, delivery, and audit evidence.', icon: '/isometric/checklist-icon.svg', signal: 'Audit ready' }],
  ['/dashboard/settings', { eyebrow: 'Controls', title: 'Policy before payment', copy: 'Manage access, limits, verification, and security posture.', icon: '/isometric/secure-icon.svg', signal: 'Controls enforced' }],
  ['/dashboard/customer-service', { eyebrow: 'Operations support', title: 'Keep every issue moving', copy: 'Create, track, and resolve service cases with full context.', icon: '/isometric/fast-icon.svg', signal: 'Systems operational' }],
  ['/dashboard', { eyebrow: 'Operating desk', title: 'Global Settlement Engine', copy: 'One view for money movement, treasury, compliance, and permanent records.', icon: '/isometric/stats-icon.svg', signal: 'All systems live' }],
];

const adminMeta: Array<[string, ContextMeta]> = [
  ['/admin/transactions', { eyebrow: 'Settlement monitor', title: 'Inspect live money movement', copy: 'Monitor peg health, transfer state, batches, and on-chain evidence.', icon: '/isometric/stats-icon.svg', signal: 'Live monitor' }],
  ['/admin/kyb', { eyebrow: 'Compliance review', title: 'Verify businesses with context', copy: 'Review identity evidence, risk posture, and corridor access.', icon: '/isometric/checklist-icon.svg', signal: 'Review controlled' }],
  ['/admin/support', { eyebrow: 'Service operations', title: 'Resolve cases with evidence', copy: 'Triage requests, assign ownership, and preserve the response trail.', icon: '/isometric/fast-icon.svg', signal: 'Queue monitored' }],
  ['/admin/contracts', { eyebrow: 'Contract controls', title: 'Configure the settlement boundary', copy: 'Review package references and operator-controlled Sui objects.', icon: '/isometric/blocks-icon.svg', signal: 'Sui configuration' }],
  ['/admin', { eyebrow: 'Staff operations', title: 'Control room', copy: 'Compliance approvals, customer operations, and regulator-ready evidence.', icon: '/isometric/secure-icon.svg', signal: 'Restricted access' }],
];

function findMeta(pathname: string, entries: Array<[string, ContextMeta]>) {
  return entries.find(([path]) => pathname === path || (path !== '/dashboard' && path !== '/admin' && pathname.startsWith(`${path}/`)))?.[1] ?? entries.at(-1)![1];
}

export default function FintechContextBar({ variant = 'dashboard' }: { variant?: 'dashboard' | 'admin' }) {
  const pathname = usePathname();
  const meta = findMeta(pathname, variant === 'admin' ? adminMeta : dashboardMeta);

  return (
    <section className={`fintech-context-bar ${variant === 'admin' ? 'is-admin' : ''}`} aria-label={`${meta.title} status`}>
      <div className="fintech-context-icon">
        <Image src={meta.icon} alt="" width={1448} height={1086} priority={pathname === '/dashboard' || pathname === '/admin'} />
      </div>
      <div className="fintech-context-copy">
        <span>{meta.eyebrow}</span>
        <strong>{meta.title}</strong>
        <p>{meta.copy}</p>
      </div>
      <div className="fintech-context-signals" aria-label="Platform signals">
        <span><i /> {meta.signal}</span>
        <span>Sui settled</span>
        <span>Walrus verified</span>
      </div>
    </section>
  );
}
