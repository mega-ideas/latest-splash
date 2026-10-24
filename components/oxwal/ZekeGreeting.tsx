'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import { BotAvatar } from '@/components/oxwal/ThreadView';

/**
 * Zeke's first message, with its suggestions inside it (board "Floating Zeke").
 *
 * The chips used to be a fixed row under the composer, there on every turn
 * whether or not they still made sense. Here they belong to the greeting: the
 * first thing Zeke says is a question, and the chips are the answers it
 * expects. A chip either asks Zeke (`prompt`) or opens the page that already
 * shows the answer (`href`), and the second kind says so with an arrow.
 */

export type ZekeGreetingChip =
  | { label: string; prompt: string; href?: never }
  | { label: string; href: string; prompt?: never };

export default function ZekeGreeting({
  text,
  chips,
  onAsk,
  onNavigate,
  disabled = false,
}: {
  text: string;
  chips: ZekeGreetingChip[];
  onAsk: (prompt: string) => void;
  /** Called when a chip opens a page, so a panel can close itself. */
  onNavigate?: () => void;
  disabled?: boolean;
}) {
  const chipClass =
    'inline-flex min-h-10 items-center gap-1 rounded-[var(--r-pill)] border border-[#0d6370]/30 bg-white px-3.5 text-[13px] font-semibold text-[#0c3e48] transition hover:border-[#0d6370] hover:bg-[var(--zeke-tint)] disabled:cursor-not-allowed disabled:opacity-50 focus-ring';

  return (
    <div className="flex gap-2">
      <BotAvatar size={24} />
      <div className="max-w-[92%] rounded-[14px] rounded-tl-sm bg-[var(--zeke-bubble)] px-3.5 py-3">
        <p className="text-sm font-medium leading-6 text-[#0c3e48]">{text}</p>
        {chips.length > 0 && (
          <ul className="mt-2.5 flex flex-wrap gap-2" aria-label="Suggestions">
            {chips.map((chip) => (
              <li key={chip.label}>
                {chip.href ? (
                  <Link href={chip.href} onClick={onNavigate} className={chipClass}>
                    {chip.label}
                    <ArrowUpRight className="h-3.5 w-3.5 text-[#0d6370]" aria-hidden="true" />
                  </Link>
                ) : (
                  <button type="button" disabled={disabled} onClick={() => onAsk(chip.prompt ?? chip.label)} className={chipClass}>
                    {chip.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
