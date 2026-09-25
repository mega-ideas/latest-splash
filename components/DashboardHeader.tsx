'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ChevronDown,
  LogOut,
  Search,
  Settings,
  UserRound,
} from 'lucide-react';

import type { CustomerSession } from '@/lib/auth/customer-session';

interface DashboardHeaderProps {
  collapsed: boolean;
  session: CustomerSession;
  onLogout: () => void | Promise<void>;
}

function initialsFor(session: CustomerSession) {
  const source = session.name || session.organization || session.email;
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'S';
}

export default function DashboardHeader({ collapsed, session, onLogout }: DashboardHeaderProps) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [avatar,      setAvatar]      = useState<string | null>(null);

  const profileRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initials = initialsFor(session);

  /* Close profile dropdown on outside click */
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  useEffect(() => {
    return () => {
      if (avatar) URL.revokeObjectURL(avatar);
    };
  }, [avatar]);

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const nextAvatar = URL.createObjectURL(file);
    setAvatar((current) => {
      if (current) URL.revokeObjectURL(current);
      return nextAvatar;
    });
    setProfileOpen(false);
  }

  return (
    <header
      className={`fintech-dashboard-header fixed top-0 right-0 z-20 hidden h-[60px] items-center justify-between border-b border-[#326273]/10 bg-[#F6F0ED] px-5 shadow-sm md:flex transition-[left] duration-300 ${
        collapsed ? 'left-20' : 'left-60'
      }`}
    >
      {/* ── Search ─────────────────────────────────────────── */}
      <div className="flex max-w-sm flex-1 items-center gap-2 rounded-xl border border-[#326273]/10 bg-white px-3 py-2 shadow-sm">
        <Search size={14} className="shrink-0 text-[#326273]/90" />
        <input
          type="text"
          aria-label="Search dashboard"
          placeholder="Search dashboard…"
          className="flex-1 bg-transparent text-sm text-[#326273] placeholder-[#326273]/35 outline-none"
        />
      </div>

      {/* ── Right controls ─────────────────────────────────── */}
      <div className="flex items-center gap-2.5">

        {/* Profile + dropdown */}
        <div ref={profileRef} className="relative">
          <button
            type="button"
            onClick={() => setProfileOpen((v) => !v)}
            className="flex items-center gap-2 rounded-xl border border-[#326273]/10 bg-white py-1.5 pl-1.5 pr-2.5 shadow-sm transition-colors hover:bg-[#F6F0ED]"
            aria-haspopup="menu"
            aria-expanded={profileOpen}
          >
            {/* Avatar */}
            <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#1F4452]">
              {avatar
                ? <Image src={avatar} alt="Profile" width={28} height={28} unoptimized className="h-full w-full object-cover" />
                : <span className="text-[13px] font-semibold text-white">{initials}</span>
              }
            </div>
            {/* Name */}
            <div className="hidden text-left sm:block">
              <div className="text-[13px] font-medium leading-none text-[#326273]">{session.name}</div>
              <div className="mt-0.5 text-[13px] capitalize leading-none text-[#326273]/90">{session.role.replace('_', ' ')}</div>
            </div>
            <ChevronDown
              size={13}
              className={`text-[#326273]/90 transition-transform duration-200 ${profileOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {profileOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-52 overflow-hidden rounded-2xl border border-[#326273]/10 bg-white shadow-xl" role="menu">
              {/* User info header */}
              <div className="flex items-center gap-3 border-b border-[#326273]/8 px-4 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#1F4452]">
                  {avatar
                    ? <Image src={avatar} alt="Profile" width={36} height={36} unoptimized className="h-full w-full object-cover" />
                    : <span className="text-sm font-semibold text-white">{initials}</span>
                  }
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#326273]">{session.organization}</div>
                  <div className="truncate text-[13px] text-[#326273]/90">
                    {session.email}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="space-y-0.5 p-1.5">
                <Link
                  href="/dashboard/profile"
                  onClick={() => setProfileOpen(false)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] text-[#326273]/90 transition-colors hover:bg-[#F6F0ED] hover:text-[#326273]"
                  role="menuitem"
                >
                  <UserRound size={13} />
                  My profile
                </Link>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] text-[#326273]/90 transition-colors hover:bg-[#F6F0ED] hover:text-[#326273]"
                  role="menuitem"
                >
                  <Camera size={13} />
                  Change profile photo
                </button>
                <Link
                  href="/dashboard/settings"
                  onClick={() => setProfileOpen(false)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] text-[#326273]/90 transition-colors hover:bg-[#F6F0ED] hover:text-[#326273]"
                  role="menuitem"
                >
                  <Settings size={13} />
                  Account settings
                </Link>
              </div>

              <div className="border-t border-[#326273]/8 p-1.5">
                <button
                  type="button"
                  onClick={onLogout}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] text-[#9f5839] transition-colors hover:bg-orange-50"
                  role="menuitem"
                >
                  <LogOut size={13} />
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Hidden file input for avatar upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleAvatarChange}
        />
      </div>
    </header>
  );
}
