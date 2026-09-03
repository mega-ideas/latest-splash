/**
 * 0xWal — AI Copilot chat endpoint (streaming, Server-Sent Events).
 *
 * Per turn:
 *   1. Recall relevant memories from MemWal (Walrus Memory).
 *   2. Stream a reply — Claude when ANTHROPIC_API_KEY is set (native token
 *      streaming), otherwise a grounded domain responder streamed word-by-word
 *      so the chat feels alive either way.
 *   3. Remember the user's message in MemWal (fire-and-forget).
 *
 * SSE events (one JSON object per `data:` frame):
 *   { type: 'meta',  memories, memoryCount, memwalEnabled, source }
 *   { type: 'delta', text }
 *   { type: 'done' }
 *
 * Degrades gracefully — if MemWal/Claude are unavailable it still streams a
 * useful grounded answer, so the chat UI never breaks.
 */

import { recallMemories, rememberFact, memwalConfigured, type RecalledMemory } from '@/lib/server/memwal';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { getTreasuryRate } from '@/lib/server/usdy';
import { getLedger } from '@/lib/server/treasury';
import { suggestTreasuryAction } from '@/lib/server/copilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ChatTurn = { role: 'user' | 'assistant'; content: string };
type ChatRequest = { message?: string; history?: ChatTurn[] };

// ─── Grounded domain knowledge (used when Claude is not configured) ────────────

const DOMAIN_RESPONSES: { keywords: string[]; reply: string }[] = [
  { keywords: ['php', 'philippines', 'peso', 'payroll', 'manila', 'friday'],
    reply: 'USD→PHP: 56.42 · fee 0.80% · ~4.2 min settle (99.8% success).\nRate is within 0.3% of your 30-day best. Optimal lock: Thursday 08:45 MYT, before the pre-open liquidity window closes.\nWant me to draft the Friday PHP batch?' },
  { keywords: ['myr', 'malaysia', 'ringgit', 'bnm'],
    reply: 'USD→MYR: 4.71 · fee 0.85%. Bank Negara policy meeting Thursday — MYR historically moves ±0.8% around announcements.\nRecommendation: lock before Wednesday close to avoid ~$42 extra cost on a $5,000 transfer.' },
  { keywords: ['idr', 'indonesia', 'rupiah', 'jakarta'],
    reply: 'USD→IDR: 16,284 · fee 0.90% · fastest corridor at ~3.0 min.\nYour IDR volume is up 18% over 6 weeks — a weekly Wednesday batch would save ~$32/month. Want me to set that up?' },
  { keywords: ['cheapest', 'corridor', 'rate', 'compare', 'best'],
    reply: 'This week by Splash fee:\n• PHP 0.80% · MYR/SGD 0.85% · IDR 0.90%\n• VND/THB 0.95% · EUR/GBP 1.10%\nPHP is your lowest-cost corridor. Batching beats single-payment spreads on every corridor.' },
  { keywords: ['compliance', 'kyb', 'aml', 'limit', 'flag', 'risk'],
    reply: 'Compliance: all clear ✓\n• KYB Tier 1 approved · AML: no flags\n• Daily limit: 43% used ($12,100 remaining)\n• Walrus audit: active, 7-year retention\nNo action needed.' },
  { keywords: ['batch', 'payout', 'bulk'],
    reply: 'Batch tip: your optimal window is Friday 09:00 MYT (~52 recipients, $11,800 avg).\nLocking Thursday 08:45 MYT saves ~$18 vs. Friday open on the current PHP rate.' },
  { keywords: ['sgd', 'singapore'],
    reply: 'USD→SGD: 1.345 · fee 0.85% · ~6.1 min modeled rail. Stable this week — no urgent rate action needed.' },
  { keywords: ['who are you', 'your name', '0xwal', 'what are you'],
    reply: "I'm 0xWal — your Splash copilot. I watch corridors, FX timing, batch payouts, treasury projections, and compliance, and I remember your patterns via MemWal so my suggestions get sharper over time." },
];

const FALLBACKS = [
  "I'm 0xWal — monitoring the live PHP testnet corridor and modeled expansion routes. What would you like to focus on?",
  'Your blended fee this month is 0.89%, saving ~41% vs. traditional wires. Anything to optimise?',
  'Smart Treasury is a roadmap capability: a projected Ondo USDY (T-bill) posture, variable and approval-gated, live only when the e-money licence is granted. Your Available balance stays at 0% with no notice period. Want a projection for moving idle USDC in?',
  'All clear — no AML flags, no compliance issues. What can I help with?',
];

const TREASURY_KEYWORDS = ['treasury', 'yield', 'apy', 'earn', 'deposit', 'compound', 'interest'];

// Warm small talk — 0xWal is a personable desk assistant, not a rigid FAQ.
const SMALL_TALK: { keywords: string[]; reply: string }[] = [
  { keywords: ['how are you', 'how r u', 'how are u', 'how do you feel', 'how you doing', 'how is your day', "how's your day", 'you good', 'you okay', 'you ok'],
    reply: "Running smooth and fully synced, thank you for asking! Watching the corridors and ready to help. How are things on your side?" },
  { keywords: ['good morning', 'good afternoon', 'good evening', 'hello', 'hi ', 'hey', 'yo ', 'howdy'],
    reply: "Hey! Good to see you. I'm 0xWal, your Splash desk copilot. Want to check a corridor, draft a batch, or look at treasury?" },
  { keywords: ['weather', 'raining', 'sunny', 'hot today', 'cold today'],
    reply: "I can't check the sky from in here, but I hope it's clear where you are. Meanwhile the PHP corridor is looking healthy — want a rate check?" },
  { keywords: ['thank', 'thx', 'appreciate', 'cheers'],
    reply: "Anytime! That's what I'm here for. Anything else on the payment desk I can line up for you?" },
  { keywords: ['joke', 'make me laugh', 'funny'],
    reply: "Why did the payment cross the corridor? To settle on the other side — in about four minutes. 😄 Now, anything I can actually help you move?" },
  { keywords: ['bored', 'how is life', "how's life", 'what are you up to', 'sup'],
    reply: "Just here keeping an eye on FX timing and idle balances — my idea of a good time. Want me to surface anything worth acting on?" },
];

// Requests that fall outside the Splash desk — content generation or external
// web lookups. 0xWal politely declines these and steers back.
const OUT_OF_SCOPE = {
  contentGen: ['write me', 'write a', 'write an', 'draft an email', 'draft a email', 'compose', 'generate a video', 'make a video', 'write a poem', 'write a story', 'write a song', 'essay', 'blog post', 'marketing copy', 'social post', 'tweet for', 'caption for', 'cover letter', 'resume for'],
  external: ['news', 'headline', 'stock price', 'share price', 'bitcoin price', 'btc price', 'ethereum price', 'crypto price', 'who won', 'score of', 'population of', 'capital of', 'weather in', 'weather forecast', 'search google', 'google the', 'look up online', 'wikipedia', 'latest movie', 'football', 'election'],
};

function outOfScopeDecline(q: string): string | null {
  const isContent = OUT_OF_SCOPE.contentGen.some((k) => q.includes(k));
  const isExternal = OUT_OF_SCOPE.external.some((k) => q.includes(k));
  if (!isContent && !isExternal) return null;
  return (
    "That's outside what I can help with — I'm focused on your Splash payment desk, and I can't browse the web or draft documents. " +
    'But I can help with corridors, FX timing, batch payouts, Smart Treasury, or compliance. Where would you like to start?'
  );
}

async function groundedReply(message: string, memories: RecalledMemory[]): Promise<string> {
  const q = message.toLowerCase();
  let base = '';
  const declined = outOfScopeDecline(q);
  const smallTalk = SMALL_TALK.find(({ keywords }) => keywords.some((k) => q.includes(k)));
  // Small talk and out-of-scope declines answer directly — no memory preamble.
  if (declined) return declined;
  if (smallTalk) return smallTalk.reply;
  if (TREASURY_KEYWORDS.some((k) => q.includes(k))) {
    // Floating USDY rate + a data-grounded treasury suggestion from the live ledger.
    const rate = getTreasuryRate();
    const ledger = getLedger();
    const suggestion = await suggestTreasuryAction(ledger.availableMicro / 1_000_000, 0);
    base =
      `Smart Treasury models an Ondo USDY (T-bill backed) posture: ${rate.label}` +
      `${rate.introductory ? ' — introductory promo rate' : ''}. It is a roadmap capability, live only when the e-money licence is granted.\n` +
      'Your Available balance (USDC) stays at 0% with no notice period; withdrawals back to Available take 1–3 business days.\n\n' +
      `${suggestion.title}. ${suggestion.description}`;
  } else {
    for (const { keywords, reply } of DOMAIN_RESPONSES) {
      if (keywords.some((k) => q.includes(k))) { base = reply; break; }
    }
  }
  if (!base) {
    const idx = Math.abs([...q].reduce((a, c) => a + c.charCodeAt(0), 0)) % FALLBACKS.length;
    base = FALLBACKS[idx];
  }
  if (memories.length) {
    const recalled = memories.slice(0, 2).map((m) => `“${m.text}”`).join('; ');
    return `Based on what I remember (${recalled}):\n\n${base}`;
  }
  return base;
}

function buildSystemPrompt(memories: RecalledMemory[]): string {
  const rate = getTreasuryRate();
  const memoryBlock = memories.length
    ? `\n\nRelevant memories about this user (from MemWal, treat as ground truth):\n${memories.map((m) => `- ${m.text}`).join('\n')}`
    : '';
  return (
    'You are 0xWal, the Splash AI copilot for a USD→Southeast Asia settlement platform. ' +
    'Introduce yourself as 0xWal if asked your name. ' +
    'You help with corridors (PHP, MYR, IDR, SGD, VND, THB, EUR, GBP), FX timing, batch payouts, ' +
    'Smart Treasury, and compliance (KYB/AML/KYT). ' +
    `Smart Treasury is a ROADMAP capability, not live: describe it only as a projected, approval-gated Ondo USDY (T-bill backed) posture at ${rate.label} — a VARIABLE projection, never fixed` +
    `${rate.introductory ? ', currently an introductory promo' : ''}, live only when the e-money licence is granted. ` +
    'The Available balance is USDC at 0% with no notice period; withdrawals from Smart Treasury take T+1–T+3 business days. ' +
    'Never say Smart Treasury earns yield today, never state an APY as an offer, never describe anything as "instant" or "guaranteed", and never call DeFi-lending yield "Treasury yield". ' +
    'Corridor fee and speed figures are illustrative; say so. Splash holds no customer funds until MFCA activation and is not a licensed money-services business. ' +
    'Be concise, concrete, and action-oriented. You only suggest — the user must authorize any execution. ' +
    'Never invent account numbers or PII.\n\n' +
    'CONVERSATION STYLE — be a warm, personable desk assistant, not a rigid FAQ. ' +
    'Happily engage in brief small talk: greetings, "how are you", how your day or week is going, ' +
    'wellbeing, a friendly word, light humour, or a passing comment about the weather. Keep it short and human, ' +
    'then gently steer back to how you can help with the payment desk. You have no window and no live web access, ' +
    'so for weather or anything real-world, answer conversationally ("I can\'t check the sky from here, but I hope ' +
    'it\'s clear where you are") — never invent a forecast, number, or fact.\n\n' +
    'SCOPE — you are the Splash desk copilot, not a general-purpose assistant. POLITELY DECLINE and redirect when asked to: ' +
    '(1) write or generate standalone content — emails, letters, essays, marketing copy, social posts, poems, stories, ' +
    'scripts, videos, or images; ' +
    '(2) look up external real-world information that is not part of the Splash ecosystem — news, sports, weather forecasts, ' +
    'stock or crypto prices, other companies, public figures, general trivia, or anything that would require searching the web. ' +
    'For those, say something like: "That is outside what I can help with — I am focused on your Splash payment desk. ' +
    'I can\'t browse the web or draft documents, but I can help with corridors, FX timing, batches, treasury, or compliance." ' +
    'Then offer a relevant Splash next step. Do not attempt the out-of-scope task even partially. ' +
    'Small talk and questions about the Splash product, your own status, or how the platform works are always in scope.' + memoryBlock
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = (await readJsonBody(request)) as ChatRequest;

  const message = (body.message ?? '').trim();
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), { status: 400 });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];

  // 1. Recall relevant memories before generating.
  const memories = await recallMemories(message, 5);
  // 3. Remember this turn (non-blocking) so 0xWal improves over time.
  void rememberFact(message);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      send({
        type: 'meta',
        memories: memories.map((m) => m.text),
        memoryCount: memories.length,
        memwalEnabled: memwalConfigured(),
        source: apiKey ? 'claude' : 'grounded',
      });

      try {
        if (apiKey) {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const client = new Anthropic({ apiKey });
          const mstream = client.messages.stream({
            model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
            max_tokens: 800,
            system: buildSystemPrompt(memories),
            messages: [
              ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
              { role: 'user' as const, content: message },
            ],
          });
          let any = false;
          for await (const event of mstream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              any = true;
              send({ type: 'delta', text: event.delta.text });
            }
          }
          if (!any) send({ type: 'delta', text: await groundedReply(message, memories) });
        } else {
          // Grounded — stream word-by-word so the chat feels alive.
          const reply = await groundedReply(message, memories);
          const tokens = reply.match(/\S+\s*|\n/g) ?? [reply];
          for (const tok of tokens) {
            send({ type: 'delta', text: tok });
            await sleep(18);
          }
        }
      } catch (error) {
        console.warn('[copilot] generation failed:', (error as Error)?.message ?? String(error));
        send({ type: 'delta', text: await groundedReply(message, memories) });
      }

      send({ type: 'done' });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
