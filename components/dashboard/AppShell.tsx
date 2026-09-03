'use client';

import {
  Bell,
  Bot,
  CheckSquare,
  ChevronDown,
  Code2,
  Droplets,
  FileClock,
  GitBranch,
  LayoutList,
  Landmark,
  LogOut,
  MoreHorizontal,
  Phone,
  Plug,
  Scale,
  Scan,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import Wordmark from '@/components/brand/Wordmark';
import FloatingIndicator from '@/components/oxwal/FloatingIndicator';
import StatusLabel from '@/components/shell/StatusLabel';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { brand } from '@/lib/brand';
import { getNetworkProfile } from '@/lib/network';
import { readPendingProposals, subscribePendingProposals } from '@/lib/oxwal-notify';
import { cn } from '@/lib/utils';

/**
 * Application shell (Clearance Signal): a dark navigation foundation on the
 * left and top, a calm canvas for the work. Navigation is grouped by what
 * the operator is doing — Operate, Govern, Build — in the order the
 * clearance loop runs. 184px at xl, icons only from md to xl, a compact
 * header plus bottom navigation below md (five destinations, never more).
 */
type NavItem = { label: string; href: string; icon: LucideIcon; badge?: 'approvals' | 'dot' };
type NavGroup = { label: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { label: 'Clearance board', href: '/dashboard', icon: LayoutList },
      { label: 'Payments', href: '/dashboard/payments', icon: Scan },
      { label: 'Beneficiaries', href: '/dashboard/recipients', icon: Users },
      { label: 'Liquidity', href: '/dashboard/treasury', icon: Droplets },
      { label: 'Routes', href: '/dashboard/routes', icon: GitBranch },
      { label: 'Reconciliation', href: '/dashboard/reconciliation', icon: Scale },
      { label: brand.agentName, href: '/dashboard/oxwal', icon: Bot, badge: 'dot' },
    ],
  },
  {
    label: 'Govern',
    items: [
      { label: 'Approvals', href: '/dashboard/approvals', icon: CheckSquare, badge: 'approvals' },
      { label: 'Policy', href: '/dashboard/policy', icon: ShieldCheck },
      { label: 'Compliance', href: '/dashboard/compliance', icon: Landmark },
      { label: 'Audit log', href: '/dashboard/audit', icon: FileClock },
    ],
  },
  {
    label: 'Build',
    items: [
      { label: 'Developers', href: '/dashboard/developers', icon: Code2 },
      { label: 'Integrations', href: '/dashboard/integrations', icon: Plug },
    ],
  },
];

const NAV = GROUPS.flatMap((group) => group.items);

/* Mobile bottom navigation: approval, exceptions, status, urgent action. */
const TABS = ['/dashboard', '/dashboard/payments', '/dashboard/approvals', '/dashboard/oxwal'];

const CRUMBS: Record<string, string> = {
  '/dashboard': 'Operations / Clearance board',
  '/dashboard/payments': 'Operations / Payments',
  '/dashboard/send': 'Operations / New payment',
  '/dashboard/batch': 'Operations / Batch payout',
  '/dashboard/recipients': 'Operations / Beneficiaries',
  '/dashboard/treasury': 'Operations / Liquidity',
  '/dashboard/routes': 'Operations / Routes',
  '/dashboard/reconciliation': 'Operations / Reconciliation',
  '/dashboard/oxwal': `Operations / ${brand.agentName}`,
  '/dashboard/receipts': 'Operations / Clearance record',
  '/dashboard/approvals': 'Governance / Approvals',
  '/dashboard/policy': 'Governance / Policy',
  '/dashboard/compliance': 'Governance / Compliance',
  '/dashboard/audit': 'Governance / Audit log',
  '/dashboard/developers': 'Build / Developers',
  '/dashboard/integrations': 'Build / Integrations',
  '/dashboard/settings': 'Workspace / Settings',
  '/dashboard/profile': 'Workspace / Profile',
};

function crumbFor(pathname: string) {
  const match = Object.keys(CRUMBS)
    .filter((key) => pathname === key || pathname.startsWith(`${key}/`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? CRUMBS[match] : 'Operations';
}

function initialsFor(session: CustomerSession) {
  const source = session.name || session.organization || session.email;
  return source.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'S';
}

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function subscribePending(onChange: () => void) {
  return subscribePendingProposals(() => onChange());
}

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

/** UTC clock; aria-hidden so the tick is never announced. */
function UtcClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    const timer = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, []);
  return (
    <span className="hidden font-mono text-[12px] tabular-nums text-[var(--text-on-dark)]/80 lg:inline" aria-hidden="true">
      {now ? `${now} UTC` : ''}
    </span>
  );
}

export default function AppShell({ children, session, kyb }: { children: ReactNode; session: CustomerSession; kyb?: { state: string; blocked: boolean; reason: string } }) {
  const router = useRouter();
  const pathname = usePathname();
  const pending = usePendingCount();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const menuRef = useOutsideClose(menuOpen, () => setMenuOpen(false));
  const profile = getNetworkProfile();
  const live = profile.live;

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  const tabItems = NAV.filter((item) => TABS.includes(item.href));
  const moreItems = NAV.filter((item) => !TABS.includes(item.href));

  const navLink = (item: NavItem) => {
    const active = isActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        title={item.label}
        className={cn(
          'relative flex h-9 items-center gap-2.5 px-3 text-[13px] font-medium text-[var(--text-on-dark)]/72 transition-colors duration-[var(--dur-fast)]',
          'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
          active ? 'bg-[var(--surface-navigation-active)] text-white shadow-[inset_2px_0_0_var(--signal-hover)]' : 'hover:bg-[var(--surface-navigation-active)]/60 hover:text-white',
          'md:justify-center xl:justify-start',
        )}
      >
        <Icon className={cn('size-4 shrink-0', active ? 'text-[var(--teal-300)]' : '')} strokeWidth={1.5} aria-hidden="true" />
        <span className="md:sr-only xl:not-sr-only">{item.label}</span>
        {item.badge === 'approvals' && pending > 0 ? (
          <span className="ml-auto rounded-full bg-[var(--amber-600)] px-1.5 font-mono text-[10px] font-semibold text-white md:absolute md:right-2 md:top-1.5 md:ml-0 xl:static" aria-label={`${pending} awaiting checker`}>
            {pending}
          </span>
        ) : null}
        {item.badge === 'dot' && pending > 0 ? <span className="ml-auto size-1.5 rounded-full bg-[var(--teal-300)] md:absolute md:right-2 md:top-2 md:ml-0 xl:static" aria-hidden="true" /> : null}
      </Link>
    );
  };

  return (
    <div className="app-shell grid min-h-dvh bg-[var(--surface-canvas)] text-[var(--text)] md:grid-cols-[var(--sidebar-collapsed-width)_minmax(0,1fr)] xl:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]">
      {/* ── Sidebar (≥md; icons only below xl) ───────────────────── */}
      <aside className="hidden min-w-0 flex-col bg-[var(--surface-navigation)] text-[var(--text-on-dark)] md:flex" aria-label="Primary">
        <div className="flex h-12 items-center border-b border-white/10 px-3 md:justify-center xl:justify-start xl:px-4">
          <span className="xl:hidden">
            <Wordmark size={24} showText={false} />
          </span>
          <span className="hidden xl:inline [&_.brand-wordmark-text]:text-white">
            <Wordmark size={24} />
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {GROUPS.map((group) => (
            <div key={group.label} className="mb-2">
              <p className="hidden px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/72 xl:block">{group.label}</p>
              {group.items.map(navLink)}
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3 xl:px-4">
          <p className="hidden font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-on-dark)]/72 xl:block">Organisation</p>
          <p className="hidden truncate text-[13px] font-medium text-white xl:block">{session.organization}</p>
          <div className="mt-1 md:flex md:justify-center xl:block">
            <StatusLabel compact tone={live ? 'verified' : 'attention'}>{live ? 'Live' : 'Sandbox'}</StatusLabel>
          </div>
          <Link href="/dashboard/customer-service" className="mt-2 flex h-8 items-center gap-2 text-[12px] text-[var(--text-on-dark)]/60 hover:text-white md:justify-center xl:justify-start">
            <Phone className="size-3.5" strokeWidth={1.5} aria-hidden="true" /> <span className="md:sr-only xl:not-sr-only">Support</span>
          </Link>
        </div>
      </aside>

      <div className="min-w-0">
        {/* ── Top bar ────────────────────────────────────────────── */}
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-white/10 bg-[var(--surface-navigation)] px-4 text-[var(--text-on-dark)] md:px-5">
          <span className="md:hidden">
            <Wordmark size={24} showText={false} />
          </span>
          <span className="hidden truncate text-[12.5px] text-[var(--text-on-dark)]/70 md:inline">{crumbFor(pathname)}</span>
          <form
            role="search"
            className="ml-auto hidden min-w-0 items-center md:flex"
            onSubmit={(event) => {
              event.preventDefault();
              const q = new FormData(event.currentTarget).get('q');
              router.push(`/dashboard/payments?q=${encodeURIComponent(String(q ?? ''))}`);
            }}
          >
            <label htmlFor="global-command" className="sr-only">
              Search payments or run a command
            </label>
            <span className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-on-dark)]/50" aria-hidden="true" />
              <input id="global-command" name="q" type="search" placeholder="Search payments, IDs, beneficiaries" className="h-8 w-[220px] rounded-[var(--r-control)] border border-white/10 bg-[var(--surface-navigation-active)] pl-8 pr-2 text-[12.5px] text-white placeholder:text-[var(--text-on-dark)]/45 focus:border-[var(--teal-300)] focus:outline-none lg:w-[300px]" />
            </span>
          </form>
          <UtcClock />
          <span className="ml-auto md:ml-0">
            <StatusLabel compact tone={live ? 'verified' : 'attention'}>{live ? 'Live' : 'Sandbox · no customer funds'}</StatusLabel>
          </span>
          <Link href="/dashboard/approvals" aria-label={pending > 0 ? `${pending} awaiting checker` : 'Notifications'} className="relative grid size-9 place-items-center rounded-[var(--r-control)] hover:bg-[var(--surface-navigation-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            <Bell className="size-4" strokeWidth={1.5} aria-hidden="true" />
            {pending > 0 ? <span className="absolute right-1 top-1 min-w-4 rounded-full bg-[var(--amber-600)] px-1 text-center font-mono text-[9.5px] font-semibold text-white" aria-hidden="true">{pending}</span> : null}
          </Link>
          <div ref={menuRef} className="relative">
            <button type="button" onClick={() => setMenuOpen((value) => !value)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Account menu" className="flex h-9 items-center gap-2 rounded-[var(--r-control)] px-1.5 hover:bg-[var(--surface-navigation-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              <span className="grid size-7 place-items-center rounded-full bg-[var(--surface-navigation-active)] text-[11px] font-semibold text-white ring-1 ring-white/15">{initialsFor(session)}</span>
              <span className="hidden max-w-[140px] truncate text-[12.5px] lg:inline">{session.name}</span>
              <ChevronDown className="hidden size-3.5 lg:inline" aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute right-0 top-full mt-1 w-60 rounded-[var(--r-control)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-1.5 text-[var(--text)] shadow-[var(--shadow-elevated)]">
                <div className="px-3 py-2">
                  <div className="truncate text-[13px] font-medium">{session.name}</div>
                  <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">{session.email}</div>
                  <div className="mt-1 truncate text-[12px] text-[var(--text-2)]">{session.organization}</div>
                </div>
                <Link role="menuitem" href="/dashboard/profile" className="flex h-9 items-center gap-2 rounded-[var(--r-control)] px-3 text-[13px] hover:bg-[var(--surface-subtle)]" onClick={() => setMenuOpen(false)}>
                  <UserRound className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> Profile
                </Link>
                <Link role="menuitem" href="/dashboard/settings" className="flex h-9 items-center gap-2 rounded-[var(--r-control)] px-3 text-[13px] hover:bg-[var(--surface-subtle)]" onClick={() => setMenuOpen(false)}>
                  <Settings className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> Settings
                </Link>
                <button role="menuitem" type="button" onClick={logout} className="flex h-9 w-full items-center gap-2 rounded-[var(--r-control)] px-3 text-left text-[13px] hover:bg-[var(--surface-subtle)]">
                  <LogOut className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> Log out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {/* ── Page ───────────────────────────────────────────────── */}
        <main id="main-content" className="min-w-0 p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:p-5 md:pb-8 xl:p-6">
          {kyb?.blocked ? (
            <div role="status" className="mb-5 flex flex-wrap items-center gap-3 border border-[var(--state-attention)] bg-[var(--surface-attention)] px-4 py-3">
              <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-[var(--state-attention)]" strokeWidth={1.5} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-[var(--state-attention)]">Read-only workspace</p>
                <p className="mt-0.5 text-[13px] text-[var(--text-2)]">{kyb.reason}</p>
              </div>
              <Link href="/settings/kyb" className="h-8 rounded-[var(--r-control)] bg-[var(--ink-900)] px-3 text-[13px] font-medium leading-8 text-white">
                Verification
              </Link>
            </div>
          ) : null}
          {children}
        </main>
      </div>

      {/* ── Mobile bottom navigation ───────────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-white/10 bg-[var(--surface-navigation)] pb-[env(safe-area-inset-bottom)] text-[var(--text-on-dark)] md:hidden" aria-label="Primary">
        {tabItems.map(({ label, href, icon: Icon, badge }) => {
          const active = isActive(pathname, href);
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn('relative flex min-h-14 flex-col items-center justify-center gap-1 text-[10.5px] font-medium', active ? 'text-white' : 'text-[var(--text-on-dark)]/60')}>
              <Icon className={cn('size-5', active && 'text-[var(--teal-300)]')} strokeWidth={1.5} aria-hidden="true" />
              {label === 'Clearance board' ? 'Board' : label}
              {badge === 'approvals' && pending > 0 ? <span className="absolute right-[18%] top-2 min-w-4 rounded-full bg-[var(--amber-600)] px-1 text-center font-mono text-[10px] font-semibold text-white" aria-hidden="true">{pending}</span> : null}
              {badge === 'dot' && pending > 0 ? <span className="absolute right-[24%] top-2.5 size-2 rounded-full bg-[var(--teal-300)]" aria-hidden="true" /> : null}
            </Link>
          );
        })}
        <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen} className="flex min-h-14 flex-col items-center justify-center gap-1 text-[10.5px] font-medium text-[var(--text-on-dark)]/60">
          <MoreHorizontal className="size-5" strokeWidth={1.5} aria-hidden="true" />
          More
        </button>
      </nav>

      {moreOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="More">
          <button type="button" className="absolute inset-0 bg-[rgba(11,42,51,.5)]" aria-label="Close" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-[12px] bg-[var(--surface-raised)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[15px] font-medium">More</span>
              <button type="button" onClick={() => setMoreOpen(false)} aria-label="Close" className="grid size-10 place-items-center rounded-[var(--r-control)] hover:bg-[var(--surface-subtle)]">
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {GROUPS.map((group) => (
              <div key={group.label} className="mb-2">
                <p className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{group.label}</p>
                {group.items.filter((item) => moreItems.includes(item)).map(({ label, href, icon: Icon }) => (
                  <Link key={href} href={href} onClick={() => setMoreOpen(false)} className="flex min-h-11 items-center gap-3 rounded-[var(--r-control)] px-3 text-[14px] hover:bg-[var(--surface-subtle)]">
                    <Icon className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> {label}
                  </Link>
                ))}
              </div>
            ))}
            <div className="border-t border-[var(--border-default)] pt-2">
              <Link href="/dashboard/settings" onClick={() => setMoreOpen(false)} className="flex min-h-11 items-center gap-3 rounded-[var(--r-control)] px-3 text-[14px] hover:bg-[var(--surface-subtle)]">
                <Settings className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> Settings
              </Link>
              <Link href="/dashboard/customer-service" onClick={() => setMoreOpen(false)} className="flex min-h-11 items-center gap-3 rounded-[var(--r-control)] px-3 text-[14px] hover:bg-[var(--surface-subtle)]">
                <Phone className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> Support
              </Link>
              <button type="button" onClick={logout} className="flex min-h-11 w-full items-center gap-3 rounded-[var(--r-control)] px-3 text-left text-[14px] hover:bg-[var(--surface-subtle)]">
                <LogOut className="size-4 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden="true" /> Log out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <FloatingIndicator />
    </div>
  );
}
