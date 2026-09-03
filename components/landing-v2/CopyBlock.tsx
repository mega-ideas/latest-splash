'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** Copyable command; horizontal-scroll on narrow screens, never wraps. */
export default function CopyBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-[12px] border border-[var(--line)] bg-[var(--ink-900)] p-2 pl-3 text-white">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1.5 font-mono text-[13px]">
        <code>{command}</code>
      </pre>
      <button type="button" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy command'} className="grid size-9 shrink-0 place-items-center rounded-[8px] text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--teal-500)]/40">
        {copied ? <Check className="size-4 text-[var(--green-100)]" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Command copied' : ''}
      </span>
    </div>
  );
}
