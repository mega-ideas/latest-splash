'use client';

import Image from 'next/image';
import { useState, type ReactNode } from 'react';
import FloatingCopilot from '@/components/FloatingCopilot';
import DashboardHeader from '@/components/DashboardHeader';
import { CustodyPhaseContext } from '@/components/dashboard/CustodyPhaseContext';
import type { CustomerSession } from '@/lib/auth/customer-session';
import {
  Bot,
  FileText,
  History,
  Layers,
  LayoutDashboard,
  ListChecks,
  Lock,
  LogOut,
  Menu,
  Phone,
  Send,
  Settings,
  Timer,
  TrendingUp,
  UserCircle,
  X,
  type LucideIcon,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

// ─── Nav structure ────────────────────────────────────────────────────────────

type NavItem = { label: string; href: string; icon: LucideIcon; badge?: string };
type NavGroup = { title: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    title: 'Getting started',
    items: [{ label: 'Account setup', href: '/dashboard/setup', icon: ListChecks }],
  },
  {
    title: 'Payments',
    items: [
      { label: 'Zeke',        href: '/dashboard',          icon: Bot, badge: 'AI' },
      { label: 'Transfer',     href: '/dashboard/transfer', icon: Send },
      { label: 'Rate holds',   href: '/dashboard/transfers', icon: Timer },
      { label: 'Batch Payout', href: '/dashboard/batch',    icon: Layers },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Overview', href: '/dashboard/overview', icon: LayoutDashboard },
      { label: 'Treasury', href: '/dashboard/treasury', icon: TrendingUp },
      { label: 'Invoices', href: '/dashboard/invoices', icon: FileText },
    ],
  },
  {
    title: 'Contacts',
    items: [
      { label: 'Recipients', href: '/dashboard/recipients', icon: UserCircle },
      { label: 'History',    href: '/dashboard/history',    icon: History },
    ],
  },
];

// ─── Layout ───────────────────────────────────────────────────────────────────

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
  locks?: { termsDone: boolean; moneyBlocked: boolean; custodyOn: boolean; reason: string };
};

/**
 * The Stablecorp-pattern lock table. Zeke and Overview stay open at every
 * state: Zeke cannot move money regardless (three independent gates prove
 * it) and Overview is a read. Everything that spends follows the KYB gate;
 * Invoices and Recipients only need the terms; Treasury also needs the
 * custody phase.
 */
function lockReasonFor(
  href: string,
  locks: NonNullable<DashboardShellProps['locks']>,
): string | null {
  // Parity with the routes, or the padlock lies: the spend routes require
  // BOTH the KYB gate and the terms (requireTermsAccepted), so a nav item
  // that only checked KYB would read as open and then answer 412 on submit.
  const spend = ['/dashboard/transfer', '/dashboard/transfers', '/dashboard/batch'];
  const termsOnly = ['/dashboard/invoices', '/dashboard/recipients'];
  const termsReason = 'Accept the terms in Account setup to start here.';
  if (href === '/dashboard/treasury') {
    if (locks.moneyBlocked) return locks.reason;
    if (!locks.termsDone) return termsReason;
    if (!locks.custodyOn) return 'Treasury arrives with our licence. Nothing is held for you today.';
    return null;
  }
  if (spend.includes(href)) {
    if (locks.moneyBlocked) return locks.reason;
    return locks.termsDone ? null : termsReason;
  }
  // History is a read of past transfers: nothing to show before verification,
  // and nothing it can spend, so the terms do not gate it.
  if (href === '/dashboard/history') return locks.moneyBlocked ? locks.reason : null;
  if (termsOnly.includes(href)) return locks.termsDone ? null : termsReason;
  return null;
}

export default function DashboardShell({ children, session, kyb, locks }: DashboardShellProps) {
  const [collapsed,  setCollapsed]  = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const router   = useRouter();
  const pathname = usePathname();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="fintech-dashboard-shell flex min-h-screen splash-page-bg">

      {/* ── Desktop top header ───────────────────────────────── */}
      <DashboardHeader collapsed={collapsed} session={session} onLogout={logout} />

      {/* ── Desktop sidebar ──────────────────────────────────── */}
      <aside
        className={`fintech-dashboard-sidebar hidden flex-col bg-[#1F4452] p-4 text-white transition-all duration-300 md:flex fixed left-0 top-0 z-30 h-screen ${
          collapsed ? 'w-20' : 'w-60'
        }`}
      >
        {/* Logo / collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className={`mb-8 flex items-center rounded-xl transition-colors hover:bg-white/10 ${
            collapsed ? 'mx-auto justify-center p-2' : 'gap-3 px-2 py-2'
          }`}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <Image
            src="/splash-main-icon.png"
            alt="Splash"
            width={48}
            height={47}
            className="h-auto w-8 shrink-0 object-contain"
            loading="eager"
            unoptimized
          />
          {!collapsed && (
            <span className="grid text-left">
              <strong className="text-xl font-semibold tracking-tight text-white">
                Splash<span className="text-[#5C9EAD]">.</span>
              </strong>
              <small className="text-[8px] font-semibold uppercase tracking-[0.18em] text-white/40">Global settlement engine</small>
            </span>
          )}
        </button>

        {/* Nav groups */}
        <nav className="flex-1 space-y-5 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.title}>
              {!collapsed && (
                <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-white/25">
                  {group.title}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map(({ label, href, icon: Icon, badge }) => {
                  const active = pathname === href;
                  const lockReason = locks ? lockReasonFor(href, locks) : null;
                  return (
                    <Link
                      key={href}
                      href={lockReason ? '/dashboard/setup' : href}
                      aria-disabled={lockReason ? true : undefined}
                      title={lockReason ?? (collapsed ? label : undefined)}
                      className={`relative flex items-center rounded-lg px-2 py-2 text-sm transition-colors ${
                        collapsed ? 'justify-center' : 'gap-3'
                      } ${
                        active
                          ? collapsed
                            ? 'bg-white text-[#1F4452] shadow-sm'
                            : 'bg-white pl-3 text-[#1F4452] shadow-sm'
                          : 'text-white/55 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {active && !collapsed && <span aria-hidden="true" className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-[#5C9EAD]" />}
                      <Icon size={18} className={active ? 'text-[#5C9EAD]' : ''} />
                      {!collapsed && (
                        <>
                          <span className={`flex-1 font-medium ${lockReason ? 'opacity-50' : ''}`}>{label}</span>
                          {lockReason && <Lock size={13} aria-hidden="true" className="text-white/35" />}
                          {badge && (
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[13px] font-semibold ${
                                badge === 'New'
                                  ? 'bg-[#E39774]/25 text-[#E39774]'
                                  : 'bg-[#5C9EAD]/20 text-[#5C9EAD]'
                              }`}
                            >
                              {badge}
                            </span>
                          )}
                        </>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom items */}
        {!collapsed && (
          <div className="fintech-sidebar-signal">
            <Image src="/isometric/sui-logo-clean.svg" alt="" width={32} height={42} />
            <span>
              <small>Settlement rail</small>
              <strong><i /> Sui testnet ready</strong>
            </span>
          </div>
        )}

        <div className="space-y-0.5 border-t border-white/10 pt-4">
          <Link
            href="/dashboard/settings"
            title={collapsed ? 'Settings' : undefined}
            className={`flex items-center rounded-lg px-2 py-2 text-sm transition-colors hover:bg-white/10 hover:text-white ${
              collapsed ? 'justify-center' : 'gap-3'
            } ${
              pathname === '/dashboard/settings'
                ? 'bg-white/15 text-white'
                : 'text-white/55'
            }`}
          >
            <Settings size={18} />
            {!collapsed && <span className="font-medium">Settings</span>}
          </Link>
          <Link
            href="/dashboard/customer-service"
            title={collapsed ? 'Support' : undefined}
            className={`flex items-center rounded-lg px-2 py-2 text-sm text-white/55 transition-colors hover:bg-white/10 hover:text-white ${
              collapsed ? 'justify-center' : 'gap-3'
            }`}
          >
            <Phone size={18} />
            {!collapsed && <span className="font-medium">Support</span>}
          </Link>
          <button
            type="button"
            onClick={logout}
            title={collapsed ? 'Log out' : undefined}
            className={`flex w-full items-center rounded-lg px-2 py-2 text-sm text-white/55 transition-colors hover:bg-white/10 hover:text-[#E39774] ${
              collapsed ? 'justify-center' : 'gap-3'
            }`}
          >
            <LogOut size={18} />
            {!collapsed && <span className="font-medium">Log out</span>}
          </button>
        </div>
      </aside>

      {/* ── Mobile top header ─────────────────────────────────── */}
      <header className="fixed left-0 right-0 top-0 z-40 flex items-center justify-between bg-[#1F4452] px-4 py-3 md:hidden">
        <div className="flex items-center gap-3">
          <Image
            src="/splash-main-icon.png"
            alt="Splash"
            width={48}
            height={47}
            className="h-auto w-7 object-contain"
            loading="eager"
            unoptimized
          />
          <span className="text-lg font-semibold text-white">
            Splash<span className="text-[#5C9EAD]">.</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="text-white"
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </header>

      {/* ── Mobile overlay ────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 bg-[#1F4452] pt-16 md:hidden">
          <div className="flex h-full flex-col p-6">
            <nav className="flex-1 space-y-1 overflow-y-auto">
              {navGroups.flatMap((g) => g.items).map(({ label, href, icon: Icon }) => (
                <Link
                  key={href}
                  onClick={() => setMobileOpen(false)}
                  href={locks && lockReasonFor(href, locks) ? '/dashboard/setup' : href}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-white transition-colors hover:bg-white/10 ${
                    pathname === href ? 'bg-white/15' : ''
                  }`}
                >
                  <Icon size={20} />
                  <span className={`font-medium ${locks && lockReasonFor(href, locks) ? 'opacity-50' : ''}`}>{label}</span>
                  {locks && lockReasonFor(href, locks) ? <Lock size={14} aria-hidden="true" className="ml-auto text-white/35" /> : null}
                </Link>
              ))}
            </nav>
            <button
              type="button"
              onClick={() => { setMobileOpen(false); logout(); }}
              className="flex items-center gap-3 rounded-xl px-4 py-3 text-white transition-colors hover:bg-white/10 hover:text-[#E39774]"
            >
              <LogOut size={20} />
              <span className="font-medium">Log out</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────── */}
      {/* Mobile top pad = 60 px (mobile header); desktop = 76 px (desktop header + gap) */}
      <main
        className={`fintech-dashboard-main relative z-0 min-w-0 flex-1 overflow-x-hidden transition-all duration-300 p-4 pt-[60px] pb-16 md:px-8 md:pb-8 md:pt-[76px] ${
          collapsed ? 'md:ml-20' : 'md:ml-60'
        }`}
      >
        {kyb?.blocked ? (
          <div
            role="status"
            className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-4 py-3"
          >
            <ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--warn)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-[var(--warn)]">Read-only workspace</p>
              <p className="mt-0.5 text-[13px] font-medium text-[#326273]/78">{kyb.reason}</p>
            </div>
            <Link
              href="/settings/kyb"
              className="rounded-md bg-[#1F4452] px-3 py-1.5 text-[13px] font-bold text-white"
            >
              Verification
            </Link>
          </div>
        ) : null}
        {locks && lockReasonFor(pathname, locks) ? (
          <section className="dash-surface mx-auto mt-10 max-w-lg p-8 text-center">
            <Lock aria-hidden="true" className="mx-auto h-8 w-8 text-[#C9BDB5]" />
            <h2 className="mt-4 text-lg font-bold text-[#1F4452]">Not open yet</h2>
            <p className="mt-2 text-sm leading-relaxed text-[#326273]">{lockReasonFor(pathname, locks)}</p>
            <Link
              href="/dashboard/setup"
              className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-lg bg-[#1F4452] px-5 text-sm font-semibold text-white transition hover:bg-[#326273]"
            >
              Finish account setup
            </Link>
          </section>
        ) : (
          // The same custodyOn the Treasury padlock reads, for pages that
          // cannot import the server gate (StepDelivery's fund-holding tiers).
          <CustodyPhaseContext value={locks?.custodyOn ?? false}>{children}</CustodyPhaseContext>
        )}
      </main>

      {/* ── Floating AI Copilot widget ────────────────────────── */}
      <FloatingCopilot />
    </div>
  );
}
