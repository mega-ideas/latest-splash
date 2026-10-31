'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

import MemWalBehaviorCard from '@/components/MemWalBehaviorCard';
import { MemWalStores, ZEKE_CARD, ZekeApprovals, ZekeCanDo, ZekeQuickLinks } from '@/components/oxwal/ZekeDeskCards';
import ZekeSuggestions from '@/components/oxwal/ZekeSuggestions';
import type { ZekeDeskSnapshot } from '@/lib/agent/zeke-desk';
import { cn } from '@/lib/utils';

/**
 * The pieces of the Zeke page that are different on a phone (v2 brief 5.10);
 * lib/oxwal/phone-desk.ts says which cards lead and which fold. The page keeps
 * the conversation, the composer and the numbers; these arrange them.
 */

export type PhoneStarter =
  | { title: string; body: string; icon: LucideIcon; prompt: string; href?: never }
  | { title: string; body: string; icon: LucideIcon; href: string; prompt?: never };

/** What to start with, as a row to swipe: each card is a 44px-plus target and the next one peeks so it is clear there is more. */
export function PhoneStarters({ starters, disabled, onAsk }: { starters: PhoneStarter[]; disabled: boolean; onAsk: (prompt: string) => void }) {
  const card = 'flex h-full min-h-[116px] w-[236px] shrink-0 snap-start flex-col rounded-xl border border-[#326273]/16 bg-white p-4 text-left transition active:bg-[#eef4f5] disabled:cursor-not-allowed disabled:opacity-50 focus-ring';
  return (
    <ul aria-label="Start with" className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {starters.map((starter) => {
        const Icon = starter.icon;
        const inner = (
          <>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--zeke-tint)]">
              <Icon className="h-4 w-4 text-[#0d6370]" aria-hidden="true" />
            </span>
            <span className="mt-2 block text-sm font-bold text-[#0c3e48]">{starter.title}</span>
            <span className="mt-0.5 block text-[13px] font-medium leading-5 text-[#326273]">{starter.body}</span>
          </>
        );
        return (
          <li key={starter.title} className="flex">
            {starter.href ? (
              <Link href={starter.href} className={card}>{inner}</Link>
            ) : (
              <button type="button" className={card} disabled={disabled} onClick={() => onAsk(starter.prompt ?? starter.title)}>{inner}</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Fold({ title, children, hint }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className={cn(ZEKE_CARD, 'group')}>
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0d6370] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-[15px] font-bold text-[#0c3e48]">{title}</span>
          {hint ? <span className="block text-[13px] font-medium text-[#326273]">{hint}</span> : null}
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-[#326273] transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-[#326273]/12 p-4">{children}</div>
    </details>
  );
}

/** Every card that explains or links, folded under titles so none is dropped and none crowds the composer. */
export function PhoneMore({ assistantName, snapshot, disabled, onAsk }: { assistantName: string; snapshot: ZekeDeskSnapshot | null; disabled: boolean; onAsk: (prompt: string) => void }) {
  return (
    <div className="space-y-3">
      <Fold title="Approvals" hint="What waits for a decision">
        <ZekeApprovals snapshot={snapshot} />
      </Fold>
      <Fold title={`What ${assistantName} can do and remembers`}>
        <ZekeCanDo assistantName={assistantName} />
        <MemWalBehaviorCard variant="zeke" assistantName={assistantName} />
      </Fold>
      <Fold title="What MemWal stores" hint="And what it never stores">
        <MemWalStores />
      </Fold>
      <Fold title="Quick links">
        <ZekeQuickLinks />
      </Fold>
      <Fold title="Suggestions" hint="Drawn from your open invoices">
        <ZekeSuggestions onAsk={onAsk} disabled={disabled} />
      </Fold>
    </div>
  );
}
