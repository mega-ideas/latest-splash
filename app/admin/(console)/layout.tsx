import Image from 'next/image';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Activity, ClipboardCheck, Headphones, LayoutDashboard, Settings2, UserRoundCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import AdminLogoutButton from '@/components/admin/AdminLogoutButton';
import FintechContextBar from '@/components/FintechContextBar';
import { adminConsolePath } from '@/lib/admin-routing';
import { getAdminSession } from '@/lib/server/admin-auth';

const navItems = [
  { label: 'Overview', href: '/admin', icon: LayoutDashboard },
  { label: 'Transactions', href: '/admin/transactions', icon: Activity },
  { label: 'KYB Review', href: '/admin/kyb', icon: ClipboardCheck },
  { label: 'Profile requests', href: '/admin/profile-requests', icon: UserRoundCheck },
  { label: 'Support', href: '/admin/support', icon: Headphones },
  { label: 'Contract config', href: '/admin/contracts', icon: Settings2 },
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
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/45">Staff console</div>
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

        <div className="rounded-2xl border border-white/10 bg-white/10 p-4 text-xs text-white/70">
          <div className="font-bold text-white">{session.name}</div>
          <div className="mt-1 break-all">{session.email}</div>
          <div className="mt-2 uppercase tracking-[0.16em] text-[#A7D6DF]">{session.role}</div>
        </div>
        <div className="mt-4">
          <AdminLogoutButton />
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-[#326273]/10 bg-[#E7EEF0]/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link href={adminConsolePath('/', hostname)} className="flex items-center gap-2 font-black text-[#326273]">
          <Image src="/splash-main-icon.png" alt="Splash" width={48} height={47} className="h-auto w-7" loading="eager" />
          Admin
        </Link>
        <div className="flex items-center gap-2">
          {navItems.map(({ href, icon: Icon }) => (
            <Link key={href} href={adminConsolePath(href.replace('/admin', '') || '/', hostname)} className="rounded-lg border border-[#326273]/10 bg-white p-2 text-[#326273]">
              <Icon className="h-4 w-4" />
            </Link>
          ))}
          <AdminLogoutButton variant="light" />
        </div>
      </header>

      <main className="fintech-admin-main min-h-screen p-4 lg:ml-64 lg:p-8">
        <FintechContextBar variant="admin" />
        {children}
      </main>
    </div>
  );
}
