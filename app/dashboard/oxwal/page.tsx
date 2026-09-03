'use client';

import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, ShieldCheck, Trash2, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import MemWalBehaviorCard from '@/components/MemWalBehaviorCard';
import ActionCard from '@/components/oxwal/ActionCard';
import OxWalComposer, { type OxWalComposerChip } from '@/components/oxwal/OxWalComposer';
import { Badge, Button, Card, Chip, ProofRow, Stat } from '@/components/system';
import type { ActionCardProposal } from '@/lib/agent/action-card';
import { stashBatchDraft } from '@/lib/batch-parse';
import { brand } from '@/lib/brand';
import { recordPendingProposals } from '@/lib/oxwal-notify';
import { openOxwalStream, type OxwalStreamStatus } from '@/lib/oxwal/stream-client';
import { clearThread, readThread, writeThread, type PersistedThreadItem } from '@/lib/oxwal/thread-store';
import { cn } from '@/lib/utils';

/**
 * 0xWal desk — a Claude-style expanding chat.
 *
 * Fresh desk: a centred composer. First message: the surface becomes a
 * conversation that grows downward with the composer docked underneath.
 * Everything the agent does surfaces in the thread in operator language:
 * reads become quiet activity lines, warnings become amber notes, and every
 * prepared proposal renders as a read-only action card. Approval happens in
 * Approvals, through the one real path — never here.
 *
 * The stream is resumable: a dropped connection re-attaches to the same
 * server-side run with backoff, so an answer is never a dead panel and a
 * proposal is never prepared twice.
 */

type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'activity'; id: string; label: string; tone: 'read' | 'propose' }
  | { kind: 'notice'; id: string; text: string; retryPrompt?: string; approvalsLink?: boolean }
  | { kind: 'session-expired'; id: string }
  | { kind: 'proposal'; id: string; proposal: ActionCardProposal }
  | { kind: 'proposal-ref'; id: string; proposalId: string; proposalKind: string; corridor: string | null; recommendation: string };

const quickPrompts: OxWalComposerChip[] = [
  { label: 'Review invoice', prompt: 'Pay invoice inv_demo_acme_5000 to cp_acme_ph', icon: 'file' },
  { label: 'Allocate treasury', prompt: 'Allocate idle treasury for MY_PH', icon: 'write' },
  { label: 'Look up tools', prompt: 'What can you read and prepare?', icon: 'search' },
];

/** The operator sees what 0xWal is doing, never which backend does it. */
const activityLabels: Record<string, string> = {
  getBalances: 'Reading balances',
  getTreasuryState: 'Reading treasury state',
  getCorridorLiquidity: 'Checking corridor liquidity',
  getRate: 'Fetching FX rate',
  getCounterparty: 'Verifying counterparty',
  getInvoice: 'Reading invoice',
  getNettingOpportunities: 'Scanning offset opportunities (modeled)',
  getComplianceStatus: 'Checking compliance',
  proposePayment: 'Preparing payment proposal',
  proposeInternalTransfer: 'Preparing internal transfer',
  proposeFxConvert: 'Preparing FX conversion',
  proposeTreasuryAllocation: 'Preparing treasury allocation',
  proposeTreasuryRedeem: 'Preparing treasury redemption',
  proposeNettingSettlement: 'Preparing offset settlement (roadmap simulation)',
  proposeBatchPayout: 'Preparing batch payout',
};

const WELCOME = `${brand.agentName} is standing by. Every money movement becomes an unsigned proposal for human approval.`;

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Thread → persisted form: proposal bodies are replaced by references. */
function toPersisted(items: ThreadItem[]): PersistedThreadItem[] {
  return items.flatMap((item): PersistedThreadItem[] => {
    if (item.kind === 'session-expired' || item.id === 'assistant_welcome') return [];
    if (item.kind === 'proposal') {
      return [{
        kind: 'proposal-ref' as const,
        id: item.id,
        proposalId: item.proposal.id,
        proposalKind: item.proposal.kind,
        corridor: item.proposal.corridor ?? null,
        recommendation: item.proposal.explain.recommendation,
      }];
    }
    if (item.kind === 'notice') return [{ kind: 'notice' as const, id: item.id, text: item.text }];
    return [item];
  });
}

export default function OxwalDeskPage() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [thread, setThread] = useState<ThreadItem[]>([{ kind: 'assistant', id: 'assistant_welcome', text: WELCOME }]);
  const [streamingText, setStreamingText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [link, setLink] = useState<OxwalStreamStatus | null>(null);
  const [organization, setOrganization] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoredRef = useRef(false);

  const hasStarted = thread.some((item) => item.kind !== 'assistant' || item.id !== 'assistant_welcome');

  const proposals = useMemo(() => thread.flatMap((item) => (item.kind === 'proposal' ? [item.proposal] : [])), [thread]);
  const deskStats = useMemo(() => ({
    proposals: thread.filter((item) => item.kind === 'proposal' || item.kind === 'proposal-ref').length,
    notices: thread.filter((item) => item.kind === 'notice').length,
  }), [thread]);

  // Restore the persisted conversation for this organisation, then honour a
  // deep link (?prompt=… from Treasury or the floating indicator; &send=1
  // submits it).
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/session', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((session: { organization?: string } | null) => {
        if (cancelled || !session?.organization) return;
        const org = session.organization;
        setOrganization(org);
        const restored = readThread(org);
        if (restored.length > 0 && !restoredRef.current) {
          restoredRef.current = true;
          setThread((current) => [...current, ...(restored as ThreadItem[])]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!organization) return;
    writeThread(organization, toPersisted(thread));
  }, [thread, organization]);

  // Keep the newest turn in view while the conversation grows or streams.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [thread, streamingText]);

  const refreshPending = useCallback(async () => {
    try {
      const response = await fetch('/api/proposals', { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as { items: Array<{ recommendation: string }>; total: number };
      recordPendingProposals({ count: body.total, label: body.items[0]?.recommendation ?? null });
    } catch {
      /* the badge simply keeps its last value */
    }
  }, []);

  const submitPrompt = useCallback(async (rawPrompt: string) => {
    const prompt = rawPrompt.trim();
    if (!prompt || isSending) return;

    const history = thread
      .flatMap((item) => (item.kind === 'user' || item.kind === 'assistant' ? [{ role: item.kind, content: item.text }] : []))
      .slice(-8);

    setInput('');
    setStreamingText('');
    setIsSending(true);
    setLink(null);
    setThread((current) => [...current, { kind: 'user', id: newId('user'), text: prompt }]);

    let assistantText = '';
    let sawProposal = false;
    const flushAssistant = () => {
      const text = assistantText.trim();
      if (text) setThread((current) => [...current, { kind: 'assistant', id: newId('assistant'), text }]);
      assistantText = '';
      setStreamingText('');
    };

    const result = await openOxwalStream({
      message: prompt,
      history,
      onStatus: (status) => {
        setLink(status);
        if (status.phase !== 'failed') return;
        flushAssistant();
        if (status.reason === 'unauthorized') {
          setThread((current) => [...current, { kind: 'session-expired', id: newId('expired') }]);
          return;
        }
        setThread((current) => [
          ...current,
          { kind: 'notice', id: newId('notice'), text: status.message, retryPrompt: status.started ? undefined : prompt, approvalsLink: status.started },
        ]);
      },
      onEvent: (event) => {
        if (event.type === 'tool') {
          // A tool call ends the current text turn — commit it so the activity
          // line lands between turns, in order.
          flushAssistant();
          setThread((current) => [
            ...current,
            { kind: 'activity', id: newId('tool'), label: activityLabels[event.name] ?? 'Working', tone: event.category === 'PROPOSE' ? 'propose' : 'read' },
          ]);
        } else if (event.type === 'warning') {
          flushAssistant();
          setThread((current) => [...current, { kind: 'notice', id: newId('notice'), text: event.warning.message }]);
        } else if (event.type === 'error') {
          flushAssistant();
          setThread((current) => [...current, { kind: 'notice', id: newId('notice'), text: `${brand.agentName} stopped before finishing: ${event.message}. Nothing was signed.` }]);
        } else if (event.type === 'proposal') {
          flushAssistant();
          sawProposal = true;
          setThread((current) => [...current, { kind: 'proposal', id: newId('proposal'), proposal: event.proposal }]);
        } else if (event.type === 'delta') {
          assistantText += event.text;
          setStreamingText(assistantText);
        }
      },
    });

    flushAssistant();
    setStreamingText('');
    setIsSending(false);
    if (result === 'done') setLink(null);
    if (sawProposal) void refreshPending();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [isSending, thread, refreshPending]);

  // Deep link: prefill (and optionally send) a prompt handed over by another surface.
  const deepLinkRef = useRef<{ prompt: string; send: boolean } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get('prompt')?.trim();
    if (!prompt) return;
    deepLinkRef.current = { prompt, send: params.get('send') === '1' };
    window.history.replaceState(null, '', window.location.pathname);
    const timer = window.setTimeout(() => {
      const pending = deepLinkRef.current;
      deepLinkRef.current = null;
      if (!pending) return;
      if (pending.send) void submitPrompt(pending.prompt);
      else setInput(pending.prompt);
    }, 0);
    return () => window.clearTimeout(timer);
    // The submit callback is stable enough for a one-shot deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetConversation() {
    clearThread();
    setThread([{ kind: 'assistant', id: 'assistant_welcome', text: WELCOME }]);
    setLink(null);
  }

  const composer = (
    <OxWalComposer
      compact={hasStarted}
      title={hasStarted ? undefined : "What's on the agenda today?"}
      value={input}
      onChange={setInput}
      onSubmit={() => void submitPrompt(input)}
      onChipSubmit={(prompt) => void submitPrompt(prompt)}
      onFilePrepared={(batch) => {
        stashBatchDraft(batch);
        router.push('/dashboard/batch?draft=1');
      }}
      chips={hasStarted ? [] : quickPrompts}
      disabled={isSending}
      inputRef={inputRef}
      placeholder={`Ask ${brand.agentName} to read, prepare, or explain — or attach a payout sheet`}
    />
  );

  const online = link?.phase !== 'reconnecting' && link?.phase !== 'failed';

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <main className="min-w-0 grid content-start gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">{brand.agentName}</h1>
              <Badge tone={online ? 'green' : 'amber'}>
                {online ? 'Online' : link?.phase === 'reconnecting' ? 'Reconnecting' : 'Offline'}
              </Badge>
            </div>
            <p className="mt-1 text-[14px] text-[var(--text-2)]">Reads state, prepares unsigned proposals, explains its reasoning. You approve in Approvals.</p>
          </div>
          <div className="flex items-center gap-4" aria-label="Session summary">
            <Stat label="Proposals" value={String(deskStats.proposals)} />
            <Stat label="Notices" value={String(deskStats.notices)} tone={deskStats.notices > 0 ? 'pending' : 'default'} />
          </div>
        </header>

        {!hasStarted ? (
          <Card padding="lg" className="px-4 py-10 md:px-8 md:py-14">
            {composer}
          </Card>
        ) : (
          <Card padding="none" className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--divider)] px-4 py-3">
              <div className="flex items-center gap-2">
                <BotAvatar />
                <h2 className="text-[14px] font-semibold">{brand.agentName}</h2>
                <span className="hidden font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)] sm:inline">prepares · you approve</span>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={resetConversation} aria-label="Clear conversation">
                  <Trash2 aria-hidden="true" /> <span className="hidden sm:inline">Clear</span>
                </Button>
                <Button variant="ghost" size="sm" href="/dashboard/approvals">
                  Approvals
                </Button>
              </div>
            </div>

            <div ref={threadRef} role="log" aria-live="polite" aria-label={`${brand.agentName} conversation`} className="max-h-[62vh] min-h-[380px] space-y-3 overflow-y-auto p-4">
              {thread.map((item) => (
                <ThreadRow key={item.id} item={item} onRetry={(prompt) => void submitPrompt(prompt)} />
              ))}

              {streamingText ? (
                <div className="flex gap-2">
                  <BotAvatar />
                  <div className="max-w-[88%] rounded-[var(--r-md)] rounded-tl-sm border border-[var(--teal-100)] bg-[var(--teal-100)]/50 px-3 py-2 text-[14px] leading-6">
                    <span className="whitespace-pre-wrap">{streamingText}</span>
                    <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-[var(--teal-600)]" aria-hidden="true" />
                  </div>
                </div>
              ) : null}

              {isSending && !streamingText && link?.phase !== 'reconnecting' ? (
                <div className="flex gap-2" aria-label={`${brand.agentName} is working`}>
                  <BotAvatar />
                  <div className="flex items-center gap-1.5 rounded-[var(--r-md)] rounded-tl-sm border border-[var(--divider)] bg-[var(--surface-2)] px-3 py-2.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-[var(--teal-600)] [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-[var(--teal-600)] [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-[var(--teal-600)] [animation-delay:300ms]" />
                  </div>
                </div>
              ) : null}
            </div>

            {link?.phase === 'reconnecting' ? (
              <div role="status" className="flex items-center gap-2 border-t border-[var(--amber-100)] bg-[var(--amber-100)] px-4 py-2 text-[13px] text-[var(--amber-700)]">
                <WifiOff className="size-4 shrink-0" aria-hidden="true" />
                Reconnecting… attempt {link.attempt}. The answer continues on the server; nothing is signed without you.
              </div>
            ) : null}

            <div className="border-t border-[var(--divider)] bg-[var(--surface)] p-3">{composer}</div>
          </Card>
        )}
      </main>

      <aside className="grid content-start gap-4">
        <MemWalBehaviorCard compact />
        <Card className="grid gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-[var(--teal-600)]" aria-hidden="true" />
            <h2 className="text-[14px] font-semibold">Control state</h2>
          </div>
          <dl>
            <ProofRow label="Tool boundary" value="Read + propose" />
            <ProofRow label="Submit guard" value="Policy re-check" />
            <ProofRow label="Circuit breaker" value="Armed" />
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <Chip>proposes</Chip>
            <Chip tone="teal">human approves</Chip>
            <Chip tone="green">deterministic execution</Chip>
          </div>
        </Card>
        <Card tone="dark" className="grid gap-3 text-white">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/70">Approval surface</p>
          <div className="text-[20px] font-semibold">Maker-checker</div>
          <p className="text-[13px] leading-5 text-white/75">
            {proposals.length > 0
              ? `${proposals.length} unsigned ${proposals.length === 1 ? 'proposal from this session is' : 'proposals from this session are'} waiting for a human decision.`
              : 'Pending proposals, compliance holds, expiring quotes and failed settlements wait in Approvals.'}
          </p>
          <Button href="/dashboard/approvals" variant="primary" className="justify-self-start">
            Open Approvals
          </Button>
        </Card>
      </aside>
    </div>
  );
}

function ThreadRow({ item, onRetry }: { item: ThreadItem; onRetry: (prompt: string) => void }) {
  if (item.kind === 'user') {
    return <div className="ml-auto max-w-[86%] rounded-[var(--r-md)] rounded-tr-sm bg-[var(--ink-900)] px-3 py-2 text-[14px] leading-6 text-white">{item.text}</div>;
  }

  if (item.kind === 'assistant') {
    return (
      <div className="flex gap-2">
        <BotAvatar />
        <div className="max-w-[88%] whitespace-pre-wrap rounded-[var(--r-md)] rounded-tl-sm border border-[var(--divider)] bg-[var(--surface-2)] px-3 py-2 text-[14px] leading-6">{item.text}</div>
      </div>
    );
  }

  if (item.kind === 'activity') {
    return (
      <div className="pl-8">
        <Chip tone={item.tone === 'propose' ? 'teal' : 'default'} ghost={item.tone !== 'propose'}>
          {item.label}
        </Chip>
      </div>
    );
  }

  if (item.kind === 'notice') {
    return (
      <div className="flex flex-wrap items-center gap-2 pl-8">
        <span className="inline-flex items-start gap-1.5 rounded-[var(--r-sm)] border border-[var(--amber-100)] bg-[var(--amber-100)] px-2.5 py-1.5 text-[13px] leading-5 text-[var(--amber-700)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {item.text}
        </span>
        {item.retryPrompt ? (
          <Button variant="ghost" size="sm" onClick={() => onRetry(item.retryPrompt!)}>
            <RotateCcw aria-hidden="true" /> Try again
          </Button>
        ) : null}
        {item.approvalsLink ? (
          <Button variant="ghost" size="sm" href="/dashboard/approvals">
            Open Approvals
          </Button>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'session-expired') {
    return (
      <div className="flex flex-wrap items-center gap-2 pl-8">
        <span className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--amber-100)] bg-[var(--amber-100)] px-2.5 py-1.5 text-[13px] leading-5 text-[var(--amber-700)]">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          Your session ended, so {brand.agentName} paused. Sign in again to pick up where you left off.
        </span>
        <Button size="sm" href="/login">
          Sign in again
        </Button>
      </div>
    );
  }

  if (item.kind === 'proposal-ref') {
    return (
      <div className="grid gap-1.5">
        <div className="pl-8">
          <Chip tone="teal">Earlier proposal</Chip>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">{item.recommendation}</div>
            <div className="font-mono text-[12px] text-[var(--text-muted)]">
              {item.proposalKind} · {item.corridor ?? 'no corridor'} · {item.proposalId}
            </div>
          </div>
          <Button variant="ghost" size="sm" href="/dashboard/approvals">
            Review in Approvals
          </Button>
        </div>
      </div>
    );
  }

  // Unsigned proposal: readable here, decided in Approvals.
  const proposal = item.proposal;
  return (
    <div className="grid gap-1.5">
      <div className="pl-8">
        <Chip tone="teal">Unsigned proposal</Chip>
      </div>
      <ActionCard key={proposal.id} proposal={proposal} readOnly />
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
        <Clock3 className="size-4 shrink-0 text-[var(--teal-600)]" aria-hidden="true" />
        <span className="text-[13px] leading-5 text-[var(--text-2)]">Waiting in Approvals. Nothing moves until a human signs it there.</span>
        <Button size="sm" href="/dashboard/approvals" className="ml-auto">
          <CheckCircle2 aria-hidden="true" /> Review in Approvals
        </Button>
      </div>
    </div>
  );
}

function BotAvatar({ className }: { className?: string }) {
  return (
    <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[var(--teal-100)] font-mono text-[10px] font-semibold text-[var(--teal-600)]', className)} aria-hidden="true">
      0x
    </span>
  );
}
