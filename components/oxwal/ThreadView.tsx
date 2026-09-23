'use client';

import Image from 'next/image';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw } from 'lucide-react';

import ActionCard from '@/components/oxwal/ActionCard';
import type { ActionCardProposal } from '@/lib/agent/action-card';
import type { OxwalChatApproval, OxwalThreadItem } from '@/lib/oxwal/use-oxwal-thread';

/**
 * How one turn of a 0xWal conversation looks, everywhere it appears.
 *
 * ─── Why the activity lines are not decoration ──────────────────────────────
 *
 * Three of the six row kinds are not messages: activity, notice, proposal. They
 * are the record of what the assistant did, rendered between the turns it did
 * them in. That ordering carries the meaning — "Verifying counterparty"
 * directly above a prepared payment is how an operator sees that the
 * recommendation was built from a real lookup rather than asserted.
 *
 * They are also deliberately not styled like speech. Messages are bubbles;
 * everything the machine did is a monospace chip on the left rail. An operator
 * skimming for what happened should never have to read prose to find it.
 *
 * ─── Density ───────────────────────────────────────────────────────────────
 *
 * `compact` is for the floating widget: 380px of chrome floating over another
 * screen. A full action card there is a payment approved without room to read
 * it, so proposals collapse to a line and a link to the queue. The rule is the
 * surface's, not the operator's — the queue is the same either way.
 */
export function formatCountdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function BotAvatar({ size = 24 }: { size?: number }) {
  return (
    <div
      className="mt-0.5 grid shrink-0 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle_at_50%_35%,#eaf6f1,#cfe8e0)] ring-1 ring-[#0d6370]/25"
      style={{ height: size, width: size }}
    >
      {/* Intrinsic size tracks the rendered avatar (~2x for retina). Passing the
          full 512px source made Next request a 640px variant for a ~16px avatar. */}
      <Image
        src="/cinematic/agent-bot-cut.png"
        alt=""
        width={Math.round(size * 2)}
        height={Math.round(size * 2)}
        style={{ height: size * 0.66, width: 'auto' }}
      />
    </div>
  );
}

/** The three dots shown while the agent is working but has emitted no text. */
export function ThinkingRow({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex gap-2">
      <BotAvatar size={compact ? 20 : 24} />
      <div className="flex items-center gap-1.5 rounded-lg rounded-tl-sm border border-[#326273]/10 bg-[#F6F0ED] px-3 py-2.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#0d6370]/50 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#0d6370]/50 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#0d6370]/50 [animation-delay:300ms]" />
      </div>
    </div>
  );
}

/** The turn currently arriving, token by token. */
export function StreamingRow({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className="flex gap-2">
      <BotAvatar size={compact ? 20 : 24} />
      <div className="max-w-[88%] rounded-lg rounded-tl-sm border border-[#5C9EAD]/30 bg-[#5C9EAD]/10 px-3 py-2 text-sm font-medium leading-6 text-[#326273]">
        <span className="whitespace-pre-wrap">{text}</span>
        <span
          className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-[#0d6370]/60"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export default function ThreadRow({
  item,
  onRetry,
  chatApprovals,
  clockMs,
  onApprove,
  compact = false,
}: {
  item: OxwalThreadItem;
  onRetry: (prompt: string) => void;
  chatApprovals: Record<string, OxwalChatApproval>;
  clockMs: number;
  onApprove: (proposal: ActionCardProposal) => void;
  compact?: boolean;
}) {
  if (item.kind === 'user') {
    return (
      <div className="ml-auto max-w-[86%] rounded-lg rounded-tr-sm bg-[#1F4452] px-3 py-2 text-sm font-medium leading-6 text-white">
        {item.text}
      </div>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <div className="flex gap-2">
        <BotAvatar size={compact ? 20 : 24} />
        <div className="max-w-[88%] whitespace-pre-wrap rounded-lg rounded-tl-sm border border-[#326273]/12 bg-[#F6F0ED] px-3 py-2 text-sm font-medium leading-6 text-[#326273]">
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === 'activity') {
    return (
      <div className={compact ? 'flex items-center gap-2 pl-7' : 'flex items-center gap-2 pl-8'}>
        <span
          className={
            item.tone === 'propose'
              ? 'inline-flex items-center gap-1.5 rounded-md border border-[#5C9EAD]/35 bg-[#5C9EAD]/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]'
              : 'inline-flex items-center gap-1.5 rounded-md border border-[#326273]/14 bg-white px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/70'
          }
        >
          <span className="h-1 w-1 rounded-full bg-current" aria-hidden="true" />
          {item.label}
        </span>
      </div>
    );
  }

  if (item.kind === 'notice') {
    return (
      <div className="flex flex-wrap items-center gap-2 pl-8">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[#E39774]/55 bg-[#E39774]/15 px-2.5 py-1.5 text-[13px] font-semibold leading-5 text-[#9A4A2D]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {item.text}
        </span>
        {item.retryPrompt && (
          <button
            type="button"
            onClick={() => onRetry(item.retryPrompt!)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#326273]/20 bg-white px-2.5 py-1.5 text-[13px] font-bold text-[#326273] transition hover:border-[#5C9EAD]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </button>
        )}
      </div>
    );
  }

  if (item.kind === 'session-expired') {
    return (
      <div className="flex flex-wrap items-center gap-2 pl-8">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[#E39774]/55 bg-[#E39774]/15 px-2.5 py-1.5 text-[13px] font-semibold leading-5 text-[#9A4A2D]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Your session ended, so 0xWal paused. Sign in again to pick up where you left off.
        </span>
        <Link
          href="/login"
          className="rounded-md bg-[#1F4452] px-2.5 py-1.5 text-[13px] font-bold text-white transition hover:bg-[#326273]"
        >
          Sign in again
        </Link>
      </div>
    );
  }

  const proposal = item.proposal;
  const approval = chatApprovals[proposal.id];
  const remainingMs = approval ? approval.expiresAt - clockMs : 0;

  // Compact surfaces state that something was prepared and send the operator
  // somewhere they can read it. Approving a payment from a floating panel means
  // approving it without the room to see what it is.
  if (compact) {
    return (
      <div className="rounded-lg border border-[#efc46f]/60 bg-[#efc46f]/12 px-3 py-2.5">
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9A4A2D]">
          Unsigned proposal
        </div>
        <p className="mt-1 text-[13px] font-semibold leading-5 text-[#1F4452]">
          {proposal.explain.recommendation}
        </p>
        <Link
          href="/queue"
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[#1F4452] px-2.5 py-1.5 text-[13px] font-bold text-white transition hover:bg-[#326273]"
        >
          Review and approve
        </Link>
      </div>
    );
  }

  // Unsigned proposal — approvable in the thread for two minutes, then it waits
  // in the maker-checker queue like any other proposal.
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 pl-8">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[#efc46f]/60 bg-[#efc46f]/15 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9A4A2D]">
          {approval?.state === 'approved' ? 'Signed · queued for settlement' : 'Unsigned proposal'}
        </span>
      </div>
      <ActionCard key={proposal.id} proposal={proposal} readOnly />

      {approval?.state === 'waiting' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#326273]/14 bg-white px-3 py-2.5">
          <Clock3 className="h-4 w-4 shrink-0 text-[var(--info)]" />
          <span className="text-[13px] font-semibold leading-5 text-[#326273]">
            Approve here for the next{' '}
            <span className="font-mono font-bold tabular-nums text-[#1F4452]">
              {formatCountdown(remainingMs)}
            </span>{' '}
            — after that it waits in the approval queue.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => onApprove(proposal)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#1F4452] px-3.5 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/30"
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve now
            </button>
            <Link
              href="/queue"
              className="rounded-md border border-[#326273]/20 px-3 py-2 text-[13px] font-bold text-[#326273] transition hover:border-[#5C9EAD]"
            >
              Review in queue
            </Link>
          </div>
        </div>
      )}

      {/* No window was opened on this surface — the queue is the only route. */}
      {!approval && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#326273]/14 bg-[#F6F0ED] px-3 py-2.5 text-[13px] font-semibold text-[#326273]">
          <Clock3 className="h-4 w-4 shrink-0 text-[#326273]/50" />
          Prepared and waiting in the maker-checker queue.
          <Link
            href="/queue"
            className="ml-auto rounded-md bg-[#1F4452] px-3 py-1.5 text-[13px] font-bold text-white"
          >
            Open queue
          </Link>
        </div>
      )}

      {approval?.state === 'approving' && (
        <div className="flex items-center gap-2 rounded-lg border border-[#326273]/14 bg-white px-3 py-2.5 text-[13px] font-semibold text-[#326273]">
          <span
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#5C9EAD] border-t-transparent"
            aria-hidden="true"
          />
          Recording your signature…
        </div>
      )}

      {approval?.state === 'approved' && (
        <div className="flex items-center gap-2 rounded-lg border border-[#5C9EAD]/40 bg-[#5C9EAD]/10 px-3 py-2.5 text-[13px] font-bold text-[#326273]">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--info)]" />
          Approved — signed and submitted for settlement. The receipt lands in History.
        </div>
      )}

      {approval?.state === 'expired' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#326273]/14 bg-[#F6F0ED] px-3 py-2.5 text-[13px] font-semibold text-[#326273]">
          <Clock3 className="h-4 w-4 shrink-0 text-[#326273]/50" />
          The in-chat window passed — this proposal now waits in the maker-checker queue.
          <Link
            href="/queue"
            className="ml-auto rounded-md bg-[#1F4452] px-3 py-1.5 text-[13px] font-bold text-white"
          >
            Open queue
          </Link>
        </div>
      )}

      {approval?.state === 'blocked' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#E39774]/55 bg-[#E39774]/12 px-3 py-2.5 text-[13px] font-semibold text-[#9A4A2D]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {approval.note ?? 'Policy requires this one to go through the approval queue.'}
          <Link
            href="/queue"
            className="ml-auto rounded-md bg-[#1F4452] px-3 py-1.5 text-[13px] font-bold text-white"
          >
            Open queue
          </Link>
        </div>
      )}
    </div>
  );
}
