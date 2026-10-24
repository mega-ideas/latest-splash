'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowRightLeft,
  BadgeCheck,
  Clock3,
  FileText,
  History,
  Home,
  Info,
  Landmark,
  LayoutList,
  Lock,
  ReceiptText,
  Send,
  TrendingUp,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';

import { formatUsdc, scheduleFromWire, type FeeScheduleWire } from '@/lib/fees/copy';
import { FEE_KIND, splashFee, type FeeKind, type FeeSchedule } from '@/lib/fees/schedule';
import { formatRate, rateChip, settlementLines } from '@/lib/landing/calculator';
import { PILOT_ROUTES, QUOTABLE_ROUTES, isPilot, isQuotable, type PilotCurrency, type QuotableCurrency } from '@/lib/landing/routes';
import { MoneyError, formatMinor, parseMinor } from '@/lib/money';

/**
 * The product section (v2 brief section 6, board "Product section"): "Pay
 * the invoice. Keep the proof." with the desk behind and a calculator in
 * front.
 *
 * Every figure the calculator shows has a source:
 *   * Splash's fee is `splashFee` on the published schedule the page was
 *     rendered with (lib/fees/schedule.ts, the chain's own function), on top
 *     of the amount, or none while the FeeConfig's fees are off;
 *   * the exchange rate, the partner's fee and what the supplier receives
 *     are the payout partner's own quote (GET /api/quotes/preview), or "Not
 *     quoted yet" when there is none;
 *   * how long the rate is valid counts down from the quote's own TTL; an
 *     expired quote is asked for again while the calculator is on screen.
 * The rows add up on the card (lib/landing/calculator.ts settlementLines):
 * amount + Splash fee is the debit, amount - partner fee is converted.
 * The desk behind it is a picture of the layout, with no figures in it.
 *
 * PHP and IDR are quoted. MYR, VND, THB and SGD are under pilot access, and
 * choosing one offers a request for access instead of a quote.
 */

type Mode = 'bank' | 'wallet';
type Destination = QuotableCurrency | PilotCurrency;

type PreviewQuote = {
  rate: string | null;
  partnerFee: { minor: string | null; source: string };
  receivedMinor: string | null;
  ttlSeconds: number;
  sandbox: boolean;
};

const USDC_DECIMALS = 6;
const AMOUNT_PRESETS = ['1000', '5000', '25000'] as const;

function parseUsdc(raw: string): { minor: bigint | null; error: string | null } {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!cleaned) return { minor: null, error: 'Enter an amount in USDC.' };
  try {
    const minor = parseMinor(cleaned, USDC_DECIMALS, 'floor');
    if (minor <= 0n) return { minor: null, error: 'Enter an amount above zero.' };
    if (minor > 10_000_000n * 1_000_000n) return { minor: null, error: 'Up to ten million USDC here. Ask us about larger payments.' };
    return { minor, error: null };
  } catch (error) {
    return { minor: null, error: error instanceof MoneyError ? 'Enter an amount like 5000 or 2500.50.' : 'Enter an amount.' };
  }
}

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A target-currency amount from its minor units: "56,387.00", or "16,217,500" for whole rupiah. */
function formatTarget(minor: string, decimals: number): string {
  const text = formatMinor(BigInt(minor), decimals);
  const [whole, fraction] = text.split('.');
  return fraction === undefined ? group(whole) : `${group(whole)}.${fraction}`;
}

function feeFor(schedule: FeeSchedule, feesOn: boolean, kind: FeeKind, principalMinor: bigint): bigint {
  return feesOn ? splashFee({ kind, principalMinor, discountBps: 0, schedule }) : 0n;
}

/* ── The desk behind the calculator: layout only, no figures ─────────── */

const DESK_NAV = [
  { icon: Home, label: 'Home', active: true },
  { icon: Zap, label: 'Zeke' },
  { icon: Send, label: 'Transfer' },
  { icon: LayoutList, label: 'Batch payouts' },
  { icon: FileText, label: 'Invoices' },
  { icon: Wallet, label: 'Wallet' },
  { icon: TrendingUp, label: 'Treasury' },
  { icon: Users, label: 'Recipients' },
  { icon: History, label: 'History' },
];

const DESK_ROWS = [
  { who: 'Supplier, Philippines', type: 'Bank · PH', status: 'Settled', tone: 'ok' },
  { who: 'Supplier, Indonesia', type: 'Bank · ID', status: 'On the way', tone: 'info' },
  { who: 'Packaging supplier', type: 'Bank · PH', status: 'Needs approval', tone: 'warn' },
  { who: 'A business on Splash', type: 'Splash business', status: 'Settled', tone: 'ok' },
  { who: 'Wallet address', type: 'Wallet', status: 'Settled', tone: 'ok' },
] as const;

function DeskPreview() {
  return (
    <div className="pv-desk" aria-hidden="true">
      <div className="pv-desk-rail">
        <span className="pv-desk-brand">
          <Image src="/splash-main-icon.png" alt="" width={28} height={28} />
          <strong>Splash</strong>
        </span>
        <ul>
          {DESK_NAV.map(({ icon: Icon, label, active }) => (
            <li key={label} className={active ? 'is-active' : undefined}>
              <Icon />
              {label}
            </li>
          ))}
        </ul>
        <span className="pv-desk-rail-foot">Settlement rail: Sui</span>
      </div>
      <div className="pv-desk-main">
        <div className="pv-desk-top">
          <span className="pv-desk-search" />
          <span className="pv-desk-user" />
        </div>
        <div className="pv-desk-body">
          <strong className="pv-desk-title">Overview</strong>
          <div className="pv-desk-cards">
            <div><small>Splash Wallet</small><i className="pv-bar pv-bar-lg" /><em>USDC, held by your business</em></div>
            <div><small>Needs approval</small><i className="pv-bar" /><em>Waiting on an owner</em></div>
            <div><small>Sent this month</small><i className="pv-bar pv-bar-lg" /><em>PHP, IDR, USDC</em></div>
          </div>
          <div className="pv-desk-table">
            <div className="pv-desk-table-head"><strong>Recent payments</strong><span>View history</span></div>
            {DESK_ROWS.map((row) => (
              <div className="pv-desk-row" key={row.who}>
                <span>{row.who}</span>
                <span>{row.type}</span>
                <i className="pv-bar pv-bar-sm" />
                <b className={`pv-chip is-${row.tone}`}>{row.status}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Pilot access ───────────────────────────────────────────────────── */

/** How long the access form waits for the server before it lets the reader try again. */
const ACCESS_TIMEOUT_MS = 12_000;

function RequestAccess({ currency }: { currency: PilotCurrency }) {
  const route = PILOT_ROUTES.find((r) => r.currency === currency)!;
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [website, setWebsite] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const companyRef = useRef<HTMLInputElement>(null);
  const id = useId();

  function fail(field: string, message: string) {
    setError({ field, message });
    setPhase('idle');
    // The field the server named gets focus, so the reader lands on what to fix.
    if (field === 'email') emailRef.current?.focus();
    else if (field === 'company') companyRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === 'sending') return;
    setPhase('sending');
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ACCESS_TIMEOUT_MS);
    try {
      const response = await fetch('/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company, currency, website }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; field?: string };
      if (!response.ok) {
        fail(body.field ?? 'form', body.error ?? 'That did not go through. Try again in a minute.');
        return;
      }
      setPhase('done');
    } catch {
      fail(
        'form',
        controller.signal.aborted
          ? 'The request took too long. Try again.'
          : 'That did not go through. Check your connection and try again.',
      );
    } finally {
      window.clearTimeout(timer);
    }
  }

  if (phase === 'done') {
    return (
      <p className="pv-access-done" role="status">
        <BadgeCheck aria-hidden="true" />
        <span>Request received. We will email you when payouts to {route.country} open for your business.</span>
      </p>
    );
  }

  return (
    <form className="pv-access" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <p className="pv-access-title" id={`${id}-title`}>
        <strong>{route.country} is under pilot access</strong>
        <span>Payouts in {currency} open business by business. Ask for yours and we will be in touch.</span>
      </p>
      <label htmlFor={`${id}-email`}>Work email</label>
      <input
        ref={emailRef}
        id={`${id}-email`}
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        aria-invalid={error?.field === 'email' || undefined}
        aria-describedby={error?.field === 'email' ? `${id}-error` : undefined}
      />
      <label htmlFor={`${id}-company`}>Company</label>
      <input
        ref={companyRef}
        id={`${id}-company`}
        type="text"
        autoComplete="organization"
        required
        maxLength={160}
        value={company}
        onChange={(event) => setCompany(event.target.value)}
        aria-invalid={error?.field === 'company' || undefined}
        aria-describedby={error?.field === 'company' ? `${id}-error` : undefined}
      />
      {/* A person never sees this; a bot fills it, and is answered like anyone else. */}
      <input className="pv-trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(event) => setWebsite(event.target.value)} />
      {error ? <p className="pv-error" id={`${id}-error`} role="alert">{error.message}</p> : null}
      <button type="submit" className="pv-send" disabled={phase === 'sending'}>
        {phase === 'sending' ? 'Sending request…' : 'Request access'}
      </button>
    </form>
  );
}

/* ── The calculator ─────────────────────────────────────────────────── */

type Answer = { key: string; quote: PreviewQuote | null; receivedAt: number };

function Calculator({ schedule, feesOn }: { schedule: FeeSchedule; feesOn: boolean }) {
  const [mode, setMode] = useState<Mode>('bank');
  const [amount, setAmount] = useState('5000');
  const [destination, setDestination] = useState<Destination>('PHP');
  // The last answer, with the request it answers: an answer for another
  // amount or route is never shown as this one's.
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Bumped to ask the partner again once a quote's TTL has run out.
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useRef(false);
  const answerRef = useRef<Answer | null>(null);
  const id = useId();

  const parsed = useMemo(() => parseUsdc(amount), [amount]);
  const quotable = mode === 'bank' && isQuotable(destination);
  const pilot = mode === 'bank' && isPilot(destination);
  const route = quotable ? QUOTABLE_ROUTES.find((r) => r.currency === destination)! : null;
  const requestKey = quotable && parsed.minor !== null ? `${destination}:${parsed.minor}` : null;
  const current = requestKey && answer?.key === requestKey ? answer : null;
  const quote = current?.quote ?? null;
  const quoting = requestKey !== null && answer?.key !== requestKey;

  useEffect(() => {
    answerRef.current = current;
  }, [current]);

  // The partner's quote, once typing pauses. A stale answer never lands on a newer amount.
  useEffect(() => {
    if (!requestKey || parsed.minor === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let result: PreviewQuote | null = null;
      try {
        const params = new URLSearchParams({ currency: destination, amount: formatMinor(parsed.minor!, USDC_DECIMALS) });
        const response = await fetch(`/api/quotes/preview?${params}`, { signal: controller.signal });
        result = response.ok ? ((await response.json()) as PreviewQuote) : null;
      } catch {
        result = null;
      }
      if (!controller.signal.aborted) {
        const receivedAt = Date.now();
        setNow(receivedAt);
        setAnswer({ key: requestKey, quote: result, receivedAt });
      }
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [requestKey, destination, parsed.minor, refresh]);

  // An expired quote is fetched again only while the calculator is on
  // screen, so a page left open in a tab does not keep asking.
  const askAgainIfExpired = useCallback(() => {
    const last = answerRef.current;
    if (!inView.current || !last?.quote?.rate) return;
    if (rateChip(last.quote, Date.now() - last.receivedAt).state === 'expired') setRefresh((n) => n + 1);
  }, []);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      inView.current = entry.isIntersecting;
      if (entry.isIntersecting) askAgainIfExpired();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [askAgainIfExpired]);

  // The chip counts down once a second while there is a rate on it.
  const ticking = Boolean(quote?.rate);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      askAgainIfExpired();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ticking, askAgainIfExpired]);

  const kind = mode === 'bank' ? FEE_KIND.BANK_PAYOUT : FEE_KIND.WALLET;
  const fee = parsed.minor === null ? null : feeFor(schedule, feesOn, kind, parsed.minor);
  const businessFee = parsed.minor === null ? null : feeFor(schedule, feesOn, FEE_KIND.SPLASH_BUSINESS, parsed.minor);
  const partnerMinor = mode === 'bank' && quote?.partnerFee.minor ? BigInt(quote.partnerFee.minor) : null;
  const lines = parsed.minor !== null && fee !== null
    ? settlementLines({ mode, principalMinor: parsed.minor, splashFeeMinor: fee, partnerFeeMinor: partnerMinor })
    : null;
  const rateKnown = quotable && quote?.rate && quote.receivedMinor;
  const chip = rateKnown && current ? rateChip(quote!, now - current.receivedAt) : null;

  return (
    <div className="pv-calc" role="group" aria-label="Payment calculator" ref={rootRef}>
      <div className="pv-calc-top">
        <div className="pv-toggle" role="group" aria-label="Send to">
          {(['bank', 'wallet'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? 'is-on' : undefined} onClick={() => setMode(m)}>
              {m === 'bank' ? 'To a bank' : 'To a wallet'}
            </button>
          ))}
        </div>
        {quotable ? (
          <span className={`pv-rate${chip?.state === 'expired' ? ' is-expired' : ''}`}>
            <Lock aria-hidden="true" />
            <span aria-live="polite">
              {rateKnown ? `1 USDC = ${formatRate(quote!.rate!)} ${destination}` : quoting ? 'Asking for a rate…' : 'Rate not quoted yet'}
            </span>
            {chip?.state === 'held' ? <span className="pv-rate-ttl">valid {chip.secondsLeft}s</span> : null}
            {chip?.state === 'expired' ? (
              <button type="button" className="pv-rate-refresh" onClick={() => setRefresh((n) => n + 1)}>
                Rate expired, refresh
              </button>
            ) : null}
            {rateKnown && quote!.sandbox ? <em>Sandbox rate</em> : null}
          </span>
        ) : null}
      </div>

      <div className="pv-field">
        <label htmlFor={`${id}-amount`}>You send exactly</label>
        <div className="pv-amount">
          <span className="pv-asset"><span className="pv-coin" aria-hidden="true">$</span>USDC</span>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={parsed.error ? true : undefined}
            aria-describedby={parsed.error ? `${id}-amount-error` : undefined}
          />
        </div>
        <div className="pv-presets" role="group" aria-label="Common amounts">
          {AMOUNT_PRESETS.map((preset) => (
            <button key={preset} type="button" aria-pressed={amount.replace(/[,\s]/g, '') === preset} onClick={() => setAmount(preset)}>
              {group(preset)}
            </button>
          ))}
        </div>
        {parsed.error ? <p className="pv-error" id={`${id}-amount-error`} role="alert">{parsed.error}</p> : null}
      </div>

      {mode === 'wallet' && businessFee !== null ? (
        <p className="pv-hint">
          <Info aria-hidden="true" />
          <span>
            Paying a business that uses Splash?{' '}
            <strong>{businessFee === 0n ? 'No Splash fee.' : `${formatUsdc(businessFee)} USDC Splash fee.`}</strong>
          </span>
        </p>
      ) : null}

      <div className="pv-field">
        {mode === 'bank' ? (
          <>
            <label htmlFor={`${id}-dest`}>Supplier gets</label>
            <div className="pv-amount">
              <select id={`${id}-dest`} className="pv-asset pv-select" value={destination} onChange={(event) => setDestination(event.target.value as Destination)}>
                <optgroup label="Quoted now">
                  {QUOTABLE_ROUTES.map((r) => <option key={r.currency} value={r.currency}>{r.currency}</option>)}
                </optgroup>
                <optgroup label="Pilot access">
                  {PILOT_ROUTES.map((r) => <option key={r.currency} value={r.currency}>{r.currency}</option>)}
                </optgroup>
              </select>
              {quotable ? (
                <output className={`pv-figure${rateKnown ? ' is-quoted' : ''}`} htmlFor={`${id}-amount ${id}-dest`} aria-live="polite">
                  {rateKnown ? formatTarget(quote!.receivedMinor!, route!.decimals) : 'Not quoted yet'}
                </output>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <span className="pv-label">Recipient gets</span>
            <div className="pv-amount">
              <span className="pv-asset"><span className="pv-coin" aria-hidden="true">$</span>USDC on Sui</span>
              <output className="pv-figure is-quoted" aria-live="polite">{parsed.minor !== null ? formatUsdc(parsed.minor) : '-'}</output>
            </div>
          </>
        )}
      </div>

      {pilot ? (
        <RequestAccess key={destination} currency={destination as PilotCurrency} />
      ) : (
        <>
          <dl className="pv-lines">
            <div>
              <dt><Clock3 aria-hidden="true" />Arrives</dt>
              <dd>{mode === 'bank' ? route?.arrives : 'Seconds, on Sui'}</dd>
            </div>
            <div>
              <dt><ReceiptText aria-hidden="true" />Splash fee, added to the amount</dt>
              <dd className="num">{lines === null ? '-' : feesOn ? `${formatUsdc(lines.splashFeeMinor)} USDC` : 'None yet'}</dd>
            </div>
            {mode === 'bank' ? (
              <>
                <div>
                  <dt><Landmark aria-hidden="true" />Partner fee, deducted before conversion</dt>
                  <dd className="num">
                    {lines?.partnerFeeMinor != null ? `${formatUsdc(lines.partnerFeeMinor)} USDC` : 'Not quoted yet'}
                    {lines?.partnerFeeMinor != null && quote ? <small>{quote.partnerFee.source}</small> : null}
                  </dd>
                </div>
                <div>
                  <dt><ArrowRightLeft aria-hidden="true" />Converted to {destination}</dt>
                  <dd className="num">{lines?.convertedMinor != null ? `${formatUsdc(lines.convertedMinor)} USDC` : 'Not quoted yet'}</dd>
                </div>
              </>
            ) : null}
            <div className="is-total">
              <dt>From your Splash Wallet (amount + Splash fee)</dt>
              <dd className="num">{lines === null ? '-' : `${formatUsdc(lines.debitMinor)} USDC`}</dd>
            </div>
          </dl>
          <p className="pv-note">
            {mode === 'bank'
              ? "Payouts go only to verified business bank accounts, and the rate is fixed when you approve."
              : 'Sui transfers are final. Splash checks the address, and you approve before anything moves.'}
          </p>
          <Link href="/signup" className="pv-send">
            Open payment desk
            <ArrowRight aria-hidden="true" />
          </Link>
        </>
      )}
    </div>
  );
}

export default function ProductSection({ fees }: { fees: { schedule: FeeScheduleWire; feesOn: boolean } }) {
  const schedule = useMemo(() => scheduleFromWire(fees.schedule), [fees.schedule]);
  return (
    <section id="product" className="iso-section iso-product" aria-labelledby="product-title">
      <div className="iso-shell">
        <div className="pv-head">
          <span className="pv-chip-label">The product</span>
          <h2 className="pv-title" id="product-title">
            <span className="pv-title-a">Pay the invoice.</span>
            <span className="pv-title-b">Keep the proof.</span>
          </h2>
          <p>Your team approves every payment. It leaves your Splash Wallet in one Sui transaction, with a receipt you can share with your supplier.</p>
          <div className="pv-actions">
            <Link href="/signup" className="iso-button iso-button-gold">
              Open payment desk
              <ArrowRight aria-hidden="true" />
            </Link>
            <Link href="/login" className="iso-button iso-button-ghost">Log in</Link>
          </div>
        </div>
        <div className="pv-stage">
          <DeskPreview />
          <Calculator schedule={schedule} feesOn={fees.feesOn} />
        </div>
      </div>
    </section>
  );
}
