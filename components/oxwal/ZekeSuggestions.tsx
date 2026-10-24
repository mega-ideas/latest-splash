'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { confidencePercent } from '@/lib/confidence';

/**
 * Suggestions for Zeke, drawn from open invoices and MemWal memory
 * (/api/copilot/suggest). Moved here from the copilot room when that page
 * folded into the Zeke page (v2 brief 5.1).
 *
 * A suggestion is an opening line, not a card that jumps to another screen:
 * clicking one asks Zeke about it, where the answer can be questioned.
 */

type SuggestionCard = {
  id: string;
  title: string;
  body: string;
  kind: string;
  prompt: string;
  /** Whole percent, or null when the suggestion measured nothing. */
  confidence: number | null;
};

type ApiSuggestion = {
  suggestionId: string;
  type: string;
  title: string;
  description: string;
  confidence: number | null;
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
    // The suggestion's own words become the question. Zeke then has to go and
    // read something to answer it, which is the point: a suggestion an
    // operator cannot interrogate is just a banner.
    prompt: `${s.title}. ${s.description}. Walk me through this and prepare it if it holds up.`,
    // No score, no percentage. A missing one used to be shown as 60%.
    confidence: confidencePercent(s.confidence),
  };
}

export default function ZekeSuggestions({
  onAsk,
  disabled,
}: {
  onAsk: (prompt: string) => void;
  disabled?: boolean;
}) {
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [suggestState, setSuggestState] = useState<'loading' | 'ready' | 'error'>('loading');

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
          '[zeke] suggestions unavailable:',
          error instanceof Error ? error.message : String(error),
        );
        setSuggestState('error');
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <div className="dash-block p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-[var(--info)]" aria-hidden="true" />
        <h2 className="text-sm font-bold text-[var(--ink)]">Suggestions</h2>
      </div>
      <p className="mt-1 text-[13px] font-medium leading-5 text-[var(--slate)]">
        Drawn from your open invoices and MemWal memory. Tap one to ask about it.
      </p>

      <div className="mt-3 space-y-2" aria-live="polite">
        {suggestState === 'loading' && (
          <div className="space-y-2" aria-hidden="true">
            <div className="h-14 animate-pulse rounded-lg bg-[var(--bg)]" />
            <div className="h-14 animate-pulse rounded-lg bg-[var(--bg)]" />
          </div>
        )}

        {/* Both empty states say which one it is. "Nothing to suggest" and
            "could not look" are different facts, and an operator planning
            around the first should not be shown it when it was the second. */}
        {suggestState === 'error' && (
          <p className="rounded-lg border border-[var(--gold-light)] bg-[var(--gold-tint)] px-3 py-2.5 text-[13px] font-semibold leading-5 text-[var(--gold-ink)]">
            Suggestions could not be loaded. Ask directly in the chat instead.
          </p>
        )}

        {suggestState === 'ready' && suggestions.length === 0 && (
          <p className="rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2.5 text-[13px] font-medium leading-5 text-[var(--slate)]">
            Nothing to suggest right now. Ask directly in the chat.
          </p>
        )}

        {suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            onClick={() => onAsk(suggestion.prompt)}
            disabled={disabled}
            className="w-full rounded-lg border border-[var(--line)] border-l-2 border-l-[var(--teal)] bg-white px-3 py-2.5 text-left transition hover:border-[var(--teal)] disabled:opacity-50"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-[var(--slate)]">{suggestion.kind}</span>
              {/* The only score these cards carry is how closely a recalled
                  memory matched (lib/server/copilot.ts memoryRelevance), so
                  it is labelled as that, not as confidence the suggestion is right. */}
              {suggestion.confidence !== null && (
                <span className="text-[12px] font-semibold tabular-nums text-[var(--slate)]">
                  {suggestion.confidence}% memory match
                </span>
              )}
            </div>
            <div className="mt-1 text-[13px] font-bold leading-5 text-[var(--ink)]">{suggestion.title}</div>
            <div className="mt-0.5 text-[13px] font-medium leading-5 text-[var(--slate)]">{suggestion.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
