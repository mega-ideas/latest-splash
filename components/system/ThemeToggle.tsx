'use client';

import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'splash-theme';
const CHANGE_EVENT = 'splash-theme-change';

function currentTheme(): Theme {
  const chosen = document.documentElement.getAttribute('data-theme');
  if (chosen === 'dark' || chosen === 'light') return chosen;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  media.addEventListener('change', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
    media.removeEventListener('change', onChange);
  };
}

/**
 * Manual light/dark toggle. Stores the choice per browser and stamps
 * data-theme on <html>; with no choice the system preference applies
 * (see styles/tokens.css). app/layout.tsx applies the stored value before
 * first paint so there is no flash. The server snapshot is "light"; the
 * client resolves the real theme on hydration.
 */
export default function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as Theme);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage may be unavailable; the attribute still applies */
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-pressed={theme === 'dark'}
      className={cn(
        'inline-flex size-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] text-[var(--text-2)] outline-none transition-colors hover:bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]',
        className,
      )}
    >
      {theme === 'dark' ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
    </button>
  );
}
