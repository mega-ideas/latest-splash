'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Layers, RotateCcw, Send, TrendingUp, type LucideIcon } from 'lucide-react';

import OxWalComposer from '@/components/oxwal/OxWalComposer';
import ThreadRow, { BotAvatar, StreamingRow, ThinkingRow } from '@/components/oxwal/ThreadView';
import MemWalBehaviorCard from '@/components/MemWalBehaviorCard';
import ZekeSuggestions from '@/components/oxwal/ZekeSuggestions';
import {
  MemWalStores,
  ZEKE_CARD,
  ZekeApprovals,
  ZekeCanDo,
  ZekeQuickLinks,
  ZekeRecent,
} from '@/components/oxwal/ZekeDeskCards';
import { ZEKE_LIMIT, deskSubtitle } from '@/lib/agent/zeke-desk';
import { stashBatchDraft } from '@/lib/batch-parse';
import { formatUsdc } from '@/lib/payments/stablecoin-lane';
import { useOxwalThread } from '@/lib/oxwal/use-oxwal-thread';
import { useWalletUsdc, useZekeDesk } from '@/lib/oxwal/use-zeke-desk';
import { cn } from '@/lib/utils';

/**
 * The Zeke page (v2 brief 5.3; boards "Zeke page · start" and "Zeke page ·
 * asking to pay").
 *
 * Fresh: a desk header with this workspace's numbers, the question with the
 * larger composer, starter cards and what Zeke prepared lately; beside it,
 * what Zeke remembers, what it can do, the approvals waiting, what MemWal
 * stores and quick links. Once a conversation starts, it takes the page: the
 * thread in a readable column, a reply composer docked under it, and a way to
 * start a new one.
 *
 * Every number comes from the desk snapshot (GET /api/oxwal/desk) or the
 * wallet route, and is left out when it could not be read. The conversation
 * lives in `useOxwalThread`, the same hook as the floating Zeke, so the two
 * cannot disagree about what an approval window means; a conversation begun
 * in the floating panel continues here when its expand button is pressed
 * (resumeHandoff, lib/oxwal/thread-handoff.ts).
 *
 * The limit is said before anything is asked: under the composer on the
 * start view, and as the first line of every conversation (ZEKE_LIMIT), until
 * the intent classifier says it per request (brief 4.8, Phase 2).
 */

/** What Zeke reads. True of the tools it has; shown, not clickable. */
const CAN_SEE = ['Wallet', 'Recipients', 'Invoices', 'Treasury'];

type Starter =
  | { title: string; body: string; icon: LucideIcon; prompt: string; href?: never }
  | { title: string; body: string; icon: LucideIcon; href: string; prompt?: never };

/** The starter cards. The assistant can be renamed, so the name is passed in. */
const STARTERS = (name: string): Starter[] => [
  {
    title: 'Review an invoice',
    body: `${name} reads the payee, amount and due date.`,
    icon: FileText,
    prompt: 'Review my latest invoice',
  },
  {
    title: 'Prepare a payment',
    body: `${name} drafts it. Your approver signs.`,
    icon: Send,
    prompt: 'I want to prepare a payment. What do you need from me?',
  },
  {
    title: 'Build a batch',
    body: `Upload a payout sheet. ${name} checks every row.`,
    icon: Layers,
    href: '/dashboard/batch',
  },
  {
    title: 'Plan idle cash',
    body: 'See what idle USDC could earn in Treasury.',
    icon: TrendingUp,
    prompt: 'What could my idle USDC earn in treasury?',
  },
];

export default function OxwalDeskPage() {
  const router = useRouter();
  const [input, setInput] = useState('');

  const {
    thread,
    streamingText,
    isSending,
    chatApprovals,
    clockMs,
    hasStarted,
    assistantName,
    threadRef,
    submitPrompt,
    approveInChat,
    resetThread,
  } = useOxwalThread({ welcome: ZEKE_LIMIT, resumeHandoff: true });

  const { snapshot, state, refresh } = useZekeDesk();
  const walletUsdc = useWalletUsdc(formatUsdc);
  const firstName = snapshot?.firstName ?? null;
  const topic = thread.find((item) => item.kind === 'user');

  function ask(prompt: string) {
    void submitPrompt(prompt);
    setInput('');
  }

  function startOver() {
    resetThread();
    setInput('');
    // What was prepared in the conversation now shows under Recent.
    void refresh();
  }

  const composerProps = {
    value: input,
    onChange: setInput,
    onSubmit: () => ask(input),
    onChipSubmit: ask,
    onFilePrepared: (batch: Parameters<typeof stashBatchDraft>[0]) => {
      stashBatchDraft(batch);
      router.push('/dashboard/batch?draft=1');
    },
    chips: [],
    disabled: isSending,
  };

  if (hasStarted) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <section aria-label={`Conversation with ${assistantName}`} className={cn(ZEKE_CARD, 'flex flex-col overflow-hidden')}>
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#326273]/12 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <BotAvatar size={28} />
              <h1 className="text-base font-bold text-[#0c3e48]">{assistantName}</h1>
              {/* The AI label is not attached to the name, so renaming the
                  assistant cannot remove it. */}
              <span className="rounded-md bg-[var(--zeke-tint)] px-2 py-0.5 text-[12px] font-bold text-[#0d6370]">AI assistant</span>
              {topic?.kind === 'user' && (
                <span className="hidden min-w-0 truncate text-[13px] font-medium text-[#326273] sm:inline">{topic.text}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/queue"
                className="inline-flex min-h-10 items-center rounded-[10px] px-3 text-[13px] font-bold text-[#326273] underline-offset-4 hover:underline focus-ring"
              >
                Approval queue
              </Link>
              <button
                type="button"
                onClick={startOver}
                disabled={isSending}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-[10px] border border-[#326273]/20 bg-white px-3 text-[13px] font-bold text-[#0c3e48] transition hover:border-[#0d6370] disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                New conversation
              </button>
            </div>
          </header>

          <div
            ref={threadRef}
            className="max-h-[calc(100dvh-260px)] min-h-[420px] overflow-y-auto bg-[var(--zeke-paper)] px-4 py-5"
            aria-live="polite"
          >
            <div className="mx-auto max-w-3xl space-y-4">
              {thread.map((item) => (
                <ThreadRow
                  key={item.id}
                  item={item}
                  onRetry={(prompt) => ask(prompt)}
                  chatApprovals={chatApprovals}
                  clockMs={clockMs}
                  onApprove={(proposal) => void approveInChat(proposal)}
                />
              ))}
              {streamingText && <StreamingRow text={streamingText} />}
              {isSending && !streamingText && <ThinkingRow />}
            </div>
          </div>

          <div className="border-t border-[#326273]/12 bg-white/60 px-4 py-3">
            <div className="mx-auto max-w-3xl">
              <OxWalComposer variant="reply" {...composerProps} assistantName={assistantName} placeholder={`Reply to ${assistantName}`} />
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <header className={cn(ZEKE_CARD, 'p-5 md:p-6')}>
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="dash-kicker">Operating desk · AI assistant</span>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-[#0d6370] px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--zeke-mint)]" aria-hidden="true" />
                  {assistantName} online
                </span>
              </div>
              <h1 className="dash-title mt-3 text-3xl md:text-4xl">Finance command desk</h1>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-[#326273]">
                Ask about your money, prepare payments for approval, and check what needs a decision.
              </p>
            </div>
            <div className="grid w-full grid-cols-3 overflow-hidden rounded-xl border border-[#326273]/14 bg-white text-center md:w-auto md:min-w-[340px]">
              <DeskStat label="Drafts" value={snapshot?.known ? snapshot.drafts : null} />
              {/* What this person can approve, not the workspace's count: a
                  payment they asked for is another approver's (maker-checker). */}
              <DeskStat label="To approve" value={snapshot?.forViewer?.waiting ?? null} caution />
              {/* Their own governance alerts, read on the server; "-" when not read. */}
              <DeskStat label="Alerts" value={snapshot?.alerts ?? null} caution />
            </div>
          </div>
        </header>

        <section aria-labelledby="zeke-agenda" className={cn(ZEKE_CARD, 'p-5 md:p-7')}>
          <div className="flex items-center gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle_at_50%_35%,#eaf6f1,#cfe8e0)] ring-2 ring-[#0d6370]/25">
              <Image src="/cinematic/agent-bot-cut.png" alt="" width={96} height={96} className="h-10 w-auto" />
            </span>
            <div className="min-w-0">
              <h2 id="zeke-agenda" className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-[#0c3e48] md:text-[26px]">
                {firstName ? `What's on the agenda today, ${firstName}?` : "What's on the agenda today?"}
              </h2>
              <p className="mt-1 text-[15px] font-medium text-[#326273]">{deskSubtitle(snapshot, walletUsdc)}</p>
            </div>
          </div>

          <div className="mt-5">
            <OxWalComposer
              variant="desk"
              canSee={CAN_SEE}
              {...composerProps}
              assistantName={assistantName}
              placeholder={`Ask ${assistantName} anything, or attach a payout sheet`}
            />
            <p className="mt-2 text-[13px] font-medium text-[#326273]">{ZEKE_LIMIT}</p>
          </div>

          <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Start with">
            {STARTERS(assistantName).map((starter) => {
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
              const cardClass =
                'block h-full w-full rounded-xl border border-[#326273]/16 bg-white p-4 text-left transition hover:-translate-y-px hover:border-[#0d6370]/50 hover:shadow-[0_8px_18px_-12px_rgba(13,99,112,0.45)] disabled:cursor-not-allowed disabled:opacity-50 focus-ring';
              return (
                <li key={starter.title}>
                  {starter.href ? (
                    <Link href={starter.href} className={cardClass}>
                      {inner}
                    </Link>
                  ) : (
                    <button type="button" className={cardClass} disabled={isSending} onClick={() => ask(starter.prompt ?? starter.title)}>
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-6">
            <ZekeRecent snapshot={snapshot} state={state} assistantName={assistantName} />
          </div>
        </section>
      </div>

      <aside className="space-y-4" aria-label={`About ${assistantName}`}>
        <MemWalBehaviorCard variant="zeke" assistantName={assistantName} />
        <ZekeCanDo assistantName={assistantName} />
        <ZekeApprovals snapshot={snapshot} />
        <MemWalStores />
        <ZekeQuickLinks />
        <ZekeSuggestions onAsk={ask} disabled={isSending} />
      </aside>
    </div>
  );
}

function DeskStat({ label, value, caution = false }: { label: string; value: number | null; caution?: boolean }) {
  const flagged = caution && value !== null && value > 0;
  return (
    <div className="min-w-0 border-r border-[#326273]/12 px-3 py-2.5 last:border-r-0">
      <p className={cn('dash-num text-2xl font-extrabold', flagged ? 'text-[var(--gold-ink)]' : 'text-[#0c3e48]')}>
        {value === null ? (
          <>
            <span aria-hidden="true">–</span><span className="sr-only">not read</span>
          </>
        ) : (
          value
        )}
        <span className="sr-only"> {label}</span>
      </p>
      <p aria-hidden="true" className="mt-0.5 whitespace-nowrap font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-[#326273]">{label}</p>
    </div>
  );
}
