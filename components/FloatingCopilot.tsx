'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BellRing, ChevronDown, Sparkles, X } from 'lucide-react';

import { cn } from '../lib/utils';
import { stashBatchDraft, type ParsedBatch } from '../lib/batch-parse';
import {
  readPendingProposals,
  subscribePendingProposals,
  type OxwalPendingSnapshot,
} from '../lib/oxwal-notify';
import { useOxwalThread } from '../lib/oxwal/use-oxwal-thread';
import OxWalComposer, { type OxWalComposerChip } from './oxwal/OxWalComposer';
import ThreadRow, { StreamingRow, ThinkingRow } from './oxwal/ThreadView';

/**
 * 0xWal, reachable from anywhere in the dashboard.
 *
 * ─── One assistant, not a smaller different one ─────────────────────────────
 *
 * This panel used to run its own conversation: `/api/copilot/chat` with no
 * tools, falling back to a keyword matcher that answered "PHP rate today?" with
 * a hard-coded figure. So the same question got a real answer at the desk and
 * an invented one here, with nothing to tell them apart. It now runs the same
 * agent as every other surface.
 *
 * ─── What it deliberately will not do ───────────────────────────────────────
 *
 * It will not approve a payment. 360px floating over another screen is not
 * enough room to read what you are signing, and an approval taken without
 * reading is the failure maker-checker exists to prevent. Prepared work shows
 * as a line and a link to the queue.
 *
 * The panel is also draggable, because it otherwise covers the bottom-right of
 * whatever the operator is trying to read while asking about it.
 */

const QUICK_CHIPS: OxWalComposerChip[] = [
  { label: 'Balances', prompt: 'What are my balances right now?', icon: 'search' },
  { label: 'Recipients', prompt: 'Which recipients can I pay today?', icon: 'file' },
  { label: 'Treasury', prompt: 'What is my treasury position?', icon: 'write' },
  { label: 'Compliance', prompt: 'Anything blocked on compliance?', icon: 'search' },
];

const NUDGES = ['Hi!', 'Can I help?', 'Ready to splash it?'];

const OPENING_MESSAGE =
  'Ask me about balances, recipients, corridors or treasury. '
  + 'I can prepare a payment for approval — I cannot send one.';

export default function FloatingCopilot() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [nudge, setNudge] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [pending, setPending] = useState<OxwalPendingSnapshot>({
    count: 0,
    label: null,
    updatedAt: 0,
  });

  const {
    thread,
    streamingText,
    isSending,
    chatApprovals,
    clockMs,
    assistantName,
    threadRef,
    submitPrompt,
    approveInChat,
  } = useOxwalThread({
    welcome: OPENING_MESSAGE,
    // Shorter than the desk: this panel is for quick questions, and a long
    // replayed history on every turn costs latency the desk can absorb and a
    // floating widget cannot.
    historyTurns: 6,
    // See the note above — no signing from a floating panel.
    allowInlineApproval: false,
  });

  // The desk records unsigned proposals; remind the operator whenever they are
  // anywhere else in the app.
  const awayFromDesk = pathname !== '/dashboard' && pathname !== '/queue';
  const hasReminder = pending.count > 0 && awayFromDesk;

  useEffect(() => {
    // Hydration-safe initial read, then live subscription.
    const timeout = setTimeout(() => setPending(readPendingProposals()), 0);
    const unsubscribe = subscribePendingProposals(setPending);
    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, []);

  const nudgeTimeoutRef = useRef<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Uploaded batch → hand the parsed rows to the batch desk (which reviews and
  // routes to the Action Queue for human approval). Rows travel via
  // sessionStorage, never the URL — recipient PII stays in the tab.
  function handleBatchPrepared(batch: ParsedBatch) {
    stashBatchDraft(batch);
    setOpen(false);
    router.push('/dashboard/batch?draft=1');
  }

  // A brief, low-pressure prompt appears while the chat is closed. When unsigned
  // proposals are waiting and the operator is away from the desk, the reminder
  // takes priority over small talk.
  useEffect(() => {
    const showNudge = () => {
      if (open) return;
      setNudge((current) => {
        if (hasReminder) {
          return pending.count === 1
            ? '1 approval waiting for you'
            : `${pending.count} approvals waiting for you`;
        }
        const choices = NUDGES.filter((item) => item !== current);
        return choices[Math.floor(Math.random() * choices.length)] ?? NUDGES[0];
      });
      if (nudgeTimeoutRef.current) window.clearTimeout(nudgeTimeoutRef.current);
      nudgeTimeoutRef.current = window.setTimeout(() => setNudge(null), hasReminder ? 6000 : 3000);
    };
    const interval = window.setInterval(showNudge, hasReminder ? 20_000 : 45_000);
    return () => {
      window.clearInterval(interval);
      if (nudgeTimeoutRef.current) window.clearTimeout(nudgeTimeoutRef.current);
    };
  }, [open, hasReminder, pending.count]);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const nextX = dragRef.current.offsetX + event.clientX - dragRef.current.x;
    const nextY = dragRef.current.offsetY + event.clientY - dragRef.current.y;
    const maxX = Math.max(0, window.innerWidth - 90);
    const maxY = Math.max(0, window.innerHeight - 140);
    setOffset({
      x: Math.max(-maxX, Math.min(maxX, nextX)),
      y: Math.max(-maxY, Math.min(maxY, nextY)),
    });
  }

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  function send(text: string) {
    void submitPrompt(text);
    setInput('');
  }

  return (
    <>
      {/* ── Chat panel (slides up above the button) ── */}
      <div
        className={cn(
          'fixed bottom-[76px] right-4 z-50 flex w-[360px] flex-col overflow-hidden rounded-2xl border border-[#0c3e48]/12 bg-[#fffdf9] shadow-[0_24px_60px_rgba(8,54,64,0.28)] transition-all duration-200 origin-bottom-right',
          open
            ? 'opacity-100 scale-100 pointer-events-auto'
            : 'opacity-0 scale-95 pointer-events-none',
        )}
        style={{ height: 500, translate: `${offset.x}px ${offset.y}px` }}
      >
        {/* Panel header */}
        <div
          className="flex shrink-0 cursor-grab touch-none items-center justify-between bg-gradient-to-r from-[#0c3e48] to-[#0d6370] px-4 py-3 active:cursor-grabbing"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          aria-label={`Drag ${assistantName} chat`}
        >
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle_at_50%_35%,#eaf6f1,#cfe8e0)] ring-1 ring-[#efc46f]/40">
              <Image
                src="/cinematic/agent-bot-cut.png"
                alt=""
                width={64}
                height={64}
                className="h-6 w-auto"
              />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-white">{assistantName}</div>
              <div className="flex items-center gap-1.5 text-[13px] text-white/50">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    isSending ? 'animate-pulse bg-amber-400' : 'bg-emerald-400',
                  )}
                />
                {isSending ? 'Working…' : 'Online'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* The AI marker is separate from the name so that renaming the
                assistant cannot remove it. */}
            <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/40">
              <Sparkles size={9} /> AI
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-white/50 transition-colors hover:text-white"
              aria-label={`Close ${assistantName}`}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Pending-approval reminder — prepared work that needs a human */}
        {pending.count > 0 && (
          <Link
            href="/queue"
            onClick={() => setOpen(false)}
            className="flex shrink-0 items-center gap-2.5 border-b border-[#efc46f]/50 bg-[#efc46f]/15 px-4 py-2.5 transition-colors hover:bg-[#efc46f]/25"
          >
            <BellRing size={14} className="shrink-0 text-[#9A4A2D]" />
            <span className="min-w-0 flex-1 text-[13px] font-semibold leading-4 text-[#0c3e48]">
              {pending.count === 1
                ? '1 unsigned proposal waits'
                : `${pending.count} unsigned proposals wait`}{' '}
              for your approval
              {pending.label ? ` — ${pending.label}` : ''}
            </span>
            <span className="shrink-0 rounded-md bg-[#0c3e48] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-white">
              Queue
            </span>
          </Link>
        )}

        {/* The tool boundary, stated once. This replaced a three-cell "live
            ticker" whose figures were hard-coded — it read as a market feed and
            was a static string, which is the one thing a terminal must not do.
            What is here instead is true on every render. */}
        <div className="shrink-0 border-b border-[#0c3e48]/10 bg-[#f4efe4] px-4 py-1.5">
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#0d6370]">
            Reads state · prepares proposals · cannot send
          </span>
        </div>

        {/* Messages */}
        <div
          ref={threadRef}
          className="flex-1 space-y-2.5 overflow-y-auto p-3"
          style={{ scrollbarWidth: 'none' }}
          aria-live="polite"
        >
          {thread.map((item) => (
            <ThreadRow
              key={item.id}
              item={item}
              compact
              onRetry={(prompt) => send(prompt)}
              chatApprovals={chatApprovals}
              clockMs={clockMs}
              onApprove={(proposal) => void approveInChat(proposal)}
            />
          ))}

          {streamingText && <StreamingRow text={streamingText} compact />}
          {isSending && !streamingText && <ThinkingRow compact />}
        </div>

        <div className="shrink-0 border-t border-[#326273]/8 bg-[#fffdf9] p-3">
          <OxWalComposer
            compact
            value={input}
            onChange={setInput}
            onSubmit={() => send(input)}
            onChipSubmit={(prompt) => send(prompt)}
            onFilePrepared={handleBatchPrepared}
            chips={QUICK_CHIPS}
            disabled={isSending}
            placeholder={`Ask ${assistantName}, or attach a payout sheet`}
            inputRef={inputRef}
          />
        </div>
      </div>

      {/* ── Floating trigger: the 0xWal robot mascot ── */}
      <div className="fixed bottom-4 right-4 z-50 flex items-end gap-2.5">
        {/* Nudge bubble (closed only) */}
        {!open && nudge && (
          <span className="mb-2 animate-[copilot-nudge_.3s_ease] rounded-2xl rounded-br-sm bg-[#0c3e48] px-3.5 py-2 text-sm font-medium tracking-tight text-white shadow-[0_10px_24px_rgba(8,54,64,0.3)]">
            {nudge}
          </span>
        )}

        <button
          type="button"
          onClick={() => {
            setNudge(null);
            setOpen((v) => !v);
          }}
          aria-label={open ? `Close ${assistantName}` : `Open ${assistantName}`}
          className={cn(
            'group relative grid h-16 w-16 place-items-center rounded-full ring-1 transition-all duration-200 hover:-translate-y-1',
            'bg-[radial-gradient(circle_at_50%_35%,#eaf6f1,#cfe8e0)] ring-[#0c3e48]/12',
            'shadow-[0_14px_30px_rgba(8,54,64,0.32)] hover:shadow-[0_20px_40px_rgba(8,54,64,0.4)]',
          )}
        >
          {/* Robot mascot — floats gently, tips forward on hover.
              Rendered at 54px, so declare ~2x intrinsic size: asking for the
              512px source made Next serve a 640px/48KB variant for a 54px
              avatar, which stalled the image optimizer and left it blank. */}
          <Image
            src="/cinematic/agent-bot-cut.png"
            alt=""
            width={128}
            height={128}
            priority
            className={cn(
              'h-[54px] w-auto origin-bottom drop-shadow-[0_4px_6px_rgba(8,54,64,0.28)] transition-transform duration-200',
              open
                ? 'scale-90'
                : 'animate-[copilot-bob_3s_ease-in-out_infinite] group-hover:-rotate-6',
            )}
          />

          {/* Collapse chevron badge (open only) */}
          {open && (
            <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-[#0c3e48] text-white ring-2 ring-[#eaf6f1]">
              <ChevronDown size={14} />
            </span>
          )}

          {/* Closed-state indicator: approval count when work is waiting,
              otherwise the ambient pulse dot */}
          {!open && hasReminder && (
            <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-[#E39774] px-1 font-mono text-[13px] font-bold text-white ring-2 ring-white/80">
              {pending.count > 9 ? '9+' : pending.count}
            </span>
          )}
          {!open && !hasReminder && (
            <span className="absolute right-1 top-1">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#efc46f] opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[#efc46f] ring-2 ring-white/70" />
              </span>
            </span>
          )}
        </button>
      </div>
    </>
  );
}
