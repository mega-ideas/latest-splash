'use client';

import { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, CheckCircle2, LockKeyhole } from 'lucide-react';

import StatusBadge from '@/components/StatusBadge';
import { confidencePercent } from '@/lib/confidence';

/** `confidence`: how closely a recalled memory matched, 0..1; null for demo memories and placeholders. */
type Memory = { text: string; confidence: number | null; demo: boolean };

export default function MemWalBehaviorCard({ compact = false }: { compact?: boolean }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const controller = new AbortController();

    async function loadMemories() {
      try {
        const response = await fetch('/api/memwal/behaviors', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok || !contentType.includes('application/json')) {
          throw new Error(`MemWal behaviors returned ${response.status} ${contentType || 'without a content type'}`);
        }
        const result = (await response.json()) as { memories?: Memory[] };
        setMemories(Array.isArray(result.memories) ? result.memories : []);
        setLoadState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('[memwal] behavior card unavailable:', error instanceof Error ? error.message : String(error));
        setMemories([]);
        setLoadState('error');
      }
    }

    void loadMemories();
    return () => controller.abort();
  }, []);

  const displayMemories = useMemo(() => {
    const seen = new Set<string>();
    return memories.filter((memory) => {
      const normalized = typeof memory.text === 'string' ? memory.text.trim().toLowerCase() : '';
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }, [memories]);

  const memoryCards = displayMemories.length > 0
    ? displayMemories
    : [{
        text: loadState === 'error' ? 'Behavior memory is temporarily unavailable.' : 'Recalling behavior patterns...',
        confidence: null,
        demo: false,
      }];

  return (
    <section className="dash-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-primary/10 p-2 text-primary"><BrainCircuit className="h-5 w-5" /></span>
          <div>
            <h2 className="font-bold text-foreground">MemWal behavior memory</h2>
            <p className="mt-1 text-[13px] text-foreground/55">Safe operating patterns that sharpen suggestions.</p>
          </div>
        </div>
        {displayMemories.some((memory) => memory.demo) && <StatusBadge status="demo" />}
      </div>
      <div className={`mt-4 grid gap-2 ${compact ? '' : 'sm:grid-cols-3'}`}>
        {memoryCards.map((memory) => (
          <div key={memory.text.trim().toLowerCase()} className="rounded-xl bg-muted/55 p-3">
            <div className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><strong className="text-sm">{memory.text}</strong></div>
            {confidencePercent(memory.confidence) !== null && <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/40">{confidencePercent(memory.confidence)}% memory match</div>}
          </div>
        ))}
      </div>
      <p className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-foreground/45"><LockKeyhole className="h-3.5 w-3.5" /> Behavioral text only. No amounts, accounts, or KYC data.</p>
    </section>
  );
}
