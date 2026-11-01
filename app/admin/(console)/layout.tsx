import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Activity, ClipboardCheck, Database, Gauge, Headphones, Inbox, KeyRound, LayoutDashboard, ListChecks, Settings2, UserRoundCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import AdminLogoutButton from '@/components/admin/AdminLogoutButton';
import FintechContextBar from '@/components/FintechContextBar';
import { adminConsolePath } from '@/lib/admin-routing';
import { getAdminSession } from '@/lib/server/admin-auth';

const navItems = [
  { label: 'Overview', href: '/admin', icon: LayoutDashboard },
  { label: 'Transactions', href: '/admin/transactions', icon: Activity },
  { label: 'Audit batches', href: '/admin/audit-batches', icon: Database },
  { label: 'KYB Review', href: '/admin/kyb', icon: ClipboardCheck },
  { label: 'Profile requests', href: '/admin/profile-requests', icon: UserRoundCheck },
  { label: 'Support', href: '/admin/support', icon: Headphones },
  { label: 'Limit requests', href: '/admin/limits', icon: Gauge },
  { label: 'Access requests', href: '/admin/access-requests', icon: Inbox },
  { label: 'Contract config', href: '/admin/contracts', icon: Settings2 },
  { label: 'Go-live', href: '/admin/go-live', icon: ListChecks },
  { label: 'Workspace access', href: '/admin/memberships', icon: KeyRound },
];

export default async function AdminConsoleLayout({ children }: { children: ReactNode }) {
  const session = await getAdminSession();
  const headerStore = await headers();
  const hostname = headerStore.get('host');

  if (!session) {
    redirect(adminConsolePath('/login', hostname));
  }

  return (
    <div className="fintech-admin-shell min-h-screen bg-[linear-gradient(rgba(31,67,80,0.055),rgba(31,67,80,0.055)),#EEF4F5] text-[#1f4350]">
      <aside className="fintech-admin-sidebar fixed left-0 top-0 hidden h-screen w-64 flex-col bg-[#1f4350] p-6 text-white lg:flex">
        <Link href={adminConsolePath('/', hostname)} className="flex items-center gap-3">
          <Image src="/splash-main-icon.png" alt="Splash" width={48} height={47} className="h-auto w-9" loading="eager" />
          <div>
            <div className="text-xl font-black tracking-[-0.03em]">Splash Admin</div>
            <div className="text-[12px] font-medium text-white/80">Staff console</div>
          </div>
        </Link>

        <nav className="mt-10 flex-1 space-y-2">
          {navItems.map(({ label, href, icon: Icon }) => (
            <Link key={href} href={adminConsolePath(href.replace('/admin', '') || '/', hostname)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-white/75 transition hover:bg-white/10 hover:text-[#A7D6DF]">
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="fintech-admin-trust">
          <Image src="/isometric/secure-icon.svg" alt="" width={1448} height={1086} />
          <span>
            <small>Control posture</small>
            <strong>Compliance &amp; proof</strong>
          </span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/10 p-4 text-xs text-white/90">
          <div className="font-bold text-white">{session.name}</div>
          <div className="mt-1 break-all">{session.email}</div>
          <div className="mt-2 uppercase tracking-[0.16em] text-[#d8fff4]">{session.role}</div>
        </div>
        <div className="mt-4">
          <AdminLogoutButton />
        </div>
      </aside>

      {/* Phone and tablet: the brand and Log out on one row, the nine sections in
          a row of their own that scrolls inside itself. Nine icons beside the
          logo and the button were wider than a 390px screen and pushed the whole
          page sideways. Each link carries its name, because an icon alone does
          not say where it goes. */}
      <header className="sticky top-0 z-20 border-b border-[#326273]/10 bg-[#E7EEF0]/90 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <Link href={adminConsolePath('/', hostname)} className="flex min-h-11 items-center gap-2 font-black text-[#326273]">
            <Image src="/splash-main-icon.png" alt="" width={48} height={47} className="h-auto w-7" loading="eager" />
            Splash Admin
          </Link>
          <AdminLogoutButton variant="light" />
        </div>
        <nav aria-label="Staff console" className="flex gap-2 overflow-x-auto px-4 pb-3 pt-2 [scrollbar-width:thin]">
          {navItems.map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={adminConsolePath(href.replace('/admin', '') || '/', hostname)}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-[#326273]/15 bg-white px-3 text-sm font-semibold text-[#1f4350]"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="fintech-admin-main min-h-screen p-4 lg:ml-64 lg:p-8">
        <FintechContextBar variant="admin" />
        {children}
      </main>
    </div>
  );
}
