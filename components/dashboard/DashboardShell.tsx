'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import FloatingCopilot from '@/components/FloatingCopilot';
import DashboardHeader from '@/components/DashboardHeader';
import { CustodyPhaseContext, LaunchScopeContext, SweepSwitchContext } from '@/components/dashboard/CustodyPhaseContext';
import GovernanceAlertBanner from '@/components/dashboard/GovernanceAlertBanner';
import type { CustomerSession } from '@/lib/auth/customer-session';
import type { GovernanceBannerAlert } from '@/lib/server/governance-events';
import type { LaunchScope } from '@/lib/launch-scope-rules';
import {
  dashboardNav,
  isCurrent,
  pageLock,
  type DashboardNav,
  type NavIcon,
  type NavItem,
  type NavLocks,
  type SetupProgress,
} from '@/lib/dashboard/nav';
import {
  Bot,
  FileText,
  History,
  House,
  Layers,
  ListChecks,
  Lock,
  LogOut,
  Menu,
  Phone,
  Send,
  Settings,
  TrendingUp,
  UserCircle,
  Wallet,
  X,
  type LucideIcon,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

// ─── Nav ──────────────────────────────────────────────────────────────────────
// The order, the locks and the current-page rule live in lib/dashboard/nav.ts
// (tested as behaviour in tests/dashboard-nav.test.mjs). This file draws them.

const ICONS: Record<NavIcon, LucideIcon> = {
  home: House,
  zeke: Bot,
  transfer: Send,
  batch: Layers,
  invoices: FileText,
  wallet: Wallet,
  treasury: TrendingUp,
  recipients: UserCircle,
  history: History,
  settings: Settings,
  support: Phone,
  setup: ListChecks,
};

type DashboardShellProps = {
  children: ReactNode;
  session: CustomerSession;
  /** KYB gate state, resolved server-side in app/dashboard/layout.tsx. */
  kyb?: { state: string; blocked: boolean; reason: string };
  /** Onboarding locks, resolved by the SAME server layout from the SAME
   *  gates the money routes enforce (lib/server/kyb-gate.ts,
   *  lib/server/onboarding.ts, lib/server/custody-phase.ts). Padlocks here
   *  are presentation; the routes stay the security. Absent (no database on
   *  a dev machine) means nothing is locked, mirroring the gates' own dev
   *  posture. */
  locks?: NavLocks;
  /** Account setup progress (required steps 1-4), from the same layout.
   *  Absent when it could not be read. */
  setup?: SetupProgress;
  /** The operator's sweep switch (`sweepAccountEnabled()`), resolved by the
   *  same layout. Separate from `locks` because it needs no database. */
  sweepOn?: boolean;
  /** The launch scope (lib/server/launch-scope.ts), resolved by the same
   *  layout. Needs no database, so it locks even when `locks` is absent. */
  launchScope?: LaunchScope;
  /** Active governance alerts for this person (a contract change announced or
   *  in force), resolved by the same layout from their own recorded in-app
   *  deliveries (lib/server/governance-alerts-store.ts). Empty for anyone who
   *  is not a business owner. */
  governanceAlerts?: GovernanceBannerAlert[];
};

type LinkProps = {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  locks: NavLocks | undefined;
  scope: LaunchScope | undefined;
  nested?: boolean;
  onNavigate?: () => void;
};

/** One rail link: 44px tall, the current page announced, a padlock said in words. */
function NavLink({ item, pathname, collapsed, locks, scope, nested = false, onNavigate }: LinkProps) {
  const current = isCurrent(item.href, pathname, item.also);
  const lock = pageLock(item.href, locks, scope);
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={lock ? lock.href : item.href}
      aria-current={current ? 'page' : undefined}
      title={lock?.reason ?? (collapsed ? item.label : undefined)}
      onClick={onNavigate}
      className={`relative flex min-h-11 items-center rounded-lg px-2 py-2 text-sm transition-colors ${
        collapsed ? 'justify-center' : nested ? 'gap-3 pl-9' : 'gap-3'
      } ${
        current
          ? collapsed
            ? 'bg-white text-[var(--ink)] shadow-sm'
            : 'bg-white pl-3 text-[var(--ink)] shadow-sm'
          : 'text-white/80 hover:bg-white/10 hover:text-white'
      }`}
    >
      {current && !collapsed && <span aria-hidden="true" className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-[var(--teal)]" />}
      <Icon size={nested ? 16 : 18} aria-hidden="true" className={current ? 'text-[var(--slate)]' : ''} />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <>
          <span className={`flex-1 font-medium ${lock ? 'opacity-50' : ''}`}>{item.label}</span>
          {lock && <Lock size={13} aria-hidden="true" className={current ? 'text-[var(--ink)]/70' : 'text-white/80'} />}
          {item.badge && (
            <span
              className={`rounded-full bg-[var(--teal)]/20 px-1.5 py-0.5 text-[12px] font-semibold ${
                current ? 'text-[var(--ink)]' : 'text-white'
              }`}
            >
              {item.badge}
            </span>
          )}
        </>
      )}
      {lock && <span className="sr-only">. Locked: {lock.reason}</span>}
    </Link>
  );
}

/** The setup step still to finish, with its progress, until it is complete. */
function SetupCard({
  setup,
  pathname,
  collapsed,
  onNavigate,
}: {
  setup: NonNullable<DashboardNav['setup']>;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const current = isCurrent(setup.href, pathname);
  const progress = `${setup.done} of ${setup.total} steps done`;
  if (collapsed) {
    return (
      <Link
        href={setup.href}
        aria-current={current ? 'page' : undefined}
        title={`${setup.label}: ${progress}`}
        onClick={onNavigate}
        className="relative mb-3 flex min-h-11 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
      >
        <ListChecks size={18} aria-hidden="true" />
        <span aria-hidden="true" className="absolute right-3 top-2.5 h-2 w-2 rounded-full bg-[var(--gold-light)]" />
        <span className="sr-only">{setup.label}, {progress}</span>
      </Link>
    );
  }
  return (
    <Link
      href={setup.href}
      aria-current={current ? 'page' : undefined}
      onClick={onNavigate}
      className={`mb-2 block min-h-11 rounded-xl border px-3 py-2 transition-colors ${
        current ? 'border-white bg-white text-[var(--ink)]' : 'border-white/15 bg-white/[0.07] text-white hover:bg-white/10'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks size={16} aria-hidden="true" />
        <span className="flex-1">{setup.label}</span>
        <span className={`text-[12px] font-medium tabular-nums ${current ? 'text-[var(--slate)]' : 'text-white'}`}>
          {setup.done} of {setup.total}
          <span className="sr-only"> steps done</span>
        </span>
      </span>
      <span aria-hidden="true" className={`mt-1.5 block h-1.5 overflow-hidden rounded-full ${current ? 'bg-[var(--line)]' : 'bg-white/15'}`}>
        <span className="block h-full rounded-full bg-[var(--gold-light)]" style={{ width: `${Math.round((setup.done / Math.max(setup.total, 1)) * 100)}%` }} />
      </span>
    </Link>
  );
}

type ListProps = {
  view: DashboardNav;
  pathname: string;
  collapsed: boolean;
  locks: NavLocks | undefined;
  scope: LaunchScope | undefined;
  onNavigate?: () => void;
};

/** The groups, used by the rail and the phone drawer alike. */
function NavSections({ view, pathname, collapsed, locks, scope, onNavigate, idPrefix }: ListProps & { idPrefix: string }) {
  return (
    <>
      {view.sections.map((section, index) => (
        <div key={section.title ?? 'top'}>
          {section.title && !collapsed ? (
            <p id={`${idPrefix}-group-${index}`} className="mb-1 px-2 text-[12px] font-semibold uppercase tracking-widest text-white/80">
              {section.title}
            </p>
          ) : section.title ? (
            <span aria-hidden="true" className="mx-auto mb-2 block h-px w-8 bg-white/15" />
          ) : null}
          <ul className="space-y-0.5" aria-labelledby={section.title && !collapsed ? `${idPrefix}-group-${index}` : undefined}>
            {section.items.map((item) => (
              <li key={item.href}>
                <NavLink item={item} pathname={pathname} collapsed={collapsed} locks={locks} scope={scope} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Settings (with Account setup under it once setup is complete) and Support. */
function UtilityLinks({ view, pathname, collapsed, locks, scope, onNavigate }: ListProps) {
  return (
    <ul className="space-y-0.5">
      {view.utility.map((item) => (
        <li key={item.href}>
          <NavLink item={item} pathname={pathname} collapsed={collapsed} locks={locks} scope={scope} onNavigate={onNavigate} />
          {item.children?.length ? (
            <ul className="mt-0.5 space-y-0.5">
              {item.children.map((child) => (
                <li key={child.href}>
                  <NavLink item={child} pathname={pathname} collapsed={collapsed} locks={locks} scope={scope} nested onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function DashboardShell({ children, session, kyb, locks, setup, sweepOn, launchScope, governanceAlerts }: DashboardShellProps) {
  const [collapsed,  setCollapsed]  = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const router   = useRouter();
  const pathname = usePathname();
  const view = dashboardNav(setup);
  const drawerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  function closeDrawer() {
    setMobileOpen(false);
    toggleRef.current?.focus();
  }

  // The phone menu is a modal dialog: focus moves in, Escape closes it, the
  // page behind does not scroll, and focus returns to the menu button.
  useEffect(() => {
    if (!mobileOpen) return;
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen]);

  /** Keep Tab inside the open drawer. */
  function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !drawerRef.current) return;
    const focusable = drawerRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const pageClosed = pageLock(pathname, locks, launchScope);

  return (
    <div className="fintech-dashboard-shell flex min-h-screen splash-page-bg">
      <a
        href="#dashboard-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-[var(--ink)] focus:shadow-lg"
      >
        Skip to content
      </a>

      {/* ── Desktop top header ───────────────────────────────── */}
      <DashboardHeader collapsed={collapsed} session={session} onLogout={logout} />

      {/* ── Desktop sidebar ──────────────────────────────────── */}
      <aside
        className={`fintech-dashboard-sidebar hidden flex-col bg-[var(--ink)] p-4 text-white transition-all duration-300 md:flex fixed left-0 top-0 z-30 h-screen ${
          collapsed ? 'w-20' : 'w-60'
        }`}
      >
        {/* Logo / collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className={`mb-3 flex min-h-11 items-center rounded-xl transition-colors hover:bg-white/10 ${
            collapsed ? 'mx-auto justify-center p-2' : 'gap-3 px-2 py-2'
          }`}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          aria-controls="dashboard-rail"
        >
          <Image
            src="/splash-main-icon.png"
            alt=""
            width={48}
            height={47}
            className="h-auto w-8 shrink-0 object-contain"
            loading="eager"
            unoptimized
          />
          {!collapsed && (
            <span className="grid text-left">
              <strong className="text-xl font-semibold tracking-tight text-white">
                Splash<span className="text-[#bfe6ee]">.</span>
              </strong>
              {/* 12px is the floor; in capitals with wide tracking it took three lines. */}
              <small className="text-[12px] font-medium text-white/80">Global settlement engine</small>
            </span>
          )}
        </button>

        <nav id="dashboard-rail" aria-label="Dashboard" className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto">
            <NavSections view={view} pathname={pathname} collapsed={collapsed} locks={locks} scope={launchScope} idPrefix="rail" />
          </div>

          <div className="pt-3">
            {view.setup ? <SetupCard setup={view.setup} pathname={pathname} collapsed={collapsed} /> : null}

            {!collapsed && (
              <p className="mb-2 flex min-h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.07] px-2.5 text-[12px]">
                <Image src="/isometric/sui-logo-clean.svg" alt="" width={12} height={16} className="h-4 w-3 object-contain" />
                <span className="whitespace-nowrap font-medium text-white/90">Settlement rail</span>
                <strong className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-white">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
                  Sui mainnet
                </strong>
              </p>
            )}

            <div className="border-t border-white/10 pt-3">
              <UtilityLinks view={view} pathname={pathname} collapsed={collapsed} locks={locks} scope={launchScope} />
            </div>
          </div>
        </nav>
        {/* Log out lives in the profile menu of the header on desktop (and at
            the foot of the phone drawer); the rail keeps its height for the
            pages, so all nine fit a 900px window. */}
      </aside>

      {/* ── Mobile top header ─────────────────────────────────── */}
      <header className="fixed left-0 right-0 top-0 z-40 flex h-[60px] items-center justify-between bg-[var(--ink)] px-4 md:hidden">
        <Link href="/dashboard" className="flex min-h-11 items-center gap-3 rounded-lg">
          <Image
            src="/splash-main-icon.png"
            alt=""
            width={48}
            height={47}
            className="h-auto w-7 object-contain"
            loading="eager"
            unoptimized
          />
          <span className="text-lg font-semibold text-white">
            Splash<span className="text-[#bfe6ee]">.</span>
            <span className="sr-only">, Home</span>
          </span>
        </Link>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setMobileOpen(true)}
          className="grid h-11 w-11 place-items-center rounded-lg text-white hover:bg-white/10"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="dashboard-drawer"
          aria-haspopup="dialog"
        >
          <Menu size={24} aria-hidden="true" />
        </button>
      </header>

      {/* ── Phone drawer ──────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-0 bg-[var(--ink)]/55 backdrop-blur-[2px]"
            onClick={closeDrawer}
          />
          <div
            id="dashboard-drawer"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onKeyDown={trapFocus}
            className="fintech-dashboard-sidebar absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col bg-[var(--ink)] text-white shadow-2xl"
          >
            <div className="flex h-[60px] shrink-0 items-center justify-between px-4">
              <span className="text-lg font-semibold text-white">
                Splash<span className="text-[#bfe6ee]">.</span>
              </span>
              <button
                ref={closeRef}
                type="button"
                onClick={closeDrawer}
                className="grid h-11 w-11 place-items-center rounded-lg text-white hover:bg-white/10"
                aria-label="Close navigation"
              >
                <X size={24} aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Dashboard" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
              <div className="space-y-4">
                <NavSections view={view} pathname={pathname} collapsed={false} locks={locks} scope={launchScope} onNavigate={() => setMobileOpen(false)} idPrefix="drawer" />
              </div>
              <div className="mt-5">
                {view.setup ? <SetupCard setup={view.setup} pathname={pathname} collapsed={false} onNavigate={() => setMobileOpen(false)} /> : null}
                <div className="border-t border-white/10 pt-3">
                  <UtilityLinks view={view} pathname={pathname} collapsed={false} locks={locks} scope={launchScope} onNavigate={() => setMobileOpen(false)} />
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setMobileOpen(false); logout(); }}
                className="mt-3 flex min-h-11 items-center gap-3 rounded-lg border-t border-white/10 px-2 py-3 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-[var(--gold-light)]"
              >
                <LogOut size={18} aria-hidden="true" />
                <span className="font-medium">Log out</span>
              </button>
            </nav>
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────── */}
      {/* Mobile top pad = 60 px (mobile header); desktop = 76 px (desktop header + gap) */}
      <main
        id="dashboard-content"
        tabIndex={-1}
        className={`fintech-dashboard-main relative z-0 min-w-0 flex-1 overflow-x-hidden outline-none transition-all duration-300 p-4 pt-[76px] pb-16 md:px-8 md:pb-8 md:pt-[76px] ${
          collapsed ? 'md:ml-20' : 'md:ml-60'
        }`}
      >
        {/* Above the KYB banner and above any page lock: it asks every owner
            to act before a date, whatever else the workspace is waiting on. */}
        <GovernanceAlertBanner alerts={governanceAlerts ?? []} />
        {kyb?.blocked ? (
          <div
            role="status"
            className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-4 py-3"
          >
            <ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--warn)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-[#8b6418]">Read-only workspace</p>
              <p className="mt-0.5 text-[13px] font-medium text-[var(--slate)]">{kyb.reason}</p>
            </div>
            <Link
              href="/settings/kyb"
              className="inline-flex min-h-11 items-center rounded-md bg-[var(--ink)] px-3 text-[13px] font-bold text-white"
            >
              Verification
            </Link>
          </div>
        ) : null}
        {pageClosed ? (
          <section className="dash-surface mx-auto mt-10 max-w-lg p-8 text-center">
            <Lock aria-hidden="true" className="mx-auto h-8 w-8 text-[var(--slate)]" />
            <h2 className="mt-4 text-lg font-bold text-[var(--ink)]">Not open yet</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--slate)]">{pageClosed.reason}</p>
            <Link
              href={pageClosed.href}
              className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-lg bg-[var(--ink)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--slate)]"
            >
              {pageClosed.action}
            </Link>
          </section>
        ) : (
          // The same custodyOn the layout resolves, for pages that cannot
          // import the server gate (StepDelivery's fund-holding tiers), and
          // the sweep switch the transfer routes also enforce.
          <SweepSwitchContext value={sweepOn ?? false}>
            <CustodyPhaseContext value={locks?.custodyOn ?? false}>
              <LaunchScopeContext value={launchScope ?? 'full'}>{children}</LaunchScopeContext>
            </CustodyPhaseContext>
          </SweepSwitchContext>
        )}
      </main>

      {/* ── Floating AI Copilot widget ────────────────────────── */}
      <FloatingCopilot />
    </div>
  );
}
