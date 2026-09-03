'use client';

import Image from 'next/image';
import { useState, type ReactNode } from 'react';
import FloatingCopilot from '@/components/FloatingCopilot';
import DashboardHeader from '@/components/DashboardHeader';
import type { CustomerSession } from '@/lib/auth/customer-session';
import {
  Bot,
  FileText,
  History,
  Layers,
  LayoutDashboard,
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
    title: 'Payments',
    items: [
      { label: '0xWal',        href: '/dashboard',          icon: Bot, badge: 'AI' },
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
};

export default function DashboardShell({ children, session, kyb }: DashboardShellProps) {
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
                  return (
                    <Link
                      key={href}
                      href={href}
                      title={collapsed ? label : undefined}
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
                          <span className="flex-1 font-medium">{label}</span>
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
                  href={href}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-white transition-colors hover:bg-white/10 ${
                    pathname === href ? 'bg-white/15' : ''
                  }`}
                >
                  <Icon size={20} />
                  <span className="font-medium">{label}</span>
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
        {children}
      </main>

      {/* ── Floating AI Copilot widget ────────────────────────── */}
      <FloatingCopilot />
    </div>
  );
}
