'use client';

import { Bot, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import { Button, ChatComposer } from '@/components/system';
import { brand } from '@/lib/brand';
import { readPendingProposals, subscribePendingProposals } from '@/lib/oxwal-notify';
import { cn } from '@/lib/utils';

/**
 * Floating 0xWal indicator — dashboard routes only, desktop only.
 *
 * It is a reminder and a shortcut, not a second chat: it shows how many
 * unsigned proposals are waiting, and its composer hands the prompt to the
 * desk (`/dashboard/oxwal?prompt=…&send=1`). On mobile the 0xWal tab carries a
 * dot instead, so nothing floats over the bottom tabs. The popover is a
 * non-modal dialog with a focus trap; Escape closes it and focus returns to
 * the launcher.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function subscribe(onChange: () => void) {
  return subscribePendingProposals(() => onChange());
}

export default function FloatingIndicator() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const count = useSyncExternalStore(subscribe, () => readPendingProposals().count, () => 0);
  const label = useSyncExternalStore(subscribe, () => readPendingProposals().label, () => null);

  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  }, []);

  // Move focus into the dialog when it opens.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>('textarea, ' + FOCUSABLE);
      first?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Route changes close the popover; the desk itself never shows it.
  useEffect(() => {
    const timer = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  if (!pathname?.startsWith('/dashboard') || pathname.startsWith('/dashboard/oxwal')) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handOff(text: string) {
    setOpen(false);
    router.push(`/dashboard/oxwal?prompt=${encodeURIComponent(text)}&send=1`);
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 hidden md:block">
      {open ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
          className="mb-3 w-[360px] max-w-[calc(100vw-2.5rem)] rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[var(--shadow-elevated)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id={titleId} className="text-[14px] font-semibold">
                {brand.agentName}
              </h2>
              <p className="mt-0.5 text-[13px] text-[var(--text-2)]">
                {count > 0
                  ? `${count} unsigned ${count === 1 ? 'proposal is' : 'proposals are'} waiting in Approvals${label ? ` · ${label}` : ''}.`
                  : 'Nothing is waiting for you. Ask for a read, a proposal, or an explanation.'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={close} aria-label="Close">
              <X aria-hidden="true" />
            </Button>
          </div>
          <ChatComposer className="mt-3" onSubmit={handOff} submitLabel="Ask on the desk" hint="Opens the desk · prepares only" placeholder={`Ask ${brand.agentName}…`} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" href="/dashboard/oxwal">
              Open desk
            </Button>
            {count > 0 ? (
              <Button variant="ghost" size="sm" href="/dashboard/approvals">
                Review in Approvals
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        ref={launcherRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count > 0 ? `${brand.agentName}: ${count} unsigned ${count === 1 ? 'proposal' : 'proposals'} waiting` : `Open ${brand.agentName}`}
        className={cn(
          'ml-auto flex h-12 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface)] pl-3 pr-4 text-[14px] font-semibold shadow-[var(--shadow-elevated)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--teal-100)]',
          open && 'ring-2 ring-[var(--teal-500)]',
        )}
      >
        <span className="grid size-8 place-items-center rounded-full bg-[var(--teal-100)] text-[var(--teal-600)]">
          <Bot className="size-4" aria-hidden="true" />
        </span>
        {brand.agentName}
        {count > 0 ? (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--amber-600)] px-1.5 font-mono text-[11px] font-semibold text-white" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </button>
    </div>
  );
}
