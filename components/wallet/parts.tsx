'use client';

/**
 * The small parts the Wallet page's sections share, so they cannot drift:
 * a card, a status pill (colour never carries the meaning alone: every pill
 * has words), a loader that says what failed, and one clipboard button.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert, Copy, Loader2 } from 'lucide-react';

import { usePhone } from '@/components/dashboard/Device';
import { call, errorText } from '@/components/transfer/api';
import { OPEN_SECTION_EVENT, foldsOnPhone, sectionFromHash } from '@/lib/wallet-page/phone';
import { loadView, type LoadState } from '@/lib/settings-page/load-state';
import type { Tone } from '@/lib/wallet-page/labels';

export function Card({ id, title, aside, children, className = '' }: { id?: string; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  const heading = id ? `${id}-title` : undefined;
  const phone = usePhone();
  // On a phone every section but what waits for a signature folds under its own title (v2 brief 5.10).
  if (phone && foldsOnPhone(id)) return <FoldedCard id={id as string} heading={heading as string} title={title} aside={aside} className={className}>{children}</FoldedCard>;
  return (
    <section id={id} aria-labelledby={heading} className={`dash-surface scroll-mt-24 p-4 sm:p-5 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={heading} className="text-sm font-extrabold text-[#0c3e48]">{title}</h2>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * A section folded under its title: the title row is a 56px target, the body
 * opens under it. A link to it (a hash in the address, or Add funds and
 * Withdraw on the balance) opens it and brings it into view.
 */
function FoldedCard({ id, heading, title, aside, className, children }: { id: string; heading: string; title: string; aside?: ReactNode; className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => {
      setOpen(true);
      window.requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    };
    if (sectionFromHash(window.location.hash) === id) reveal();
    const onHash = () => {
      if (sectionFromHash(window.location.hash) === id) reveal();
    };
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) reveal();
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener(OPEN_SECTION_EVENT, onOpen);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener(OPEN_SECTION_EVENT, onOpen);
    };
  }, [id]);
  return (
    <details ref={box} id={id} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className={`dash-surface group scroll-mt-20 ${className}`}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0d6370] [&::-webkit-details-marker]:hidden">
        <h2 id={heading} className="text-sm font-extrabold text-[#0c3e48]">{title}</h2>
        <span className="flex items-center gap-2">
          {aside}
          <ChevronDown className="h-5 w-5 text-[#326273] transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
        </span>
      </summary>
      <div className="border-t border-[#326273]/10 px-4 pb-4 pt-3">{children}</div>
    </details>
  );
}

const TONES: Record<Tone, string> = {
  ok: 'bg-[var(--ok-bg)] text-[#145d6a]',
  wait: 'bg-[var(--warn-bg)] text-[var(--warn-ink)]',
  bad: 'bg-[var(--error-bg)] text-[var(--error)]',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[12px] font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Note({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' | 'error' }) {
  if (tone === 'error') {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-[13px] font-medium text-[var(--error)]">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{children}</span>
      </p>
    );
  }
  return <p className={`text-[13px] leading-5 ${tone === 'warn' ? 'rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3 text-[#1F4452]' : 'text-[#326273]'}`}>{children}</p>;
}

export function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[13px] text-[#326273]">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

/** One GET, with a reload. A failure is a sentence, never a blank card. */
export function useLoad<T>(url: string | null, failure: string) {
  const [state, setState] = useState<LoadState<T>>({ url: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    void call<T & { error?: string }>(url).then((answer) => {
      if (!live) return;
      if (!answer.ok || !answer.body) setState({ url, data: null, error: errorText(answer, failure) });
      else setState({ url, data: answer.body, error: null });
    });
    return () => {
      live = false;
    };
  }, [url, tick, failure]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Waiting for an answer to this address (or for the address itself) is loading, never an empty answer.
  return { ...loadView(state, url), reload };
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#326273]/20 bg-white text-[#326273] hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
    >
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}

/** A full address in groups, for reading aloud or comparing; the copy button carries the exact value. */
export function Address({ value }: { value: string }) {
  return <code className="min-w-0 break-all font-mono text-[12px] leading-5 text-[#0c3e48]">{value}</code>;
}

/** A fresh idempotency key. It is made once per attempt and kept until the attempt is over, so a retry is never a second payment. */
export function newKey(prefix: string): string {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
