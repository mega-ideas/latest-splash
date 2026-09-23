'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, Globe, Layers, Lock, Sparkles, TrendingUp, X } from 'lucide-react';
import Link from 'next/link';

import MemWalBehaviorCard from '@/components/MemWalBehaviorCard';
import OxWalComposer, { type OxWalComposerChip } from '@/components/oxwal/OxWalComposer';
import ThreadRow, { BotAvatar, StreamingRow, ThinkingRow } from '@/components/oxwal/ThreadView';
import { useOxwalThread } from '@/lib/oxwal/use-oxwal-thread';

/**
 * The 0xWal copilot room.
 *
 * ─── What this page used to be ──────────────────────────────────────────────
 *
 * A chat seeded with three invented turns, backed by a keyword matcher that
 * answered "what is the PHP rate" with `56.42` from a string literal, beside a
 * "MemWal Memory" panel asserting this operator runs a Friday 09:00 batch of
 * $11,800 across five corridors — none of it read from anything.
 *
 * The rates were the serious part. They rendered in the same bubble, weight and
 * tone as a real answer, on a page whose stated purpose is helping someone
 * decide when to move money. There was no marking, so nothing on screen let an
 * operator tell an invented figure from a fetched one.
 *
 * Every one of those is gone. The chat is the tool-using agent, the behaviour
 * panel is the live MemWal card that labels demo memories as demo, and the
 * suggestions come from /api/copilot/suggest or the rail says there are none.
 *
 * ─── Why suggestions became prompts ─────────────────────────────────────────
 *
 * They used to be cards with a button to another screen. Next to a chat that
 * can actually act, a suggestion is better as an opening line — clicking one
 * asks 0xWal about it here, where the answer can be questioned, instead of
 * dropping the operator on a form with no memory of why they came.
 */

type SuggestionCard = {
  id: string;
  title: string;
  body: string;
  kind: string;
  prompt: string;
  confidence: number;
};

type ApiSuggestion = {
  suggestionId: string;
  type: string;
  title: string;
  description: string;
  confidence: number;
  suggestedAction?: string;
};

function mapSuggestion(s: ApiSuggestion): SuggestionCard {
  const kind =
    s.type === 'timing' ? 'FX timing' : s.type.charAt(0).toUpperCase() + s.type.slice(1);
  return {
    id: s.suggestionId,
    title: s.title,
    body: s.description,
    kind,
    // The suggestion's own words become the question. 0xWal then has to go and
    // read something to answer it, which is the point — a suggestion an
    // operator cannot interrogate is just a banner.
    prompt: `${s.title}. ${s.description} — walk me through this and prepare it if it holds up.`,
    confidence: Math.round((s.confidence ?? 0.6) * 100),
  };
}

const STARTER_CHIPS: OxWalComposerChip[] = [
  { label: 'Where is my money', prompt: 'Show me balances and treasury state', icon: 'search' },
  { label: 'Check a recipient', prompt: 'Which recipients am I able to pay right now?', icon: 'file' },
  { label: 'What can you do', prompt: 'What can you read and prepare?', icon: 'write' },
];

const WELCOME =
  'Ask me to read financial state, check a recipient, or prepare a payment. '
  + 'I prepare and explain; a person signs. Nothing here moves money on its own.';

export default function CopilotPage() {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [suggestState, setSuggestState] = useState<'loading' | 'ready' | 'error'>('loading');

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
  } = useOxwalThread({ welcome: WELCOME });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/copilot/suggest', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`suggest returned ${response.status}`);
        const result = (await response.json()) as { suggestions?: ApiSuggestion[] };
        setSuggestions((result.suggestions ?? []).map(mapSuggestion));
        setSuggestState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn(
          '[copilot] suggestions unavailable:',
          error instanceof Error ? error.message : String(error),
        );
        setSuggestState('error');
      }
    })();
    return () => controller.abort();
  }, []);

  function handleSubmit() {
    void submitPrompt(input);
    setInput('');
  }

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <main className="min-w-0 space-y-4">
        <header className="dash-block dash-block-accent dash-reveal p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="dash-kicker">Copilot · MemWal</span>
            {/* The AI label is not attached to the name, so renaming the
                assistant cannot remove it. Someone reading a payment
                recommendation is entitled to know what wrote it. */}
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[#0c3e48] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white">
              <Sparkles className="h-3 w-3 text-[#efc46f]" aria-hidden="true" />
              AI assistant
            </span>
          </div>
          <h1 className="dash-title mt-3 text-3xl md:text-4xl">{assistantName}</h1>
          <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-[#326273]/62">
            Grounded in what your workspace actually holds. It reads live state and prepares
            unsigned proposals — it cannot send, sign, or settle anything.
          </p>
        </header>

        <section className="dash-surface dash-reveal flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-[#326273]/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <BotAvatar size={24} />
              <h2 className="text-sm font-bold text-[#1F4452]">{assistantName}</h2>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/45">
                prepares · you approve
              </span>
            </div>
            <Link
              href="/queue"
              className="text-[13px] font-bold text-[#326273] underline-offset-4 hover:underline"
            >
              Approval queue
            </Link>
          </div>

          <div
            ref={threadRef}
            className="max-h-[58vh] min-h-[420px] space-y-3 overflow-y-auto p-4"
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

          <div className="border-t border-[#326273]/10 bg-white/60 p-3">
            <OxWalComposer
              compact
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onChipSubmit={(prompt) => void submitPrompt(prompt)}
              chips={thread.length > 1 ? [] : STARTER_CHIPS}
              disabled={isSending}
              placeholder="Ask about balances, a recipient, a corridor, or an invoice"
            />
          </div>
        </section>
      </main>

      <aside className="space-y-4 dash-reveal-stagger">
        <div className="dash-block p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--info)]" />
            <h2 className="text-sm font-bold text-[#1F4452]">Suggestions</h2>
          </div>
          <p className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/55">
            Read from your invoices and treasury. Tap one to ask about it.
          </p>

          <div className="mt-3 space-y-2">
            {suggestState === 'loading' && (
              <div className="space-y-2" aria-hidden="true">
                <div className="h-14 animate-pulse rounded-lg bg-[#F6F0ED]" />
                <div className="h-14 animate-pulse rounded-lg bg-[#F6F0ED]" />
              </div>
            )}

            {/* Both empty states say which one it is. "Nothing to suggest" and
                "could not look" are different facts, and an operator planning
                around the first should not be shown it when it was the second. */}
            {suggestState === 'error' && (
              <p className="rounded-lg border border-[#E39774]/45 bg-[#E39774]/12 px-3 py-2.5 text-[13px] font-semibold leading-5 text-[#9A4A2D]">
                Suggestions could not be loaded. Ask directly in the chat instead.
              </p>
            )}

            {suggestState === 'ready' && suggestions.length === 0 && (
              <p className="rounded-lg border border-[#326273]/12 bg-[#F6F0ED] px-3 py-2.5 text-[13px] font-medium leading-5 text-[#326273]/70">
                Nothing to suggest right now — no unpaid invoices or idle balances worth acting on.
              </p>
            )}

            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => void submitPrompt(suggestion.prompt)}
                disabled={isSending}
                className="w-full rounded-lg border border-[#326273]/12 border-l-2 border-l-[#5C9EAD] bg-white px-3 py-2.5 text-left transition hover:border-[#5C9EAD]/50 disabled:opacity-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/55">
                    {suggestion.kind}
                  </span>
                  <span className="font-mono text-[10px] font-semibold tabular-nums text-[#326273]/45">
                    {suggestion.confidence}% confidence
                  </span>
                </div>
                <div className="mt-1 text-[13px] font-bold leading-5 text-[#1F4452]">
                  {suggestion.title}
                </div>
                <div className="mt-0.5 text-[13px] font-medium leading-5 text-[#326273]/62">
                  {suggestion.body}
                </div>
              </button>
            ))}
          </div>
        </div>

        <MemWalBehaviorCard />

        <div className="dash-block p-4">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-[var(--info)]" />
            <h2 className="text-sm font-bold text-[#1F4452]">What MemWal stores</h2>
          </div>
          <div className="mt-3 space-y-2">
            <div>
              <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                Stored — behavioural only
              </div>
              {[
                'Corridor frequency and timing',
                'Batch size patterns',
                'Rate sensitivity bands',
                'What you call this assistant',
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-1.5 py-0.5 text-[13px] font-medium text-[#326273]/70"
                >
                  <span className="h-1 w-1 shrink-0 rounded-full bg-emerald-600" aria-hidden="true" />
                  {item}
                </div>
              ))}
            </div>
            <div className="border-t border-[#326273]/10 pt-2">
              <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9A4A2D]">
                Never stored
              </div>
              {[
                'Invoice PDFs or their contents',
                'Recipient bank details',
                'Account numbers',
                'KYB documents',
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-1.5 py-0.5 text-[13px] font-medium text-[#326273]/70"
                >
                  <X className="h-2.5 w-2.5 shrink-0 text-[#9A4A2D]" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          {[
            { label: 'Batch payout', href: '/dashboard/batch', icon: Layers },
            { label: 'Treasury yield', href: '/dashboard/treasury', icon: TrendingUp },
            { label: 'Command desk', href: '/dashboard', icon: Globe },
          ].map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex w-full items-center justify-between rounded-lg border border-[#326273]/12 bg-white px-3 py-2.5 text-[13px] font-bold text-[#326273] transition hover:border-[#5C9EAD]/50 hover:text-[var(--info)]"
            >
              <span className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-[#326273]/30" />
            </Link>
          ))}
        </div>
      </aside>
    </div>
  );
}
