'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';

import { adminConsolePath } from '@/lib/admin-routing';
import { cn } from '@/lib/utils';

export default function AdminLogoutButton({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  const router = useRouter();

  async function logout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    toast.success('Staff session ended');
    router.replace(adminConsolePath('/login', window.location.hostname));
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={() => void logout()}
      className={cn(
        'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition',
        variant === 'dark'
          ? 'border-white/10 text-white/75 hover:bg-white/10 hover:text-[var(--gold-light)]'
          : 'border-[#326273]/10 bg-white text-[#326273] hover:border-[var(--gold-light)] hover:text-[var(--gold-ink)]',
      )}
    >
      <LogOut className="h-4 w-4" />
      Logout
    </button>
  );
}
