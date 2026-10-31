'use client';

/**
 * The small parts every Transfer step shares, so the steps cannot drift:
 *
 *   - one control height (`h-11`, 44px, the touch minimum) for every input,
 *     select and button, and one icon gutter (`pl-10`) for every input that
 *     carries an icon;
 *   - `Segmented`, a toggle that shows exactly one selected state;
 *   - `Modal`, the pop-up used by "How it works" and the requirement sheet:
 *     a blurred backdrop, a close X, Escape to close, focus moved in and
 *     given back.
 */
import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, X, type LucideIcon } from 'lucide-react';

export const CONTROL = 'h-11 w-full rounded-xl border border-[#326273]/25 bg-white px-3 text-base text-[#0c3e48] outline-none transition-colors md:text-sm placeholder:text-[#326273] focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20 disabled:cursor-not-allowed disabled:bg-[#F6F0ED]';

export function Field({ label, hint, error, children, className = '', htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-semibold text-[#1F4452]">{label}</label>
        {hint ? <span className="text-[13px] text-[#326273]">{hint}</span> : null}
      </div>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-[13px] font-medium text-[var(--error)]">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({ icon: Icon, mono = false, className = '', ...rest }: { icon?: LucideIcon; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      {Icon ? <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#326273]" aria-hidden="true" /> : null}
      <input {...rest} className={`${CONTROL} ${Icon ? 'pl-10' : ''} ${mono ? 'font-mono' : ''} ${className}`} />
    </div>
  );
}

export function SelectInput({ children, className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${CONTROL} appearance-none bg-[length:16px] pr-9 ${className}`}>
      {children}
    </select>
  );
}

/** One selected state: the chosen option is filled, the others are plain. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  const group = useRef<HTMLDivElement>(null);
  // The ARIA radio pattern: one Tab stop (the chosen option), and the arrow keys choose and move.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + (forward ? 1 : options.length - 1)) % options.length];
    onChange(next.value);
    window.requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus());
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="inline-grid auto-cols-fr grid-flow-col rounded-xl border border-[#326273]/20 bg-[#F6F0ED] p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`h-11 rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'bg-[#0c3e48] text-white' : 'text-[#1F4452] hover:bg-white'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function PrimaryButton({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[#0d6370] px-5 text-sm font-bold text-white transition-colors hover:bg-[#073d49] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function QuietButton({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** A pop-up over a blurred backdrop, with a close X. `side` puts it at the right as a sheet instead of in the middle. */
export function Modal({ open, onClose, title, eyebrow, children, side = false, wide = false }: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; side?: boolean; wide?: boolean }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // The caller's onClose is usually a fresh function on every render; the effect must not restart (and move focus) because of it.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const node = panel.current;
    node?.querySelector<HTMLElement>('[data-close]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open]);

  if (!open) return null;
  // In the body, not in the page: the page's own layers (the rail, the top bar) would otherwise paint over it.
  return createPortal(
    <div className={`fixed inset-0 z-[80] flex ${side ? 'items-stretch justify-end' : 'items-end justify-center sm:items-center'} p-0 ${side ? '' : 'sm:p-6'}`}>
      <div className="absolute inset-0 bg-[#0c3e48]/45 backdrop-blur-md" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative flex max-h-[100dvh] w-full flex-col overflow-hidden bg-[#fffaf6] shadow-[0_24px_60px_-12px_rgba(12,62,72,0.45)] ${side ? 'max-w-md' : `${wide ? 'max-w-3xl' : 'max-w-xl'} rounded-t-2xl sm:rounded-2xl`}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#326273]/12 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            {eyebrow ? <div className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-[#145d6a]">{eyebrow}</div> : null}
            <h2 id={titleId} className="text-xl font-extrabold text-[#0c3e48]">{title}</h2>
          </div>
          <button
            type="button"
            data-close
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#326273]/20 bg-white text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
