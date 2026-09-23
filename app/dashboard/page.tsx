'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import OxWalComposer, { type OxWalComposerChip } from '@/components/oxwal/OxWalComposer';
import ThreadRow, { BotAvatar, StreamingRow, ThinkingRow } from '@/components/oxwal/ThreadView';
import MemWalBehaviorCard from '@/components/MemWalBehaviorCard';
import { stashBatchDraft } from '@/lib/batch-parse';
import { useOxwalThread } from '@/lib/oxwal/use-oxwal-thread';

/**
 * 0xWal desk — a Claude-style expanding chat.
 *
 * Fresh desk: a centered composer ("What's on the agenda today?").
 * First message: the surface becomes a conversation — the thread grows
 * downward and the composer docks at the bottom, exactly like starting a chat.
 *
 * The conversation itself lives in `useOxwalThread`, shared with the copilot
 * page and the floating widget. This file is the desk's layout and nothing
 * else: three surfaces disagreeing about what an approval window means was the
 * defect, not a difference in styling.
 */

const quickPrompts: OxWalComposerChip[] = [
  { label: 'Review invoice', prompt: 'Pay invoice inv_demo_acme_5000 to cp_acme_ph', icon: 'file' },
  { label: 'Allocate treasury', prompt: 'Allocate idle treasury for MY_PH', icon: 'write' },
  { label: 'Look up tools', prompt: 'What can you read and prepare?', icon: 'search' },
];

const WELCOME =
  '0xWal is standing by. Every money movement becomes an unsigned proposal for human approval.';

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
    proposals,
    assistantName,
    threadRef,
    submitPrompt,
    approveInChat,
  } = useOxwalThread({ welcome: WELCOME });

  const deskStats = useMemo(() => {
    const needsApproval = proposals.filter(
      (proposal) => proposal.explain.requiredApprovers > proposal.approvals.length,
    ).length;
    const warnings = thread.filter((item) => item.kind === 'notice').length;
    return { total: proposals.length, needsApproval, warnings };
  }, [proposals, thread]);

  function handleSubmit() {
    void submitPrompt(input);
    setInput('');
  }

  const composer = (
    <OxWalComposer
      compact={hasStarted}
      title={hasStarted ? undefined : "What's on the agenda today?"}
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      onChipSubmit={(prompt) => void submitPrompt(prompt)}
      onFilePrepared={(batch) => {
        stashBatchDraft(batch);
        router.push('/dashboard/batch?draft=1');
      }}
      chips={hasStarted ? [] : quickPrompts}
      disabled={isSending}
      placeholder="Ask 0xWal to read, prepare, or explain — or attach a payout sheet"
    />
  );

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <main className="min-w-0 space-y-4">
        <header className="dash-block dash-block-accent dash-reveal p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="dash-kicker">Operating desk · AI</span>
                <span className="inline-flex items-center gap-2 rounded-md bg-[#0c3e48] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                  {assistantName} online
                </span>
              </div>
              <h1 className="dash-title mt-3 text-3xl md:text-4xl">Finance command desk</h1>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-[#326273]/62">
                Read financial state, prepare unsigned proposals, and route approvals from one operating surface.
              </p>
            </div>
            <div className="grid w-full grid-cols-3 overflow-hidden rounded-lg border border-[#326273]/14 bg-white text-center md:w-auto md:min-w-[300px]">
              <DeskStat label="Proposals" value={deskStats.total} />
              <DeskStat label="Approval" value={deskStats.needsApproval} caution={deskStats.needsApproval > 0} />
              <DeskStat label="Notices" value={deskStats.warnings} caution={deskStats.warnings > 0} />
            </div>
          </div>
        </header>

        {/* The chat surface. Starts as a centered composer; the first message
            expands it into a full conversation with the composer docked below. */}
        {!hasStarted ? (
          <section className="dash-surface dash-reveal px-4 py-10 md:px-8 md:py-14">
            {composer}
          </section>
        ) : (
          <section className="dash-surface dash-reveal flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-[#326273]/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <BotAvatar size={24} />
                <h2 className="text-sm font-bold text-[#1F4452]">{assistantName}</h2>
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/45">
                  prepares · you approve
                </span>
              </div>
              <Link href="/queue" className="text-[13px] font-bold text-[#326273] underline-offset-4 hover:underline">
                Approval queue
              </Link>
            </div>

            <div
              ref={threadRef}
              className="max-h-[62vh] min-h-[380px] space-y-3 overflow-y-auto p-4"
              aria-live="polite"
            >
              {thread.map((item) => (
                <ThreadRow
                  key={item.id}
                  item={item}
                  onRetry={(prompt) => void submitPrompt(prompt)}
                  chatApprovals={chatApprovals}
                  clockMs={clockMs}
                  onApprove={(proposal) => void approveInChat(proposal)}
                />
              ))}

              {streamingText && <StreamingRow text={streamingText} />}
              {isSending && !streamingText && <ThinkingRow />}
            </div>

            <div className="border-t border-[#326273]/10 bg-white/60 p-3">{composer}</div>
          </section>
        )}
      </main>

      <aside className="space-y-4 dash-reveal-stagger">
        <MemWalBehaviorCard compact />
        <div className="dash-block p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--info)]" />
            <h2 className="text-sm font-bold text-[#1F4452]">Control state</h2>
          </div>
          <div className="mt-3 divide-y divide-[#326273]/10 text-sm">
            <ControlRow icon={CheckCircle2} label="Tool boundary" value="Read + propose" />
            <ControlRow icon={Clock3} label="Submit guard" value="Policy re-check" />
            <ControlRow icon={AlertTriangle} label="Circuit breaker" value="Armed" />
          </div>
        </div>
        <div className="rounded-2xl border border-[#0c3e48] bg-[#0c3e48] p-4 text-white shadow-[6px_7px_0_rgba(12,62,72,0.18)]">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#efc46f]/80">Approval surface</p>
          <div className="mt-2 text-2xl font-bold">Maker-checker</div>
          {deskStats.needsApproval > 0 ? (
            <p className="mt-2 text-[13px] font-medium leading-5 text-white/78">
              {deskStats.needsApproval} unsigned {deskStats.needsApproval === 1 ? 'proposal is' : 'proposals are'} waiting
              for your approval.
            </p>
          ) : (
            <p className="mt-2 text-[13px] font-medium leading-5 text-white/62">
              Pending proposals, compliance holds, expiring quotes, failed settlements, and anomaly halts live in the queue.
            </p>
          )}
          <Link href="/queue" className="dash-btn dash-btn-gold mt-4">
            Open queue
          </Link>
        </div>
      </aside>
    </div>
  );
}

function DeskStat({ label, value, caution = false }: { label: string; value: number; caution?: boolean }) {
  return (
    <div className="min-w-0 border-r border-[#326273]/10 px-3 py-2 last:border-r-0">
      <div className={caution ? 'text-2xl font-bold text-[#E39774]' : 'text-2xl font-bold text-[#1F4452]'}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-normal text-[#326273]/50">{label}</div>
    </div>
  );
}

function ControlRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-[var(--info)]" />
        <span className="font-bold text-[#326273]">{label}</span>
      </div>
      <span className="font-mono text-[13px] font-bold text-[#1F4452]">{value}</span>
    </div>
  );
}
