/**
 * The dashboard navigation, as data (v2 brief 5.1).
 *
 *   Home · Zeke (AI)
 *   Payments: Transfer, Batch payouts, Invoices
 *   Money: Wallet, Treasury
 *   Contacts: Recipients, History
 *   Settings · Support
 *
 * Account setup sits on the rail, with its progress, until the required
 * steps are done, and under Settings after. Rate holds left the nav (quote
 * holds stay in the backend) and Send USDC became Wallet; their old URLs
 * redirect.
 *
 * No I/O and no React: components/dashboard/DashboardShell.tsx ships this to
 * the browser, and tests/dashboard-nav.test.mjs runs it as plain Node.
 *
 * The padlocks are presentation. They are computed from the same server
 * truths the money routes enforce (app/dashboard/layout.tsx resolves them),
 * and the routes stay the security.
 */

import { LAUNCH_SCOPE_REASON, type LaunchScope } from '@/lib/launch-scope-rules';

export type NavIcon =
  | 'home'
  | 'zeke'
  | 'transfer'
  | 'batch'
  | 'invoices'
  | 'wallet'
  | 'treasury'
  | 'recipients'
  | 'history'
  | 'settings'
  | 'support'
  | 'setup';

export type NavItem = {
  label: string;
  href: string;
  icon: NavIcon;
  badge?: string;
  /** Other paths that belong to this page (a receipt belongs to History). */
  also?: string[];
  /** Pages that sit under this one in the rail. */
  children?: NavItem[];
};

export type NavSection = { title: string | null; items: NavItem[] };

/** Onboarding progress, from lib/server/onboarding.ts (steps 1-4 required). */
export type SetupProgress = { done: number; total: number; complete: boolean };

export type NavLocks = { termsDone: boolean; moneyBlocked: boolean; custodyOn: boolean; reason: string };

export type PageLock = { reason: string; href: string; action: string };

const SETUP: NavItem = { label: 'Account setup', href: '/dashboard/setup', icon: 'setup' };

const SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      { label: 'Home',          href: '/dashboard',            icon: 'home' },
      { label: 'Zeke',          href: '/dashboard/zeke',       icon: 'zeke', badge: 'AI' },
    ],
  },
  {
    title: 'Payments',
    items: [
      { label: 'Transfer',      href: '/dashboard/transfer',   icon: 'transfer' },
      { label: 'Batch payouts', href: '/dashboard/batch',      icon: 'batch' },
      { label: 'Invoices',      href: '/dashboard/invoices',   icon: 'invoices' },
    ],
  },
  {
    title: 'Money',
    items: [
      { label: 'Wallet',        href: '/dashboard/wallet',     icon: 'wallet' },
      { label: 'Treasury',      href: '/dashboard/treasury',   icon: 'treasury' },
    ],
  },
  {
    title: 'Contacts',
    items: [
      { label: 'Recipients',    href: '/dashboard/recipients', icon: 'recipients' },
      { label: 'History',       href: '/dashboard/history',    icon: 'history', also: ['/dashboard/audit'] },
    ],
  },
];

const SETTINGS: NavItem = { label: 'Settings', href: '/dashboard/settings', icon: 'settings' };
const SUPPORT: NavItem = { label: 'Support', href: '/dashboard/customer-service', icon: 'support' };

export type DashboardNav = {
  sections: NavSection[];
  utility: NavItem[];
  /** The setup step still to finish, shown on its own; null once complete. */
  setup: { href: string; label: string; done: number; total: number } | null;
};

/**
 * The rail for this workspace. `setup` is undefined when the onboarding state
 * could not be read (no database on a dev machine): nothing to nag about, and
 * the setup page stays reachable under Settings.
 */
export function dashboardNav(setup: SetupProgress | undefined): DashboardNav {
  const pending = setup !== undefined && !setup.complete;
  return {
    sections: SECTIONS,
    utility: [pending ? SETTINGS : { ...SETTINGS, children: [SETUP] }, SUPPORT],
    setup: pending ? { href: SETUP.href, label: SETUP.label, done: setup.done, total: setup.total } : null,
  };
}

/** The paths each nav page owns besides its own (History owns the receipts). */
const ALSO = new Map(SECTIONS.flatMap((section) => section.items).map((item) => [item.href, item.also ?? []]));

/** Whether `href` is the page being shown. Home only on Home; others by path segment. */
export function isCurrent(href: string, pathname: string, also: string[] = ALSO.get(href) ?? []): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return [href, ...also].some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** The pages a USDC-only launch does not open; their routes answer 403. */
const OUT_OF_STABLECOIN_SCOPE = ['/dashboard/transfer', '/dashboard/batch', '/dashboard/treasury'];

/** Pages that spend: the routes require BOTH the KYB gate and the terms. */
const SPEND = ['/dashboard/transfer', '/dashboard/batch', '/dashboard/treasury'];

/** Pages that need the terms only. Wallet is the lane an unverified business may
 *  use (lib/payments/stablecoin-lane.ts); its page states any lane lock itself. */
const TERMS_ONLY = ['/dashboard/invoices', '/dashboard/recipients', '/dashboard/wallet'];

const TERMS_REASON = 'Accept the terms in Account setup to start here.';

/**
 * Why a page is closed, and where to go instead. The launch scope answers
 * first: no verification or setup step opens what this launch leaves out.
 * `locks` absent (no database on a dev machine) means nothing is locked,
 * mirroring the gates' own dev posture.
 */
export function pageLock(href: string, locks: NavLocks | undefined, scope: LaunchScope | undefined): PageLock | null {
  if (scope === 'stablecoin' && OUT_OF_STABLECOIN_SCOPE.includes(href)) {
    return { reason: LAUNCH_SCOPE_REASON, href: '/dashboard/wallet', action: 'Open Wallet' };
  }
  const reason = locks ? lockReasonFor(href, locks) : null;
  return reason ? { reason, href: '/dashboard/setup', action: 'Finish account setup' } : null;
}

/**
 * The lock table. Home and Zeke stay open at every state: Zeke cannot move
 * money regardless (three independent gates prove it) and Home is a read.
 * Everything that spends follows the KYB gate and the terms; Invoices,
 * Recipients and Wallet only need the terms. Treasury is the business's own
 * wallet buying USDY (D9), so the custody phase no longer locks it; its page
 * and routes say what is open.
 */
function lockReasonFor(href: string, locks: NavLocks): string | null {
  // Parity with the routes, or the padlock lies: a nav item that only checked
  // KYB would read as open and then answer 412 on submit.
  if (SPEND.includes(href)) {
    if (locks.moneyBlocked) return locks.reason;
    return locks.termsDone ? null : TERMS_REASON;
  }
  // History is a read of past transfers: nothing to show before verification,
  // and nothing it can spend, so the terms do not gate it.
  if (href === '/dashboard/history') return locks.moneyBlocked ? locks.reason : null;
  if (TERMS_ONLY.includes(href)) return locks.termsDone ? null : TERMS_REASON;
  return null;
}
