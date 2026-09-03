import { getNetworkProfile } from '@/lib/network';

import { container } from './ui';

/** One hairline row under the hero: award, env-gated network state, posture. */
export default function ProofStrip() {
  const { badges, live } = getNetworkProfile();
  const items = [
    'Sui Overflow 2026 · Top 4, DeFi & Payments',
    live ? 'Settled on Sui mainnet' : badges.network,
    'Regulator-ready by design',
  ];
  return (
    <div className="border-y border-[var(--divider)] bg-[var(--surface)]">
      <ul className={`${container} flex flex-col divide-y divide-[var(--divider)] md:flex-row md:divide-x md:divide-y-0`} aria-label="Proof points">
        {items.map((item) => (
          <li key={item} className="flex min-h-12 flex-1 items-center justify-center px-4 text-center font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--text-2)]">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
