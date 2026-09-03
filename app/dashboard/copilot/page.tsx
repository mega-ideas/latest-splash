'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock,
  Globe,
  Layers,
  Lock,
  RefreshCw,
  Send,
  Sparkles,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '../../../lib/utils';
import { streamCopilot } from '@/lib/copilot-client';

// ─── Types ────────────────────────────────────────────────────────────────────

type MessageRole = 'assistant' | 'user';
type Message     = { id: number; role: MessageRole; text: string; time: string };

// ─── Seed conversation ────────────────────────────────────────────────────────

const INITIAL_MESSAGES: Message[] = [
  {
    id: 1,
    role: 'assistant',
    text: "Hi! I'm 0xWal, your Splash copilot — powered by Claude and grounded in your MemWal behavioral memory.\n\nI've analysed your last 8 weeks of payment activity. You have a Friday morning PHP payroll batch pattern that I can pre-stage for you — current PHP rate (56.42) is within 0.3% of your 30-day best. Splash fee: 0.80%.\n\nWant me to draft the Friday batch?",
    time: '09:01',
  },
  {
    id: 2,
    role: 'user',
    text: "Yes, draft the Friday batch. Also what's the best time to lock the MYR rate this week?",
    time: '09:03',
  },
  {
    id: 3,
    role: 'assistant',
    text: "**Friday PHP Batch — drafted**\n• 52 recipients · $12,400 USD → PHP 699,608\n• Splash fee: 0.80% ($99.20)\n• Suggested lock: Thursday 08:45 MYT\n• Rate: 56.42 · within 0.3% of 30d best (56.59)\n\n**MYR rate this week:**\nMYR at 4.71, approaching its 30-day high of 4.73. Splash fee: 0.85%. BNM policy meeting Thursday — I recommend locking before Wednesday close to avoid rate volatility.\n\nShall I pre-stage the MYR batch too?",
    time: '09:03',
  },
];

// ─── Contextual AI responses ──────────────────────────────────────────────────

const CONTEXT_RESPONSES: { keywords: string[]; reply: string }[] = [
  {
    keywords: ['php', 'philippines', 'payroll', 'manila', 'peso', 'friday batch'],
    reply: [
      '**USD→PHP Corridor Status**',
      '• Current rate: 56.42 — within 0.3% of 30-day best (56.59)',
      '• Splash fee: 0.80% — your lowest-cost corridor',
      '• Settlement: avg 4.2 minutes · 30d success rate: 99.8%',
      '',
      'Based on your MemWal patterns, you run a Friday 09:00 MYT payroll batch — 52 recipients, average $12,400. This week\'s rate is favourable.',
      '',
      'Optimal lock window: **Thursday 08:45 MYT** — pre-open liquidity is deepest, tightest FX spread.',
      '',
      'Shall I draft the Friday PHP batch now?',
    ].join('\n'),
  },
  {
    keywords: ['myr', 'malaysia', 'ringgit', 'bnm', 'kuala lumpur'],
    reply: [
      '**USD→MYR Rate Alert**',
      '• Current rate: 4.71 — approaching 30-day high of 4.73',
      '• Splash fee: 0.85% · Settlement: ~5.1 minutes',
      '',
      '⚠ Bank Negara (BNM) policy meeting this Thursday — MYR historically moves ±0.8% around BNM announcements.',
      '',
      'Recommendation: lock your MYR transfer before **Wednesday close**. Waiting until Thursday risks an extra ~$42 cost on a $5,000 transfer.',
      '',
      'Want me to pre-stage a MYR transfer now?',
    ].join('\n'),
  },
  {
    keywords: ['idr', 'indonesia', 'rupiah', 'jakarta'],
    reply: [
      '**USD→IDR Performance**',
      '• Current rate: 16,284 · Splash fee: 0.90%',
      '• Settlement: avg 3.0 minutes — fastest in your portfolio',
      '• 30-day success rate: 99.5%',
      '',
      'Your IDR volume is up 18% over 6 weeks. Current pattern is ad-hoc — consolidating into a weekly Wednesday batch would save ~$32/month in spread costs based on your avg $8,500 batch size.',
      '',
      'Want me to set up a recurring IDR batch template?',
    ].join('\n'),
  },
  {
    keywords: ['treasury', 'yield', 'apy', 'deposit', 'compound', 'earn', 'interest'],
    reply: [
      '**Smart Treasury — Ondo USDY**',
      '• Instrument: Ondo USDY — T-bill backed, variable rate (not fixed)',
      '• Available balance (USD): 0% but instant — operating cash',
      '• Smart Treasury: earns the floating USDY net rate',
      '• Withdrawals Smart Treasury → Available: 1–3 business days (USDY→USD conversion)',
      '',
      'Available cash is modeled at 0%. Smart Treasury can model a variable T-bill-backed return pending approval.',
      '',
      'Want me to prepare a move into Smart Treasury?',
    ].join('\n'),
  },
  {
    keywords: ['compliance', 'kyb', 'aml', 'flag', 'limit', 'risk', 'regulatory'],
    reply: [
      '**Compliance Snapshot — Your Account**',
      '• KYB status: ✓ Approved (Tier 1)',
      '• AML flags: None on modeled sandbox routes',
      '• Daily limit utilisation: 43% ($12,100 remaining today)',
      '• Transaction monitoring: All clear',
      '• Jurisdictions active: PH, MY, ID, SG, VN, TH, NL, UK',
      '',
      'No action required. Account in good standing across all active corridors.',
      '',
      'Tier 2 KYB upgrade adds $25,000/day extra capacity — want to start that process?',
    ].join('\n'),
  },
  {
    keywords: ['batch', 'payout', 'bulk', 'multiple recipients'],
    reply: [
      '**Batch Payout Optimisation**',
      '• Your avg batch: 52 recipients · $11,800 per run',
      '• Most efficient size: $10,000–$15,000 (lowest per-recipient cost)',
      '• Best day: Friday · Best time: 09:00 MYT pre-open liquidity',
      '',
      'For your next PHP batch, the current rate 56.42 is within 0.3% of the 30-day best. Locking Thursday 08:45 MYT projects a ~$18 saving vs. waiting until Friday open.',
      '',
      'Ready to draft the batch now?',
    ].join('\n'),
  },
  {
    keywords: ['cheapest', 'corridor', 'compare', 'rates', 'modeled routes', 'best rate'],
    reply: [
      '**This Week — Live and Modeled Routes by Splash Fee**',
      '• USD→PHP: 0.80% · 56.42 · 4.2m settle · 99.8% success',
      '• USD→MYR: 0.85% · 4.71  · 5.1m settle · 98.9% success',
      '• USD→SGD: 0.85% · 1.345 · 6.1m settle · 99.1% success',
      '• USD→IDR: 0.90% · 16,284 · 3.0m settle · 99.5% success',
      '• USD→VND: 0.95% · 25,385 · 4.8m settle · 98.2% success',
      '• USD→THB: 0.95% · 35.82 · 5.5m settle · 97.8% success',
      '• USD→EUR: 1.10% · 0.924 · 6.4m settle · 97.6% success',
      '• USD→GBP: 1.10% · 0.789 · 7.2m settle · 97.1% success',
      '',
      'PHP remains your most cost-efficient corridor. For EUR/GBP, consolidating into weekly batches can reduce effective fee to ~0.95%.',
    ].join('\n'),
  },
  {
    keywords: ['saving', 'save', 'cost analysis', 'last month', 'fee breakdown'],
    reply: [
      '**Your Last 30-Day Savings Summary**',
      '• Modeled transfer volume: $9.4M across sandbox routes',
      '• Splash fees paid: $83,600 (blended 0.89%)',
      '• Estimated via traditional wire: $141,000 (avg 1.5%)',
      '• Net savings vs. traditional bank: **$57,400 this month**',
      '',
      'Largest driver: PHP payroll batching saves ~$1,200 per batch vs. individual wires. Second: IDR consolidation saves ~$320/month.',
      '',
      'Adding EUR and GBP to weekly batch cycles projects an extra **$480/month** saving. Want me to draft that schedule?',
    ].join('\n'),
  },
  {
    keywords: ['sgd', 'singapore', 'sing dollar'],
    reply: [
      '**USD→SGD Corridor**',
      '• Current rate: 1.345 · Splash fee: 0.85% · Settlement: 6.1 minutes',
      '• 30-day modeled success rate: 99.1%',
      '',
      'SGD is stable — typically moves ±0.2% per week vs USD. Your SGD volume is $400K/month, well within your Tier 1 limits.',
      '',
      'No urgent rate action needed. If you have a vendor payment due this week, the current rate is reasonable. Want to initiate a SGD transfer?',
    ].join('\n'),
  },
  {
    keywords: ['eur', 'euro', 'europe', 'amsterdam', 'netherlands'],
    reply: [
      '**USD→EUR Corridor**',
      '• Current rate: 0.924 · Splash fee: 1.10% · Settlement: 6.4 minutes',
      '• Your EUR volume: $300K/month — up 34% this month',
      '',
      'EUR is trading near a 3-week high vs USD. Non-urgent payments could benefit from waiting 2–3 days.',
      '',
      'Opportunity: consolidating your EUR invoices into a weekly batch could save ~$48/month in FX spread. Want me to create a weekly EUR batch template?',
    ].join('\n'),
  },
  {
    keywords: ['gbp', 'british', 'pound', 'london', 'uk'],
    reply: [
      '**USD→GBP Corridor**',
      '• Current rate: 0.789 · Splash fee: 1.10% · Settlement: 7.2 minutes',
      '• 30-day success rate: 97.1%',
      '',
      'GBP has the highest effective cost in your corridor mix. Your London Fintech Partners invoice ($6,400) is currently in Draft status — consider uploading the PDF to Walrus for compliance record-keeping.',
      '',
      'Want me to help with that transfer?',
    ].join('\n'),
  },
  {
    keywords: ['transfer', 'send money', 'quick transfer', 'how much', 'today'],
    reply: [
      '**Quick Transfer — Today\'s Capacity**',
      '• Daily limit remaining: $12,100 (43% utilised)',
      '• PHP payout path: live-model · seven additional corridors implemented in code',
      '• Recommended live-model path: PHP 56.42',
      '',
      'No AML flags today. Your last transfer was $8,500 to Jakarta Textile Exports (USD→IDR, settled in 2.8 minutes).',
      '',
      'Which corridor and amount do you need? Or head directly to the Transfer screen.',
    ].join('\n'),
  },
];

const FALLBACK_REPLIES: string[] = [
  [
    '**Account Health — All Clear**',
    '• Modeled blended fee this month: 0.89%',
    '• vs. industry average of 1.5% — you\'re saving 41% on fees',
    '• PHP live-model path healthy · seven additional corridors implemented in code',
    '',
    'Your MemWal patterns show consistent Friday PHP batches and growing IDR volume. I\'m monitoring the live PHP testnet corridor plus modeled expansion routes and will surface opportunities proactively.',
    '',
    'Anything specific you\'d like me to check or optimise?',
  ].join('\n'),
  [
    '**Smart Treasury — Ondo USDY**',
    '• T-bill backed yield via Ondo USDY — variable, never fixed',
    '• Available balance (USD): 0%, instant',
    '• Withdrawals from Smart Treasury: 1–3 business days',
    '',
    'I can prepare a Smart Treasury projection, or keep Available USD ready for instant payments.',
    '',
    'Want me to prepare a projection for approval?',
  ].join('\n'),
  [
    '**Rate Monitoring — This Week**',
    '• PHP: 56.42 (favourable — within 0.3% of 30d best)',
    '• MYR: 4.71 (approaching 30d high — BNM meeting Thursday)',
    '• IDR: 16,284 (stable)',
    '• All others: within normal ranges',
    '',
    'I\'m tracking your typical Thursday/Friday transfer windows. No unusual volatility across any corridor today.',
    '',
    'Want me to set a rate alert for any specific corridor?',
  ].join('\n'),
  [
    '**Compliance Status — Clear**',
    '• KYB Tier 1: ✓ Approved',
    '• AML flags: None',
    '• Daily utilisation: 43% ($12,100 remaining today)',
    '• 7-year invoice archive: 7 of 8 invoices Walrus-stored',
    '',
    'Everything looks clean. Your London Fintech invoice (INV-2026-034) is still in Draft — consider uploading the PDF for your compliance record.',
    '',
    'What would you like to do next?',
  ].join('\n'),
];

// ─── Context matching ─────────────────────────────────────────────────────────

function matchResponse(input: string, fallbackIdxRef: React.MutableRefObject<number>): string {
  const q = String(input ?? '').toLowerCase();
  for (const { keywords, reply } of CONTEXT_RESPONSES) {
    if (keywords.some((k) => q.includes(k))) return reply;
  }
  const idx = fallbackIdxRef.current % FALLBACK_REPLIES.length;
  fallbackIdxRef.current++;
  return FALLBACK_REPLIES[idx];
}

// ─── Text formatter ───────────────────────────────────────────────────────────

function formatText(text: string) {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('**') && line.endsWith('**') && line.length > 4) {
      return <p key={i} className="font-semibold text-[#1F4452]">{line.slice(2, -2)}</p>;
    }
    if (line.startsWith('• ') || line.startsWith('⚠ ')) {
      return <p key={i} className="pl-1">{line}</p>;
    }
    if (line === '') return <div key={i} className="h-1" />;
    return <p key={i}>{line}</p>;
  });
}

// ─── Suggestion cards ─────────────────────────────────────────────────────────

type SuggestionCard = {
  id: string;
  title: string;
  body: string;
  corridor: string;
  action: string;
  href: string;
  confidence: number;
  urgency: 'high' | 'medium' | 'low';
};

const INITIAL_SUGGESTIONS: SuggestionCard[] = [
  {
    id: 'sug_001',
    title: 'Friday PHP payroll batch ready',
    body: 'Rate 56.42 within 0.3% of 30d best. 52 recipients ready. Fee: 0.80%. Lock window: Thursday 08:45 MYT.',
    corridor: 'USD→PHP', action: 'Pre-stage batch', href: '/dashboard/batch',
    confidence: 94, urgency: 'high',
  },
  {
    id: 'sug_002',
    title: 'MYR lock before BNM meeting',
    body: 'Bank Negara policy Thursday may move MYR. Current 4.71 near 30d high. Fee: 0.85%. Consider early lock.',
    corridor: 'USD→MYR', action: 'New transfer', href: '/dashboard/transfer',
    confidence: 78, urgency: 'medium',
  },
  {
    id: 'sug_003',
    title: 'EUR weekly batch opportunity',
    body: 'EUR volume up 34% this month. Consolidating into a weekly EUR batch saves ~$48/month in spread. Fee: 1.10%.',
    corridor: 'USD→EUR', action: 'Create batch', href: '/dashboard/batch',
    confidence: 71, urgency: 'low',
  },
];

type ApiSuggestion = { suggestionId: string; type: string; title: string; description: string; confidence: number; suggestedAction?: string };

function mapSuggestion(s: ApiSuggestion): SuggestionCard {
  const conf = Math.round((s.confidence ?? 0.6) * 100);
  const urgency: SuggestionCard['urgency'] = conf >= 80 ? 'high' : conf >= 65 ? 'medium' : 'low';
  const batchCurrency = s.suggestedAction?.startsWith('batch:') ? s.suggestedAction.split(':')[1] : null;
  const href = s.type === 'treasury' ? '/dashboard/treasury' : s.type === 'batch' ? `/dashboard/batch${batchCurrency ? `?corridor=${batchCurrency}` : ''}` : s.type === 'invoice' ? '/dashboard/invoices' : '/dashboard';
  const action = s.type === 'treasury' ? 'Open Treasury' : s.type === 'batch' ? 'Draft batch' : s.type === 'invoice' ? 'Open invoices' : 'View';
  const corridor = s.type === 'timing' ? 'FX timing' : s.type.charAt(0).toUpperCase() + s.type.slice(1);
  return { id: s.suggestionId, title: s.title, body: s.description, corridor, action, href, confidence: conf, urgency };
}

const URGENCY_STYLES: Record<SuggestionCard['urgency'], string> = {
  high:   'border-[#E39774]/30 border-l-[#E39774] bg-orange-50',
  medium: 'border-[#5C9EAD]/25 border-l-[#5C9EAD] bg-[#F6F0ED]',
  low:    'border-[#326273]/12 border-l-[#326273]/35 bg-white',
};
const URGENCY_DOT: Record<SuggestionCard['urgency'], string> = {
  high:   'bg-[#E39774]',
  medium: 'bg-[#5C9EAD]',
  low:    'bg-[#326273]/35',
};

// ─── Memory patterns ──────────────────────────────────────────────────────────

const MEMORY_PATTERNS = [
  { label: 'Top corridor',      value: 'USD→PHP 62%',         sub: '8-week average',        icon: Globe,      bar: 62 },
  { label: 'Batch habit',       value: 'Friday 09:00 MYT',    sub: '7 of last 8 Fridays',   icon: Clock,      bar: 87 },
  { label: 'Avg batch size',    value: '$11,800',              sub: 'Per payout batch',      icon: Layers,     bar: 0  },
  { label: 'Rate sensitivity',  value: '±0.5% of 30d avg',    sub: 'Acts within this band', icon: TrendingUp, bar: 0  },
  { label: 'Optimal window',    value: '08:45–09:30 MYT',      sub: 'Pre-open liquidity',    icon: Zap,        bar: 0  },
  { label: 'Corridors active',  value: '5 corridors',          sub: 'PHP IDR MYR EUR SGD',  icon: Globe,      bar: 0  },
];

const PROMPT_CHIPS = [
  'What corridors are cheapest this week?',
  'Draft my Friday PHP batch',
  'When should I lock MYR rate?',
  "Show last month's cost savings",
  'Compliance flags on my account?',
  'Recommend a treasury deposit',
];

function formatChatTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CopilotPage() {
  const [messages,     setMessages]     = useState<Message[]>(INITIAL_MESSAGES);
  const [input,        setInput]        = useState('');
  const [thinking,     setThinking]     = useState(false);
  const [streaming,    setStreaming]     = useState(false);
  const [dismissed,    setDismissed]    = useState<string[]>([]);
  const [memoryOn,     setMemoryOn]     = useState(true);
  const [notifyOn,     setNotifyOn]     = useState(true);
  const [retention,    setRetention]    = useState('8 weeks');
  const [syncing,      setSyncing]      = useState(false);
  const [memStatus,    setMemStatus]    = useState<string | null>(null);
  const [suggestions,  setSuggestions]  = useState<SuggestionCard[]>(INITIAL_SUGGESTIONS);

  const scrollRef        = useRef<HTMLDivElement>(null);
  const inputRef         = useRef<HTMLInputElement>(null);
  const msgIdRef         = useRef(3); // INITIAL_MESSAGES have ids 1-3
  const fallbackIdxRef   = useRef(0);
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-scroll on new message or thinking state
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom || thinking) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, thinking]);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (streamIntervalRef.current) clearInterval(streamIntervalRef.current);
    };
  }, []);

  // Real personalized suggestions (MemWal-grounded) for the swipe carousel.
  useEffect(() => {
    let active = true;
    fetch('/api/copilot/suggest')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || !d?.suggestions?.length) return;
        setSuggestions((d.suggestions as ApiSuggestion[]).map(mapSuggestion));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // ── send ───────────────────────────────────────────────────────────────────

  function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking || streaming) return;

    const now = formatChatTime();
    const userMsgId = ++msgIdRef.current;

    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: trimmed, time: now }]);
    setInput('');
    setThinking(true);

    const history = messages.map((m) => ({ role: m.role, content: m.text }));

    void (async () => {
      const assistantMsgId = ++msgIdRef.current;
      let started = false;
      const startAssistant = () => {
        if (started) return;
        started = true;
        setThinking(false);
        setStreaming(true);
        setMessages((prev) => [
          ...prev,
          { id: assistantMsgId, role: 'assistant', text: '', time: formatChatTime() },
        ]);
      };

      // Real streaming: MemWal recall + (Claude or grounded) reply via SSE.
      const ok = await streamCopilot(trimmed, history, {
        onMeta: (meta) =>
          setMemStatus(
            !meta.memwalEnabled
              ? null
              : meta.memoryCount > 0
              ? `MemWal · ${meta.memoryCount} ${meta.memoryCount === 1 ? 'memory' : 'memories'} recalled`
              : 'MemWal · synced',
          ),
        onDelta: (t) => {
          startAssistant();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, text: m.text + t } : m)),
          );
        },
        onDone: () => setStreaming(false),
      });

      if (ok) {
        setStreaming(false);
        return;
      }

      // Local fallback (network/route unavailable) — char-stream a canned reply.
      const reply = matchResponse(trimmed, fallbackIdxRef);
      startAssistant();
      let charIdx = 0;
      streamIntervalRef.current = setInterval(() => {
        charIdx += 4;
        if (charIdx >= reply.length) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, text: reply } : m)),
          );
          if (streamIntervalRef.current) clearInterval(streamIntervalRef.current);
          streamIntervalRef.current = null;
          setStreaming(false);
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, text: reply.slice(0, charIdx) } : m,
            ),
          );
        }
      }, 18);
    })();
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleSync() {
    setSyncing(true);
    setTimeout(() => setSyncing(false), 1800);
  }

  const visibleSuggestions = suggestions.filter((s) => !dismissed.includes(s.id));
  const busy = thinking || streaming;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-6xl space-y-6">

      {/* Header */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="dash-kicker">AI copilot · MemWal</span>
          <h1 className="dash-title mt-2">0xWal</h1>
          <p className="mt-0.5 text-[13px] text-[#326273]/50">
            Powered by Claude · grounded in your behavioral memory via MemWal
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-[#326273]/10 bg-white px-3 py-2 text-[13px] text-[#326273]/50">
          <Lock size={12} className="text-[var(--info)]" />
          <span>Behavioral patterns only · no financial records stored</span>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">

        {/* ── Left: chat area ────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">

          {/* Active suggestions */}
          {visibleSuggestions.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[#326273]/40">
                  {visibleSuggestions.length} active recommendation{visibleSuggestions.length !== 1 ? 's' : ''}
                </p>
                {visibleSuggestions.length > 1 && (
                  <span className="text-[13px] font-medium text-[#326273]/35">swipe to browse →</span>
                )}
              </div>
              <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
                {visibleSuggestions.map((s) => (
                <div
                  key={s.id}
                  className={cn('w-[88%] shrink-0 snap-center rounded-xl border border-l-4 p-3.5 shadow-sm sm:w-[400px]', URGENCY_STYLES[s.urgency])}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', URGENCY_DOT[s.urgency])} />
                      <div>
                        <div className="text-[13px] font-semibold text-[#1F4452]">{s.title}</div>
                        <div className="mt-0.5 text-[13px] text-[#326273]/60">{s.body}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDismissed((prev) => [...prev, s.id])}
                      className="mt-0.5 shrink-0 text-[#326273]/25 transition-colors hover:text-[#326273]"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-20 overflow-hidden rounded-full bg-[#326273]/10">
                        <div className="h-full rounded-full bg-[#E39774]" style={{ width: `${s.confidence}%` }} />
                      </div>
                      <span className="text-[13px] font-medium text-[#326273]/45">{s.confidence}% confidence</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-[#326273]/8 px-1.5 py-0.5 text-[13px] font-medium text-[#326273]/55">
                        {s.corridor}
                      </span>
                      <Link
                        href={s.href}
                        className="flex items-center gap-1 rounded-lg bg-[#326273] px-2.5 py-1 text-[13px] font-semibold text-white transition-colors hover:bg-[#264e5b]"
                      >
                        {s.action} <ArrowRight size={10} />
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
              </div>
            </div>
          )}

          {/* Chat panel */}
          <div className="dash-surface flex flex-col overflow-hidden" style={{ minHeight: 500 }}>

            {/* Chat header */}
            <div className="flex items-center justify-between border-b border-[#0c3e48]/15 bg-gradient-to-r from-[#0c3e48] to-[#0d6370] px-4 py-3 text-white">
              <div className="flex items-center gap-2.5">
                <div className="rounded-lg bg-[#efc46f]/25 p-1.5 ring-1 ring-[#efc46f]/40">
                  <Bot size={15} className="text-[#efc46f]" />
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-white">0xWal</div>
                  <div className="flex items-center gap-1.5 text-[13px] text-white/55">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                    {streaming ? 'Typing…' : thinking ? 'Recalling memory…' : (memStatus ?? 'Active · MemWal synced')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-[13px] text-white/45">
                <Sparkles size={11} /> Claude · MemWal v2
              </div>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 space-y-4 overflow-y-auto bg-[#F6F0ED]/50 p-4"
              style={{ scrollbarWidth: 'none' }}
            >
              {messages.map((msg, i) => {
                const isLastAssistant = msg.role === 'assistant' && i === messages.length - 1;
                const isStreamingThis = isLastAssistant && streaming;

                return (
                  <div key={msg.id} className={cn('flex gap-3', msg.role === 'user' ? 'flex-row-reverse' : '')}>
                    {msg.role === 'assistant' && (
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E39774]/15">
                        <Bot size={14} className="text-[#C97A56]" />
                      </div>
                    )}
                    <div
                      className={cn(
                        'max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-5',
                        msg.role === 'assistant'
                          ? 'border border-[#0c3e48]/8 bg-white text-[#1F4452] shadow-sm'
                          : 'bg-gradient-to-br from-[#0c3e48] to-[#0d6370] text-white shadow-sm'
                      )}
                    >
                      {msg.role === 'assistant' ? (
                        isStreamingThis ? (
                          <div className="whitespace-pre-wrap text-[13px] leading-5 text-[#1F4452]">
                            {msg.text}
                            <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-[#326273]/50" />
                          </div>
                        ) : (
                          formatText(msg.text)
                        )
                      ) : (
                        <p>{msg.text}</p>
                      )}
                      <div className={cn('mt-1 text-[13px]', msg.role === 'assistant' ? 'text-[#326273]/35' : 'text-white/40')}>
                        {msg.time}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Typing dots */}
              {thinking && (
                <div className="flex gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E39774]/15">
                    <Bot size={14} className="text-[#C97A56]" />
                  </div>
                  <div className="flex items-center gap-1.5 rounded-2xl border border-[#326273]/8 bg-white px-4 py-3 shadow-sm">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#326273]/40 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#326273]/40 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#326273]/40 [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </div>

            {/* Prompt chips */}
            <div className="border-t border-[#326273]/8 px-4 py-2">
              <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
                {PROMPT_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={busy}
                    onClick={() => sendMessage(chip)}
                    className="shrink-0 rounded-full border border-[#326273]/10 bg-[#F6F0ED] px-2.5 py-1 text-[13px] font-medium text-[#326273]/70 transition-colors hover:border-[#5C9EAD]/40 hover:text-[#326273] disabled:opacity-40"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>

            {/* Input */}
            <div className="border-t border-[#326273]/8 p-3">
              <form
                onSubmit={handleFormSubmit}
                className="flex items-center gap-2 rounded-xl border border-[#326273]/12 bg-white px-3 py-2 transition-all focus-within:border-[#5C9EAD] focus-within:ring-2 focus-within:ring-[#5C9EAD]/15"
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask about corridors, rates, compliance, treasury…"
                  disabled={busy}
                  className="flex-1 bg-transparent text-sm text-[#1F4452] placeholder-[#326273]/35 outline-none disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || busy}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#326273] text-white transition-colors hover:bg-[#264e5b] disabled:opacity-40"
                >
                  <Send size={14} />
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* ── Right sidebar ──────────────────────────────────────────────── */}
        <aside className="space-y-4">

          {/* MemWal memory */}
          <div className="dash-block p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain size={15} className="text-[var(--info)]" />
                <h2 className="text-sm font-semibold text-[#1F4452]">MemWal Memory</h2>
              </div>
              <button
                type="button"
                onClick={handleSync}
                disabled={syncing}
                className="flex items-center gap-1 text-[13px] font-medium text-[var(--info)] transition-opacity hover:text-[#326273] disabled:opacity-60"
              >
                <RefreshCw size={10} className={syncing ? 'animate-spin' : ''} />
                {syncing ? 'Syncing…' : 'Sync'}
              </button>
            </div>
            <p className="mt-1 text-[13px] text-[#326273]/50">
              {syncing ? 'Syncing behavioral patterns from Walrus…' : 'Behavioral patterns from your last 8 weeks'}
            </p>
            <div className="mt-3 space-y-3">
              {MEMORY_PATTERNS.map(({ label, value, sub, icon: Icon, bar }) => (
                <div key={label}>
                  <div className="flex items-start gap-2">
                    <Icon size={12} className="mt-0.5 shrink-0 text-[var(--info)]" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[13px] text-[#326273]/50">{label}</span>
                        <span className="text-[13px] font-semibold text-[#1F4452]">{value}</span>
                      </div>
                      {bar > 0 && (
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-[#F6F0ED]">
                          <div className="h-full rounded-full bg-[#5C9EAD]" style={{ width: `${bar}%` }} />
                        </div>
                      )}
                      <div className="text-[13px] text-[#326273]/35">{sub}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Settings */}
          <div className="dash-block p-4">
            <h2 className="text-sm font-semibold text-[#1F4452]">Copilot Settings</h2>
            <div className="mt-3 space-y-3">
              {[
                { label: 'Behavioral memory',       sub: 'MemWal pattern learning',    state: memoryOn,  toggle: () => setMemoryOn((v) => !v)  },
                { label: 'Rate alert suggestions',  sub: 'Notify on optimal windows',  state: notifyOn,  toggle: () => setNotifyOn((v) => !v)  },
              ].map(({ label, sub, state, toggle }) => (
                <div key={label} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[#1F4452]">{label}</div>
                    <div className="text-[13px] text-[#326273]/45">{sub}</div>
                  </div>
                  <button
                    type="button"
                    onClick={toggle}
                    className={cn(
                      'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                      state ? 'bg-[#5C9EAD]' : 'bg-[#326273]/20'
                    )}
                    aria-pressed={state}
                    aria-label={label}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200',
                        state ? 'left-[18px]' : 'left-0.5'
                      )}
                    />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-lg border border-[#326273]/8 px-3 py-2.5">
              <div className="text-[13px] font-medium text-[#326273]">Memory retention</div>
              <div className="mt-1.5 flex gap-1.5">
                {(['4 weeks', '8 weeks', '12 weeks'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setRetention(w)}
                    className={cn(
                      'flex-1 rounded-md py-1 text-[13px] font-semibold transition-colors',
                      retention === w
                        ? 'bg-[#326273] text-white'
                        : 'bg-[#F6F0ED] text-[#326273]/60 hover:bg-[#326273]/10'
                    )}
                  >
                    {w}
                  </button>
                ))}
              </div>
              {retention !== '8 weeks' && (
                <p className="mt-1.5 text-[13px] text-[#326273]/45">
                  Retention updated to {retention}. Patterns older than this window will be pruned at next sync.
                </p>
              )}
            </div>
          </div>

          {/* What MemWal stores */}
          <div className="dash-block p-4">
            <div className="flex items-center gap-2">
              <Lock size={14} className="text-[var(--info)]" />
              <h2 className="text-sm font-semibold text-[#1F4452]">What MemWal Stores</h2>
            </div>
            <div className="mt-3 space-y-2">
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">✓ Stored (behavioral)</div>
                {['Corridor frequency & timing', 'Batch size patterns', 'Rate sensitivity bands', 'Optimal transfer windows'].map((item) => (
                  <div key={item} className="flex items-center gap-1.5 py-0.5 text-[13px] text-[#326273]/65">
                    <CheckCircle2 size={10} className="text-emerald-500" /> {item}
                  </div>
                ))}
              </div>
              <div className="border-t border-[#326273]/8 pt-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-red-500">✗ Never stored</div>
                {['Invoice PDFs or content', 'Recipient bank details', 'Financial account numbers', 'KYB documents'].map((item) => (
                  <div key={item} className="flex items-center gap-1.5 py-0.5 text-[13px] text-[#326273]/65">
                    <X size={10} className="text-red-400" /> {item}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Quick links */}
          <div className="space-y-2">
            {[
              { label: 'New batch from suggestion', href: '/dashboard/batch',    icon: Layers    },
              { label: 'View treasury yield',       href: '/dashboard/treasury', icon: TrendingUp },
              { label: 'Live corridor rates',        href: '/dashboard',          icon: Globe     },
            ].map(({ label, href, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex w-full items-center justify-between rounded-lg border border-[#326273]/10 bg-white px-3 py-2.5 text-[13px] font-medium text-[#326273] transition-colors hover:border-[#5C9EAD]/40 hover:text-[var(--info)]"
              >
                <div className="flex items-center gap-2"><Icon size={13} /> {label}</div>
                <ChevronRight size={13} className="text-[#326273]/30" />
              </Link>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
