import { USD_DECIMALS, formatMinor, parseMinor } from '../money.ts';
import { copilotModel } from '../ai/model.ts';
/**
 * Zeke — layered copilot intelligence.
 *
 * Real implementations (no placeholders): grounded in corridor data, MemWal
 * behavioral memory, and the floating USDY treasury rate. Claude is used where
 * it adds value (invoice extraction) but every function degrades gracefully
 * without ANTHROPIC_API_KEY. RULE: the copilot only SUGGESTS — the user must
 * authorize execution. Never invents PII/account numbers.
 */

import { getCorridorFeeBps } from '@/lib/fx/corridors';
import { custodyPhaseEnabled } from '@/lib/server/custody-phase';
import { recallForOrg, rememberForOrg, type RecalledMemory } from '@/lib/server/memwal';
import { getTreasuryRate } from '@/lib/server/usdy';

export interface CopilotSuggestion {
  suggestionId: string;
  type: 'timing' | 'batch' | 'treasury' | 'invoice';
  title: string;
  description: string;
  /** 0..1, only when something measured it. null = nothing did: a canned or
   *  rule-based card has no confidence to state, and must not invent one. */
  confidence: number | null;
  requiresAuth: boolean;
  suggestedAction?: string;
  /** Set when Zeke read the document and refused: the lane it asks for is
   *  locked for this business. The UI must not offer a route onward. */
  blocked?: { lane: string; reason: string };
}

const SUPPORTED = ['PHP', 'MYR', 'IDR', 'VND', 'THB', 'SGD', 'EUR', 'GBP'];

// ─── Invoice parsing (Claude when available, heuristic otherwise) ───────────────

/**
 * A candidate amount from a model or a regex, as exact minor units and the
 * decimal string that produced them. Thousands separators and a currency
 * symbol are stripped; anything still unparseable is zero, because a
 * guessed figure on an approval screen is worse than an obvious one.
 *
 * Invoices are quoted to the cent, so extra fraction digits are rounded
 * half-up rather than refused — an OCR artefact should not fail the whole
 * extraction.
 */
function normaliseAmount(raw: string): { amount: string; amountMinor: bigint } {
  const cleaned = raw.replace(/[,\s]/g, '').replace(/^[^\d.+-]+/, '');
  try {
    const minor = parseMinor(cleaned, USD_DECIMALS, 'half-up');
    return { amount: formatMinor(minor, USD_DECIMALS), amountMinor: minor };
  } catch {
    return { amount: '0.00', amountMinor: 0n };
  }
}

/**
 * Remember the behavioural pattern (vendor + currency), never the raw
 * document, and only for the org whose invoice it is.
 *
 * It used to go through `analyze` into one namespace every workspace shared,
 * and the suggestion cards print a recalled memory word for word, so one
 * tenant was shown another's counterparty names. `remember` rather than
 * `analyze`: the sentence is already the fact, and the relayer's extractor
 * rewrites text, which would drop the org key recall checks for.
 *
 * The vendor is read off a document a third party wrote, so it is kept to one
 * short line before it becomes a memory. Only a pattern that was read is
 * remembered: a vendor or currency the parser could not read ('') is not a
 * fact to store ("settles in " with nothing after it, or, before, an
 * invented 'USD').
 */
function rememberInvoiceVendor(orgId: string, recipient: string, currency: string): void {
  const vendor = recipient.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!vendor || !currency) return;
  void rememberForOrg(orgId, `Invoice vendor ${vendor} settles in ${currency}`);
}

export async function parseInvoice(
  invoiceText: string,
  /** The session's org. The vendor pattern is remembered for it and no other. */
  orgId: string,
/**
 * Extract the payable amount, currency and vendor from invoice text.
 *
 * The amount is an exact decimal string, and the minor units beside it.
 * It used to be a `number`, which meant the figure a human is asked to
 * approve — and which is stored verbatim in the audit receipt — had been
 * through a double on its way out of a regex or a JSON body. The model is
 * asked for a string for the same reason: a JSON number is parsed as a
 * double before this code ever sees it, so asking for one throws away the
 * precision before there is anything to preserve.
 *
 * Nothing here is invented. A currency that was not read is '' (it used to
 * default to 'USD', shown, stored in the audit receipt and remembered as the
 * invoice's currency; see invoiceLocalCurrency in
 * lib/payments/stablecoin-lane.ts for how the lane check treats ''), and a
 * recipient that was not read is ''. `confidence` is null on both paths: neither the
 * model's answer nor the regex measures its own accuracy. It used to be a
 * fixed 0.9 for any model answer, even an unparseable one, and 0.55 or 0.2
 * for the regex, shown on the invoice loop as "% confidence".
 */
): Promise<{ amount: string; amountMinor: bigint; currency: string; recipient: string; confidence: number | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model: copilotModel(),
        max_tokens: 300,
        system:
          'Extract the payable amount, ISO-4217 currency, and recipient/vendor name from this invoice. ' +
          'Respond ONLY with compact JSON: {"amount":"0.00","currency":"XXX","recipient":"..."}. The amount is a decimal STRING, digits and one dot only, no separators or symbol. No prose.',
        messages: [{ role: 'user', content: invoiceText.slice(0, 6000) }],
      });
      const text = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
        amount: string | number; currency: string; recipient: string;
      };
      // Only a code is a reading. 'XXX' (ISO 4217's "no currency", and the
      // placeholder in the prompt above), a symbol, "N/A" or "..." is not.
      const answered = String(json.currency ?? '').trim().toUpperCase();
      const currency = /^(USDC|[A-Z]{3})$/.test(answered) && answered !== 'XXX' ? answered : '';
      const named = String(json.recipient ?? '').trim();
      const recipient = named === '...' ? '' : named;
      // A model can still answer with a bare number despite the instruction;
      // normalise, then parse exactly. An unparseable answer is zero rather
      // than a guess, and the zero on screen says so.
      const amount = normaliseAmount(String(json.amount ?? ''));
      rememberInvoiceVendor(orgId, recipient, currency);
      return { ...amount, currency, recipient, confidence: null };
    } catch {
      // fall through to heuristic
    }
  }
  // Heuristic fallback — regex extraction.
  const amountMatch = invoiceText.match(/(?:total|amount due|balance)\D{0,12}([\d,]+\.?\d{0,2})/i) ?? invoiceText.match(/([\d,]+\.\d{2})/);
  // The first local currency named anywhere, as before; USDC only when no
  // local one is named; '' when nothing is. Preferring a local code keeps a
  // PHP document behind a USDC mention (a memo, a record) a PHP reading, which
  // is what the lane check needs. What changed is the case where no code was
  // named: that used to read as an invented 'USD'.
  const named = [...invoiceText.matchAll(/\b(USDC|USD|PHP|MYR|IDR|VND|THB|SGD|EUR|GBP)\b/gi)].map((match) => match[1].toUpperCase());
  const recipientMatch = invoiceText.match(/(?:bill to|vendor|from|pay to)\s*:?\s*([A-Z][\w .,&-]{2,40})/i);
  const amount = normaliseAmount(amountMatch?.[1] ?? '');
  const currency = named.find((code) => code !== 'USDC') ?? (named.includes('USDC') ? 'USDC' : '');
  const recipient = recipientMatch?.[1]?.trim() ?? '';
  rememberInvoiceVendor(orgId, recipient, currency);
  return { ...amount, currency, recipient, confidence: null };
}

// ─── Batch optimizer (group same-corridor rows; real fee math) ──────────────────

export async function optimizeBatch(
  rows: Array<{ amount: number; corridor: string }>,
): Promise<{ suggestedGrouping: number[][]; savingsEstimateUsd: number; byCorridor: Record<string, number> }> {
  const groups: Record<string, number[]> = {};
  const byCorridor: Record<string, number> = {};
  rows.forEach((row, i) => {
    const currency = row.corridor.replace(/^USD[\/→-]?/i, '').toUpperCase().slice(0, 3);
    (groups[currency] ??= []).push(i);
    byCorridor[currency] = (byCorridor[currency] ?? 0) + row.amount;
  });
  // Savings: batching nets one quote per corridor instead of paying spread per
  // row. Approximate the saved spread as ~6 bps per row collapsed into a group.
  const SAVED_BPS_PER_COLLAPSED_ROW = Number(process.env.BATCH_SAVED_BPS_PER_ROW ?? 6);
  let savings = 0;
  for (const [currency, idxs] of Object.entries(groups)) {
    if (idxs.length < 2) continue;
    const feeBps = getCorridorFeeBps(currency);
    const groupTotal = idxs.reduce((s, i) => s + rows[i].amount, 0);
    // collapsing (n-1) rows of spread; scaled by the corridor's fee weight.
    savings += (groupTotal * (SAVED_BPS_PER_COLLAPSED_ROW / 10_000)) * ((idxs.length - 1) / idxs.length) * Math.max(0.5, feeBps / 100);
  }
  return {
    suggestedGrouping: Object.values(groups),
    savingsEstimateUsd: Math.round(savings * 100) / 100,
    byCorridor,
  };
}

// ─── Personalized suggestions from MemWal behavioral memory ─────────────────────

/**
 * How close a recalled memory is to the recall query, 0..1. The MemWal SDK
 * defines semantic similarity as `1.0 - distance` (lower distance is closer)
 * and documents no bound on distance, so the result is clamped. It is the only thing
 * these cards measure, and it measures relevance to the query, not whether
 * the suggestion is right. It used to be floored at 0.6 and 0.55, so a filler
 * memory at distance 0.95 (5% similar) was shown as 60%. null when the
 * relayer gave no usable distance.
 */
export function memoryRelevance(distance: number): number | null {
  if (!Number.isFinite(distance)) return null;
  return Math.min(1, Math.max(0, 1 - distance));
}

/**
 * Below this, a recalled memory is filler, not a pattern: the MemWal SDK's
 * own default `minRelevance` (its AI middleware keeps `1 - distance >= 0.3`).
 * This adapter calls `recall()` without a cutoff, so without one the cards
 * were built from whatever came back.
 */
export const MIN_MEMORY_RELEVANCE = 0.3;

/**
 * The cards a set of recalled memories supports, each at its own measured
 * relevance. A memory that cannot be scored, or scores below the cutoff,
 * makes no card.
 */
export function suggestionsFromMemories(memories: RecalledMemory[]): CopilotSuggestion[] {
  const out: CopilotSuggestion[] = [];
  for (const m of memories) {
    const relevance = memoryRelevance(m.distance);
    if (relevance === null || relevance < MIN_MEMORY_RELEVANCE) continue;
    const text = m.text.toLowerCase();
    const ccy = SUPPORTED.find((c) => text.includes(c.toLowerCase()));
    if (text.includes('batch') || text.includes('payroll')) {
      out.push({
        suggestionId: `cop_${Date.now()}_${out.length}`,
        type: 'batch',
        title: 'Pre-stage your recurring batch',
        // Only what Zeke can do: proposeBatchPayout drafts a batch for approval.
        // It used to promise the cheapest corridor and a pre-open lock, which
        // nothing computes.
        description: `Pattern recalled: “${m.text}”. Want me to draft this batch for your approval?`,
        confidence: relevance,
        requiresAuth: true,
      });
    } else if (ccy) {
      out.push({
        suggestionId: `cop_${Date.now()}_${out.length}`,
        type: 'timing',
        // Zeke can read the rate (getRate); nothing watches it or picks a lock
        // window, which this card used to promise.
        title: `Check USD→${ccy}`,
        description: `Pattern recalled: “${m.text}”. Want me to check the current USD→${ccy} rate?`,
        confidence: relevance,
        requiresAuth: false,
      });
    }
  }
  return out;
}

/**
 * The card shown when memory suggests nothing. It pitches Smart Treasury,
 * which holds customer funds, so it waits for the custody phase like every
 * other treasury surface (lib/server/custody-phase.ts). It also waits for
 * TREASURY_EXECUTION_ENABLED, which /api/treasury requires before it moves
 * anything: "Move some over?" is not an offer to make while that refuses.
 * Otherwise there is no card, and the copilot page says there is nothing to
 * suggest. It is a canned card, so it has no confidence to state: it was
 * shown at an invented 60%.
 */
export function idleCashSuggestion(custodyOn: boolean, executionOn: boolean): CopilotSuggestion | null {
  if (!custodyOn || !executionOn) return null;
  const rate = getTreasuryRate();
  return {
    suggestionId: `cop_${Date.now()}`,
    type: 'treasury',
    title: 'Put idle USDC to work',
    description: `Idle Available cash earns 0%. Smart Treasury (Ondo USDY, T-bill) is ${rate.label}. Move some over?`,
    confidence: null,
    requiresAuth: true,
  };
}

/** What the cards ask memory for. The copilot page never sent its own. */
const SUGGESTION_RECALL_QUERY = 'patterns';

/**
 * Cards for one org, from that org's memory only. `orgId` is the session's:
 * the route used to take a `?user` query string and recall from a namespace
 * every workspace shared, so the cards could quote another tenant's memory.
 */
export async function getCopilotSuggestions(
  orgId: string,
  custodyOn: boolean = custodyPhaseEnabled(),
  // The same reading as app/api/treasury/route.ts.
  treasuryExecutionOn: boolean = process.env.TREASURY_EXECUTION_ENABLED === 'true',
): Promise<CopilotSuggestion[]> {
  let out: CopilotSuggestion[] = [];
  try {
    out = suggestionsFromMemories(await recallForOrg(orgId, SUGGESTION_RECALL_QUERY, 6));
  } catch {
    // memory unavailable — fall back below
  }
  if (out.length === 0) {
    const fallback = idleCashSuggestion(custodyOn, treasuryExecutionOn);
    if (fallback) out.push(fallback);
  }
  return out.slice(0, 5);
}
