'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, Maximize2, Sparkles, X } from 'lucide-react';

import { cn } from '../lib/utils';
import { stashBatchDraft, type ParsedBatch } from '../lib/batch-parse';
import { zekeGreeting } from '../lib/agent/zeke-desk';
import {
  readPendingProposals,
  subscribePendingProposals,
  type OxwalPendingSnapshot,
} from '../lib/oxwal-notify';
import { stashThreadHandoff } from '../lib/oxwal/thread-handoff';
import { useOxwalThread } from '../lib/oxwal/use-oxwal-thread';
import { useZekeDesk } from '../lib/oxwal/use-zeke-desk';
import OxWalComposer from './oxwal/OxWalComposer';
import ThreadRow, { StreamingRow, ThinkingRow } from './oxwal/ThreadView';
import ZekeGreeting, { type ZekeGreetingChip } from './oxwal/ZekeGreeting';

/**
 * Zeke, reachable from anywhere in the dashboard (board "Floating Zeke").
 *
 * ─── One assistant, not a smaller different one ─────────────────────────────
 *
 * This panel used to run its own conversation: `/api/copilot/chat` with no
 * tools, falling back to a keyword matcher that answered "PHP rate today?" with
 * a hard-coded figure. So the same question got a real answer at the desk and
 * an invented one here, with nothing to tell them apart. It now runs the same
 * agent as every other surface.
 *
 * ─── How it opens ───────────────────────────────────────────────────────────
 *
 * With a greeting that says what is waiting, from the workspace's own desk
 * snapshot (GET /api/oxwal/desk), and asks what to look at. Its suggestions
 * are inside that first message (v2 brief 5.3), not a fixed row of buttons.
 * The fixed "Reads state · prepares proposals · cannot send" strip is gone:
 * the limit is said in the conversation instead, in the greeting itself
 * (ZEKE_LIMIT in lib/agent/zeke-desk.ts), so it is the first thing anyone
 * reads before asking the panel to pay someone.
 *
 * The count on the trigger and on the Approvals chip is what this person can
 * approve (snapshot.forViewer), not the workspace's: under maker-checker a
 * payment they asked for waits for someone else, and a badge that nags them
 * about it points at something they cannot do.
 *
 * It is not drawn on the Zeke page, which is the same assistant at full size:
 * two Zekes on one screen, one sitting on the other's composer, is one too
 * many. Its expand button takes the conversation along: the thread is handed
 * to the Zeke page (lib/oxwal/thread-handoff.ts), which continues it, and
 * this panel starts clean, so the conversation lives in one place.
 *
 * It is a non-modal panel: the page behind it stays usable, so there is no
 * focus trap. Escape closes it and gives focus back to its trigger, but only
 * when focus is inside the panel. Another dialog open on the page (the
 * queue's reject confirmation, the phone nav drawer) keeps its own Escape.
 *
 * ─── What it deliberately will not do ───────────────────────────────────────
 *
 * It will not approve a payment. 400px floating over another screen is not
 * enough room to read what you are signing, and an approval taken without
 * reading is the failure maker-checker exists to prevent. Prepared work shows
 * as a line and a link to the queue.
 *
 * The panel is also draggable, because it otherwise covers the bottom-right of
 * whatever the operator is trying to read while asking about it.
 */

/**
 * The greeting's suggestions. Approvals and Receipts open the pages that
 * already hold the answer; Balances and Treasury ask Zeke, which reads them.
 */
const GREETING_CHIPS: ZekeGreetingChip[] = [
  { label: 'Approvals', href: '/queue' },
  { label: 'Balances', prompt: 'What are my balances right now?' },
  { label: 'Receipts', href: '/dashboard/history' },
  { label: 'Treasury', prompt: 'What is my treasury position?' },
];

const NUDGES = ['Hi!', 'Can I help?', 'Ready to splash it?'];

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
    resetThread,
  } = useOxwalThread({
    // Shorter than the desk: this panel is for quick questions, and a long
    // replayed history on every turn costs latency the desk can absorb and a
    // floating widget cannot.
    historyTurns: 6,
    // See the note above — no signing from a floating panel.
    allowInlineApproval: false,
  });

  const { snapshot, refresh } = useZekeDesk();

  // What waits for this person: what they could approve when that was read.
  // Before it is read, what this tab has seen Zeke prepare stands in; once
  // it is, a new proposal re-reads it (below) rather than being added on.
  const forViewer = snapshot?.known ? (snapshot?.forViewer ?? null) : null;
  const waiting = forViewer ? forViewer.waiting : pending.count;
  const awayFromDesk = pathname !== '/queue';
  const hasReminder = waiting > 0 && awayFromDesk;

  const chips = GREETING_CHIPS.map((chip) =>
    chip.label === 'Approvals' && forViewer && forViewer.waiting > 0
      ? { ...chip, label: `Approvals (${forViewer.waiting})` }
      : chip,
  );

  // Something new was prepared in this tab: re-read who it waits for.
  useEffect(() => {
    if (pending.updatedAt > 0) void refresh();
  }, [pending.updatedAt, refresh]);

  // Escape from inside the panel closes it, and focus goes back to what
  // opened it. Scoped to the panel, so another dialog's Escape is its own.
  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    closePanel();
  }

  // The expand button: the conversation goes with it to the Zeke page.
  function expandToPage() {
    stashThreadHandoff({ thread, assistantName });
    resetThread();
    setOpen(false);
  }

  function closePanel() {
    setOpen(false);
    triggerRef.current?.focus();
  }

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
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Uploaded batch → hand the parsed rows to the batch desk (which reviews and
  // routes to the Action Queue for human approval). Rows travel via
  // sessionStorage, never the URL — recipient PII stays in the tab.
  function handleBatchPrepared(batch: ParsedBatch) {
    stashBatchDraft(batch);
    setOpen(false);
    router.push('/dashboard/batch?draft=1');
  }

  // A brief, low-pressure prompt appears while the chat is closed. When
  // payments are waiting and the operator is away from the desk, the reminder
  // takes priority over small talk.
  useEffect(() => {
    const showNudge = () => {
      if (open) return;
      setNudge((current) => {
        if (hasReminder) {
          return waiting === 1 ? '1 approval waiting for you' : `${waiting} approvals waiting for you`;
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
  }, [open, hasReminder, waiting]);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button, a')) return;
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

  if (pathname === '/dashboard/zeke') return null;

  return (
    <>
      {/* ── Chat panel (slides up above the button) ── */}
      <div
        role="dialog"
        aria-label={`${assistantName} chat`}
        onKeyDown={onPanelKeyDown}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'fixed bottom-[76px] right-4 z-50 flex w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[18px] border border-[#0c3e48]/12 bg-[#fffdf9] shadow-[0_24px_60px_rgba(8,54,64,0.28)] transition-all duration-200 origin-bottom-right',
          open
            ? 'opacity-100 scale-100 pointer-events-auto'
            : 'opacity-0 scale-95 pointer-events-none',
        )}
        style={{ height: 'min(560px, calc(100dvh - 96px))', translate: `${offset.x}px ${offset.y}px` }}
      >
        {/* Panel header */}
        <div
          className="flex shrink-0 cursor-grab touch-none items-center justify-between bg-gradient-to-r from-[#0c3e48] to-[#0d6370] px-4 py-3 active:cursor-grabbing"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
        >
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle_at_50%_35%,#eaf6f1,#cfe8e0)] ring-2 ring-[var(--zeke-mint)]/60">
              <Image
                src="/cinematic/agent-bot-cut.png"
                alt=""
                width={64}
                height={64}
                className="h-6 w-auto"
              />
            </div>
            <div>
              <div className="text-sm font-bold text-white">{assistantName}</div>
              <div className="flex items-center gap-1.5 text-[13px] text-white/85">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    isSending ? 'animate-pulse bg-[#efc46f]' : 'bg-[var(--zeke-mint)]',
                  )}
                  aria-hidden="true"
                />
                {isSending ? 'Working…' : 'Online'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* The AI marker is separate from the name so that renaming the
                assistant cannot remove it. */}
            <span className="mr-1 flex items-center gap-1 font-mono text-[12px] uppercase tracking-[0.12em] text-white/85">
              <Sparkles size={9} /> AI
            </span>
            <Link
              href="/dashboard/zeke"
              onClick={expandToPage}
              className="grid h-9 w-9 place-items-center rounded-md text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-ring"
              aria-label={thread.length > 0 ? `Continue on the ${assistantName} page` : `Open the ${assistantName} page`}
              title={thread.length > 0 ? `Continue on the ${assistantName} page` : `Open the ${assistantName} page`}
            >
              <Maximize2 size={15} aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={closePanel}
              className="grid h-9 w-9 place-items-center rounded-md text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-ring"
              aria-label={`Close ${assistantName}`}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Messages. The greeting is the first of them, its chips inside it. */}
        <div
          ref={threadRef}
          className="flex-1 space-y-3 overflow-y-auto p-4"
          style={{ scrollbarWidth: 'none' }}
          aria-live="polite"
        >
          <ZekeGreeting
            text={zekeGreeting(snapshot)}
            chips={chips}
            onAsk={(prompt) => send(prompt)}
            onNavigate={() => setOpen(false)}
            disabled={isSending}
          />

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

        <div className="shrink-0 border-t border-[#326273]/10 bg-[#fffdf9] p-3">
          <OxWalComposer
            variant="reply"
            value={input}
            onChange={setInput}
            onSubmit={() => send(input)}
            onChipSubmit={(prompt) => send(prompt)}
            onFilePrepared={handleBatchPrepared}
            chips={[]}
            disabled={isSending}
            assistantName={assistantName}
            placeholder={`Ask ${assistantName}, or attach a payout sheet`}
            inputRef={inputRef}
          />
        </div>
      </div>

      {/* ── Floating trigger: the Zeke robot mascot ── */}
      <div className="fixed bottom-4 right-4 z-50 flex items-end gap-2.5">
        {/* Nudge bubble (closed only) */}
        {!open && nudge && (
          <span className="mb-2 animate-[copilot-nudge_.3s_ease] rounded-2xl rounded-br-sm bg-[#0c3e48] px-3.5 py-2 text-sm font-medium tracking-tight text-white shadow-[0_10px_24px_rgba(8,54,64,0.3)]">
            {nudge}
          </span>
        )}

        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setNudge(null);
            const opening = !open;
            setOpen(opening);
            // Opening re-reads what is waiting, so the greeting is current.
            if (opening) void refresh();
          }}
          aria-label={open ? `Close ${assistantName}` : `Open ${assistantName}`}
          aria-expanded={open}
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
                : 'motion-safe:animate-[copilot-bob_3s_ease-in-out_infinite] group-hover:-rotate-6',
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
            <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--gold-light)] px-1 font-mono text-[13px] font-bold text-[#073d49] ring-2 ring-white/80">
              {waiting > 9 ? '9+' : waiting}
            </span>
          )}
          {!open && !hasReminder && (
            <span className="absolute right-1 top-1" aria-hidden="true">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-[var(--zeke-mint)] opacity-60" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[#0d6370] ring-2 ring-white/70" />
              </span>
            </span>
          )}
        </button>
      </div>
    </>
  );
}
