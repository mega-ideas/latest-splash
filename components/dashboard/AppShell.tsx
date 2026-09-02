'use client';

import {
  Bot,
  Building2,
  CheckSquare,
  ChevronDown,
  FileCheck2,
  Home,
  Layers,
  LogOut,
  MoreHorizontal,
  Phone,
  Send,
  Settings,
  ShieldAlert,
  TrendingUp,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import NetworkBadge from '@/components/brand/NetworkBadge';
import SandboxRibbon from '@/components/brand/SandboxRibbon';
import Wordmark from '@/components/brand/Wordmark';
import FloatingCopilot from '@/components/FloatingCopilot';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { brand } from '@/lib/brand';
import { readPendingProposals, subscribePendingProposals } from '@/lib/oxwal-notify';
import { cn } from '@/lib/utils';

type NavItem = { label: string; href: string; icon: LucideIcon; badge?: 'approvals' };

/* Left nav order is the product's order of operations. */
const NAV: NavItem[] = [
  { label: 'Home', href: '/dashboard', icon: Home },
  { label: 'Send', href: '/dashboard/transfer', icon: Send },
  { label: 'Batch', href: '/dashboard/batch', icon: Layers },
  { label: 'Approvals', href: '/queue', icon: CheckSquare, badge: 'approvals' },
  { label: 'Recipients', href: '/dashboard/recipients', icon: Users },
  { label: 'Treasury', href: '/dashboard/treasury', icon: TrendingUp },
  { label: 'Receipts', href: '/dashboard/receipts', icon: FileCheck2 },
  { label: brand.agentName, href: '/dashboard/oxwal', icon: Bot, badge: 'approvals' },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
];

/* Mobile bottom tabs: the four money moments plus More. */
const TABS = ['/dashboard', '/dashboard/transfer', '/queue', '/dashboard/oxwal'];

function initialsFor(session: CustomerSession) {
  const source = session.name || session.organization || session.email;
  return (
    source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'S'
  );
}

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function subscribePending(onChange: () => void) {
  return subscribePendingProposals(() => onChange());
}

/** Pending-approval count from the cross-page notifier; 0 on the server. */
function usePendingCount() {
  return useSyncExternalStore(subscribePending, () => readPendingProposals().count, () => 0);
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--warn-bg)] px-1.5 font-mono text-[11px] font-semibold text-[var(--warn)]" aria-label={`${count} awaiting approval`}>
      {count}
    </span>
  );
}

export default function AppShell({
  children,
  session,
  kyb,
}: {
  children: ReactNode;
  session: CustomerSession;
  kyb?: { state: string; blocked: boolean; reason: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const pending = usePendingCount();
  const [menuOpen, setMenuOpen] = useState(false);
  const [orgOpen, setOrgOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const menuRef = useOutsideClose(menuOpen, () => setMenuOpen(false));
  const orgRef = useOutsideClose(orgOpen, () => setOrgOpen(false));

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  const tabItems = NAV.filter((item) => TABS.includes(item.href));
  const moreItems = NAV.filter((item) => !TABS.includes(item.href));

  return (
    <div className="app-shell flex min-h-screen bg-[var(--paper)] text-[var(--text)]">
      {/* ── Left nav (≥md) ─────────────────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-[var(--divider)] bg-[var(--surface)] px-3 py-4 md:flex" aria-label="Primary">
        <div className="px-2 pb-4">
          <Wordmark size={30} />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto">
          {NAV.map(({ label, href, icon: Icon, badge }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-[var(--r-sm)] px-3 text-[14px] font-medium transition-colors duration-[var(--dur-ui)]',
                  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]',
                  active ? 'bg-[var(--teal-100)] text-[var(--ink-900)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
                )}
              >
                <Icon className={cn('size-[18px] shrink-0', active ? 'text-[var(--teal-600)]' : 'text-[var(--text-muted)]')} aria-hidden="true" />
                <span>{label}</span>
                {badge === 'approvals' ? <CountBadge count={pending} /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-0.5 border-t border-[var(--divider)] pt-3">
          <Link href="/dashboard/customer-service" className="flex min-h-11 items-center gap-3 rounded-[var(--r-sm)] px-3 text-[14px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]">
            <Phone className="size-[18px] text-[var(--text-muted)]" aria-hidden="true" /> Support
          </Link>
          <button type="button" onClick={logout} className="flex min-h-11 w-full items-center gap-3 rounded-[var(--r-sm)] px-3 text-left text-[14px] font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)]">
            <LogOut className="size-[18px] text-[var(--text-muted)]" aria-hidden="true" /> Log out
          </button>
        </div>
      </aside>

      {/* ── Top bar ────────────────────────────────────────────── */}
      <header className="fixed left-0 right-0 top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-[var(--divider)] bg-[var(--surface)] px-4 md:left-60 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="md:hidden">
            <Wordmark size={26} showText={false} />
          </span>
          <div ref={orgRef} className="relative">
            <button
              type="button"
              onClick={() => setOrgOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={orgOpen}
              className="flex min-h-11 max-w-[220px] items-center gap-2 rounded-[var(--r-sm)] px-2 text-[14px] font-semibold text-[var(--text)] hover:bg-[var(--surface-2)]"
            >
              <Building2 className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <span className="truncate">{session.organization}</span>
              <ChevronDown className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            </button>
            {orgOpen ? (
              <div role="menu" className="absolute left-0 top-full mt-1 w-64 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-elevated)]">
                <div className="rounded-[var(--r-sm)] bg-[var(--teal-100)] px-3 py-2">
                  <div className="text-[13px] font-semibold text-[var(--ink-900)]">{session.organization}</div>
                  <div className="text-[12px] text-[var(--text-2)]">Current workspace</div>
                </div>
                <p className="px-3 pb-1 pt-2 text-[12px] text-[var(--text-muted)]">One workspace per sign-in today. Additional organisations arrive with org &amp; signer settings.</p>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex">
            <NetworkBadge />
          </span>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              className="flex size-11 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface-2)] text-[13px] font-semibold text-[var(--ink-900)] hover:bg-[var(--teal-100)]"
            >
              {initialsFor(session)}
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute right-0 top-full mt-1 w-60 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-elevated)]">
                <div className="px-3 py-2">
                  <div className="truncate text-[13px] font-semibold text-[var(--text)]">{session.name}</div>
                  <div className="truncate text-[12px] text-[var(--text-muted)]">{session.email}</div>
                </div>
                <Link role="menuitem" href="/dashboard/profile" className="flex min-h-11 items-center gap-2 rounded-[var(--r-sm)] px-3 text-[14px] hover:bg-[var(--surface-2)]" onClick={() => setMenuOpen(false)}>
                  <UserRound className="size-4 text-[var(--text-muted)]" aria-hidden="true" /> Profile
                </Link>
                <Link role="menuitem" href="/dashboard/settings" className="flex min-h-11 items-center gap-2 rounded-[var(--r-sm)] px-3 text-[14px] hover:bg-[var(--surface-2)]" onClick={() => setMenuOpen(false)}>
                  <Settings className="size-4 text-[var(--text-muted)]" aria-hidden="true" /> Settings
                </Link>
                <button role="menuitem" type="button" onClick={logout} className="flex min-h-11 w-full items-center gap-2 rounded-[var(--r-sm)] px-3 text-left text-[14px] hover:bg-[var(--surface-2)]">
                  <LogOut className="size-4 text-[var(--text-muted)]" aria-hidden="true" /> Log out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────── */}
      <main className="relative z-0 min-w-0 flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-[4.5rem] md:ml-60 md:px-8 md:pb-10">
        <div className="mb-4 overflow-hidden rounded-[var(--r-sm)]">
          <SandboxRibbon />
        </div>
        {kyb?.blocked ? (
          <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-[var(--r-md)] border border-[var(--warn)] bg-[var(--warn-bg)] px-4 py-3">
            <ShieldAlert aria-hidden="true" className="size-4 shrink-0 text-[var(--warn)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--warn)]">Read-only workspace</p>
              <p className="mt-0.5 text-[13px] text-[var(--text-2)]">{kyb.reason}</p>
            </div>
            <Link href="/settings/kyb" className="rounded-[var(--r-sm)] bg-[var(--ink-900)] px-3 py-2 text-[13px] font-semibold text-white">
              Verification
            </Link>
          </div>
        ) : null}
        {children}
      </main>

      {/* ── Mobile bottom tabs ─────────────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[var(--divider)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Primary">
        {tabItems.map(({ label, href, icon: Icon, badge }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn('relative flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium', active ? 'text-[var(--teal-600)]' : 'text-[var(--text-muted)]')}
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
              {badge === 'approvals' && pending > 0 ? (
                <span className="absolute right-[18%] top-2 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--warn)] px-1 font-mono text-[10px] font-semibold text-white" aria-hidden="true">
                  {pending}
                </span>
              ) : null}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className="flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium text-[var(--text-muted)]"
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
          More
        </button>
      </nav>

      {moreOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="More">
          <button type="button" className="absolute inset-0 bg-[rgba(11,42,51,.45)]" aria-label="Close" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-[var(--r-lg)] bg-[var(--surface)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-elevated)]">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[15px] font-semibold">More</span>
              <button type="button" onClick={() => setMoreOpen(false)} aria-label="Close" className="flex size-11 items-center justify-center rounded-full hover:bg-[var(--surface-2)]">
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <div className="grid gap-1">
              {moreItems.map(({ label, href, icon: Icon }) => (
                <Link key={href} href={href} onClick={() => setMoreOpen(false)} className="flex min-h-12 items-center gap-3 rounded-[var(--r-sm)] px-3 text-[15px] font-medium hover:bg-[var(--surface-2)]">
                  <Icon className="size-5 text-[var(--text-muted)]" aria-hidden="true" /> {label}
                </Link>
              ))}
              <Link href="/dashboard/customer-service" onClick={() => setMoreOpen(false)} className="flex min-h-12 items-center gap-3 rounded-[var(--r-sm)] px-3 text-[15px] font-medium hover:bg-[var(--surface-2)]">
                <Phone className="size-5 text-[var(--text-muted)]" aria-hidden="true" /> Support
              </Link>
              <button type="button" onClick={logout} className="flex min-h-12 items-center gap-3 rounded-[var(--r-sm)] px-3 text-left text-[15px] font-medium hover:bg-[var(--surface-2)]">
                <LogOut className="size-5 text-[var(--text-muted)]" aria-hidden="true" /> Log out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <FloatingCopilot />
    </div>
  );
}
