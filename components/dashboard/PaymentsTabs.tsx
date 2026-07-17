'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { History, Layers, Send, Timer, type LucideIcon } from 'lucide-react';

/**
 * Payments section tabs — URL-driven (each tab is a route), so deep links,
 * refresh, and back/forward all land on the right tab without client state.
 */
const TABS: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: 'New', href: '/dashboard/payments/new', icon: Send },
  { label: 'Runs', href: '/dashboard/payments/runs', icon: Layers },
  { label: 'Rate holds', href: '/dashboard/payments/rate-holds', icon: Timer },
  { label: 'History', href: '/dashboard/payments/history', icon: History },
];

export default function PaymentsTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Payments sections" className="dash-surface flex flex-wrap items-center gap-1 p-1.5">
      {TABS.map(({ label, href, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors ${
              active
                ? 'bg-[#1F4452] text-white shadow-sm'
                : 'text-[#326273]/70 hover:bg-[#326273]/8 hover:text-[#1F4452]'
            }`}
          >
            <Icon size={15} className={active ? 'text-[#5C9EAD]' : ''} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
