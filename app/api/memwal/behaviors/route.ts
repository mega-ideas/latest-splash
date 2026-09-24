import { NextResponse } from 'next/server';

import { MIN_MEMORY_RELEVANCE, memoryRelevance } from '@/lib/server/copilot';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { recallMemories } from '@/lib/server/memwal';

const demoBehaviors = [
  'Pays PH suppliers weekly',
  'Batches on Friday',
  'Prefers USD settlement',
];

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  try {
    const recalled = await recallMemories('business payment behavior patterns', 3);
    const seen = new Set<string>();
    // The same score, cutoff and meaning as the copilot's suggestion cards
    // (lib/server/copilot.ts): how closely a memory matched the query, shown
    // as "memory match". Filler below the cutoff is not a pattern.
    const uniqueRecalled = recalled.flatMap((memory) => {
      const normalized = memory.text.trim().toLowerCase();
      const relevance = memoryRelevance(memory.distance);
      if (!normalized || seen.has(normalized)) return [];
      if (relevance === null || relevance < MIN_MEMORY_RELEVANCE) return [];
      seen.add(normalized);
      return [{ text: memory.text, relevance }];
    });
    const recalledMemories = uniqueRecalled.map((memory) => ({
      text: memory.text,
      confidence: memory.relevance,
      demo: false,
    }));
    // Demo memories were never recalled, so they have no match to show. They
    // used to carry an invented 94% / 91% / 88%.
    const fallbackMemories = demoBehaviors
      .filter((text) => !seen.has(text.toLowerCase()))
      .map((text) => ({ text, confidence: null, demo: true }));
    const memories = [...recalledMemories, ...fallbackMemories].slice(0, 3);
    return NextResponse.json({ memories }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.warn('[memwal] behavior route fallback:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({
      memories: demoBehaviors.map((text) => ({ text, confidence: null, demo: true })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
