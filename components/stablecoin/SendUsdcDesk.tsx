'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  ExternalLink,
  Fingerprint,
  Info,
  Loader2,
  Lock,
  Send,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';

import ApprovalFlow from '@/components/approvals/ApprovalFlow';
import ApprovalsInbox from '@/components/approvals/ApprovalsInbox';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import FundingPlanner from '@/components/stablecoin/FundingPlanner';
import UsdyPreview from '@/components/stablecoin/UsdyPreview';
import WalletActivity from '@/components/stablecoin/WalletActivity';
import {
  formatUsdc,
  parseUsdcMinor,
  quoteStablecoinTransfer,
  shortAddress,
  StablecoinLaneError,
} from '@/lib/payments/stablecoin-lane';
import type { RecipientRecord } from '@/lib/server/operations';
import {
  connectWallet,
  describeSignError,
  discoverWallets,
  signWithPasskey,
  signWithWallet,
  type AcceptedWallet,
} from '@/lib/wallet/sui-signers';

type Lane = {
  network: 'mainnet';
  kybState: string;
  verified: boolean;
  lane: { open: boolean; reason: string };
  x402: { open: boolean; reason: string };
  allowance: { usedMinor: string; remainingMinor: string; windowCapMinor: string; windowDays: number };
  feeBps: number;
  minimumMinor: string;
  screeningConfigured: boolean;
  approval: { style: 'WHATSAPP_PASSKEY' | 'CLICK'; requireDualApproval: boolean; approvalThresholdUsd: number; ready?: boolean; readyReason?: string };
  outflows: Array<{
    id: string; kind: string; status: string; principalMinor: string; feeMinor: string; recipientAddress: string;
    supplierId: string | null; txDigest: string | null; explorerUrl: string | null; anchorStatus: string;
    failureReason: string | null; createdAt: string; confirmedAt: string | null; reservedUntil: string;
  }>;
  error?: string;
};

type WalletView = {
  address: string | null;
  source: 'SPLASH_PASSKEY' | 'EXTERNAL';
  passkey?: { publicKey: string; rpId: string } | null;
  usdcMinor?: string;
  suiMist?: string;
  gasLow?: boolean;
  reason?: string;
  error?: string;
};

type Quote = {
  kind?: 'TRANSFER' | 'X402';
  resourceUrl?: string;
  outflowId: string;
  recipient: { id: string; name: string; address: string };
  senderAddress: string;
  principalMinor: string;
  feeMinor: string;
  totalDebitMinor: string;
  reservedUntil: string;
  transactionBytes: string;
};

type Sent = {
  txDigest: string | null;
  explorerUrl: string | null;
  auditHash: string | null;
  principalMinor?: string;
  amountMinor?: string;
  content?: { status: number; contentType: string; body: string; truncated: boolean } | null;
};

type X402Probe = {
  ok: boolean;
  error?: string;
  resource?: { url: string; description: string; mimeType: string };
  amountMinor?: string;
  payTo?: string;
  offered?: Array<{ network: string; scheme: string }>;
};

const STEPS = ['Pay from', 'Recipient & amount', 'Approve', 'Sign & send'] as const;

async function json<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

export default function SendUsdcDesk() {
  const [lane, setLane] = useState<Lane | null>(null);
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [source, setSource] = useState<'SPLASH' | 'EXTERNAL'>('SPLASH');
  const [splash, setSplash] = useState<WalletView | null>(null);
  const [wallets, setWallets] = useState<AcceptedWallet[]>([]);
  const [external, setExternal] = useState<{ accepted: AcceptedWallet; account: { address: string; chains: readonly string[] }; view: WalletView | null } | null>(null);
  const [recipientId, setRecipientId] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<'quote' | 'connect' | 'send' | null>(null);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Sent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // x402: pay an API that answers 402, from the same wallets and allowance.
  const [mode, setMode] = useState<'WALLET' | 'X402'>('WALLET');
  // A transfer Zeke prepared (lib/agent/usdc-handoff.ts): filled in from the
  // link, never quoted from it — the person reviews it first.
  const [prefilled, setPrefilled] = useState(false);
  const [x402Url, setX402Url] = useState('');
  const [x402Probe, setX402Probe] = useState<X402Probe | null>(null);
  const [attestPayee, setAttestPayee] = useState(false);
  // The signed payment, kept so a settling x402 payment can be checked again
  // by resending the SAME signature (never a new one).
  const [lastSigned, setLastSigned] = useState<{ bytes: string; signature: string } | null>(null);
  const [settling, setSettling] = useState(false);

  const loadLane = useCallback(async () => {
    const res = await fetch('/api/stablecoin/allowance', { cache: 'no-store' });
    setLane(await json<Lane>(res));
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void loadLane(), 0);
    void fetch('/api/recipients', { cache: 'no-store' })
      .then((r) => json<RecipientRecord[]>(r))
      .then((list) => {
        const wallets = Array.isArray(list) ? list.filter((r) => r.payoutMethod === 'WALLET') : [];
        setRecipients(wallets);
        // ?to=<saved recipient id>&amount=<USDC>: only a recipient this
        // workspace saved, and only a plain amount; anything else is ignored.
        const params = new URLSearchParams(window.location.search);
        const to = params.get('to');
        const asked = params.get('amount') ?? '';
        if (to && wallets.some((r) => r.id === to)) {
          setMode('WALLET');
          setRecipientId(to);
          if (/^\d{1,9}(\.\d{1,6})?$/.test(asked)) setAmount(asked);
          setPrefilled(params.get('from') === 'zeke');
        }
      });
    void fetch('/api/stablecoin/wallet', { cache: 'no-store' }).then((r) => json<WalletView>(r)).then(setSplash);
    void discoverWallets().then(setWallets);
    return () => window.clearTimeout(first);
  }, [loadLane]);

  // The reservation countdown.
  useEffect(() => {
    if (!quote) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quote]);

  const sender = source === 'SPLASH' ? splash?.address ?? null : external?.account.address ?? null;
  const senderView = source === 'SPLASH' ? splash : external?.view ?? null;

  const preview = useMemo(() => {
    if (!amount.trim()) return null;
    try {
      const q = quoteStablecoinTransfer(parseUsdcMinor(amount.trim()));
      return { ok: true as const, q };
    } catch (err) {
      return { ok: false as const, reason: err instanceof StablecoinLaneError || err instanceof Error ? err.message : 'Invalid amount' };
    }
  }, [amount]);

  const remaining = lane?.allowance ? BigInt(lane.allowance.remainingMinor) : 0n;
  const cap = lane?.allowance ? BigInt(lane.allowance.windowCapMinor) : 0n;
  const used = lane?.allowance ? BigInt(lane.allowance.usedMinor) : 0n;
  const usedPct = cap > 0n ? Number((used * 1000n) / cap) / 10 : 0;
  const secondsLeft = quote ? Math.max(0, Math.floor((new Date(quote.reservedUntil).getTime() - now) / 1000)) : 0;
  const step = sent ? 4 : quote ? (approved ? 3 : 2) : sender ? 1 : 0;

  async function connect(accepted: AcceptedWallet) {
    setBusy('connect');
    setError('');
    try {
      const account = await connectWallet(accepted);
      const view = await json<WalletView>(await fetch(`/api/stablecoin/wallet?address=${encodeURIComponent(account.address)}`, { cache: 'no-store' }));
      setExternal({ accepted, account, view });
      setSource('EXTERNAL');
    } catch (err) {
      setError(accepted.kind === 'METAMASK_SUI_SNAP'
        ? `MetaMask could not connect: ${describeSignError(err)} MetaMask needs the Sui Snap, on desktop.`
        : describeSignError(err));
    } finally {
      setBusy(null);
    }
  }

  async function getQuote() {
    if (!sender || !recipientId || !preview?.ok) return;
    setBusy('quote');
    setError('');
    try {
      const res = await fetch('/api/stablecoin/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientId, amount: amount.trim(), senderAddress: sender }),
      });
      const body = await json<Quote & { error?: string }>(res);
      if (!res.ok) throw new Error(body.error ?? 'The quote could not be prepared.');
      setQuote(body);
      setApproved(false);
      setNow(Date.now());
      void loadLane();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The quote could not be prepared.');
    } finally {
      setBusy(null);
    }
  }

  async function checkX402Price() {
    setBusy('quote');
    setError('');
    setX402Probe(null);
    try {
      const res = await fetch('/api/x402/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: x402Url.trim() }),
      });
      setX402Probe(await json<X402Probe>(res));
    } finally {
      setBusy(null);
    }
  }

  async function getX402Quote() {
    if (!sender || !x402Probe?.ok) return;
    setBusy('quote');
    setError('');
    try {
      const res = await fetch('/api/x402/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: x402Url.trim(), senderAddress: sender, attestPayee }),
      });
      const body = await json<{ error?: string; outflowId: string; resource: { url: string; description: string }; amountMinor: string; payTo: string; senderAddress: string; reservedUntil: string; transactionBytes: string }>(res);
      if (!res.ok) throw new Error(body.error ?? 'The x402 payment could not be prepared.');
      let host = body.resource.url;
      try { host = new URL(x402Url.trim()).host; } catch { /* keep the url */ }
      setQuote({
        kind: 'X402',
        resourceUrl: x402Url.trim(),
        outflowId: body.outflowId,
        recipient: { id: '', name: host, address: body.payTo },
        senderAddress: body.senderAddress,
        principalMinor: body.amountMinor,
        feeMinor: '0',
        totalDebitMinor: body.amountMinor,
        reservedUntil: body.reservedUntil,
        transactionBytes: body.transactionBytes,
      });
      setApproved(false);
      setNow(Date.now());
      void loadLane();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The x402 payment could not be prepared.');
    } finally {
      setBusy(null);
    }
  }

  async function payX402(signed: { bytes: string; signature: string }) {
    if (!quote) return;
    const res = await fetch('/api/x402/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outflowId: quote.outflowId, transactionBytes: signed.bytes, signature: signed.signature }),
    });
    const body = await json<Sent & { status?: string; error?: string }>(res);
    if (!res.ok) throw new Error(body.error ?? 'The x402 payment did not go through.');
    if (body.status === 'SETTLING') {
      setSettling(true);
      toast.message('The seller answered; the payment is settling on chain.');
      return;
    }
    setSettling(false);
    setSent(body);
    toast.success('Paid and verified on Sui mainnet');
    void loadLane();
  }

  async function submitWallet(signed: { bytes: string; signature: string }) {
    if (!quote) return;
    const res = await fetch('/api/stablecoin/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outflowId: quote.outflowId, transactionBytes: signed.bytes, signature: signed.signature }),
    });
    const body = await json<Sent & { error?: string; code?: string }>(res);
    if (!res.ok) {
      // The network may still have it: offer to resend the SAME signed bytes.
      setSettling(body.code === 'submit_unconfirmed');
      throw new Error(body.error ?? 'The transfer was not sent.');
    }
    setSettling(false);
    setSent(body);
    toast.success('Sent and verified on Sui mainnet');
    void loadLane();
  }

  async function checkAgain() {
    if (!lastSigned) return;
    setBusy('send');
    setError('');
    try {
      if (quote?.kind === 'X402') await payX402(lastSigned);
      else await submitWallet(lastSigned);
    } catch (err) {
      setError(describeSignError(err));
    } finally {
      setBusy(null);
    }
  }

  async function signAndSend() {
    if (!quote) return;
    setBusy('send');
    setError('');
    try {
      let signed: { bytes: string; signature: string };
      if (source === 'SPLASH') {
        if (!splash?.passkey) throw new Error('Your Splash wallet needs its passkey. Create one in Settings → Security.');
        signed = await signWithPasskey(splash.passkey, quote.transactionBytes);
      } else {
        if (!external) throw new Error('Connect the wallet you quoted from.');
        signed = await signWithWallet(external.accepted, external.account, quote.transactionBytes);
      }
      setLastSigned(signed);
      if (quote.kind === 'X402') {
        await payX402(signed);
        return;
      }
      await submitWallet(signed);
    } catch (err) {
      setError(describeSignError(err));
    } finally {
      setBusy(null);
    }
  }

  function startOver() {
    setPrefilled(false);
    setQuote(null);
    setApproved(false);
    setSent(null);
    setAmount('');
    setError('');
    setLastSigned(null);
    setSettling(false);
    void loadLane();
  }

  if (lane?.error) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <DashPageHeader kicker="USDC on Sui · mainnet" title="Send USDC" />
        <p role="alert" className="dash-surface p-4 text-sm text-[var(--error)]">{lane.error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <DashPageHeader
        kicker="USDC on Sui · mainnet"
        title="Send USDC"
        description="Real USDC on Sui mainnet — to a wallet recipient you have saved, or to an API that asks for payment over x402. A recipient receives exactly what you enter; the 0.80% Splash fee is added on top in the same transaction. x402 payments carry no Splash fee."
      />

      {lane && !lane.lane.open ? (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4 text-sm text-[#1F4452]">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#8b6418]" />
          <span>{lane.lane.reason}</span>
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <div className="dash-block p-4 md:col-span-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="dash-kicker">30-day allowance</div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#1F4452]">
                {lane ? `${formatUsdc(remaining)} USDC` : '—'}
                <span className="ml-2 text-sm font-medium text-[#326273]/90">left of {lane ? formatUsdc(cap) : '—'}</span>
              </div>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${lane?.verified ? 'bg-[#6FB4A0]/15 text-[#1F4452]' : 'bg-[#E39774]/15 text-[#9F5839]'}`}>
              {lane ? (lane.verified ? 'Verified business' : 'Not yet verified') : '…'}
            </span>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#F6F0ED]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct} aria-label="Allowance used">
            <div className="h-full rounded-full bg-[#5C9EAD] transition-[width] duration-300" style={{ width: `${Math.min(100, usedPct)}%` }} />
          </div>
          <p className="mt-2 text-[13px] leading-5 text-[#326273]/90">
            {lane?.verified
              ? 'Verified businesses send up to 20,000 USDC per transfer and 500,000 in any 30 days.'
              : 'Until your business is verified you can send up to 5,000 USDC in any 30 days, x402 payments included. USD in and local-currency payouts unlock with verification.'}
            {' '}The window rolls: each transfer counts for 30 days from when it was sent.
          </p>
        </div>
        <div className="dash-block p-4">
          <div className="dash-kicker">Approval</div>
          <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-[#1F4452]">
            <ShieldCheck className="h-4 w-4 text-[var(--info)]" />
            {lane?.approval.style === 'WHATSAPP_PASSKEY' ? 'WhatsApp code + passkey' : 'Click to approve'}
          </div>
          <p className="mt-2 text-[13px] leading-5 text-[#326273]/90">
            {lane?.approval.style === 'WHATSAPP_PASSKEY'
              ? 'The main admin receives a code on WhatsApp, enters it here and confirms with their passkey.'
              : lane?.approval.requireDualApproval
                ? `An admin or checker clicks Approve. From ${lane.approval.approvalThresholdUsd.toLocaleString('en-US')} USD a second person must approve.`
                : 'An admin or checker clicks Approve.'}
          </p>
          <Link href="/dashboard/settings" className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--info)] hover:underline">
            Change in Settings <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      {lane && !sent ? (
        <Readiness
          lane={lane}
          mode={mode}
          source={source}
          sender={sender}
          senderView={senderView}
          walletRecipients={recipients.length}
        />
      ) : null}

      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Progress">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === Math.min(step, 3) ? 'step' : undefined}
            className={`rounded-lg border px-3 py-2 text-[13px] font-semibold ${index < step || sent ? 'border-[#6FB4A0]/40 bg-[#6FB4A0]/10 text-[#1F4452]' : index === step ? 'border-[#0C3E48] bg-[#0C3E48] text-white' : 'border-[#326273]/12 bg-white text-[#326273]/90'}`}
          >
            <span className="font-mono">{index + 1}</span> · {label}
          </li>
        ))}
      </ol>

      <section className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          {sent ? (
            <div className="dash-block p-5" role="status">
              <div className="flex items-center gap-2 text-lg font-bold text-[var(--ok)]"><CheckCircle2 className="h-5 w-5" /> Sent and verified on Sui mainnet</div>
              <p className="mt-2 text-sm leading-6 text-[#1F4452]">
                {formatUsdc(BigInt(sent.principalMinor ?? sent.amountMinor ?? '0'))} USDC reached {quote?.recipient.name}. Splash read the executed transaction back from the chain and matched every balance change to the quote before recording it.
              </p>
              {sent.content ? (
                <div className="mt-3">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#326273]/90">What the seller returned</div>
                  <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-[#326273]/12 bg-[#F6F0ED]/60 p-3 font-mono text-[12px] leading-5 text-[#1F4452]">{prettyBody(sent.content.body)}</pre>
                  {sent.content.truncated ? <p className="mt-1 text-[12px] text-[#326273]/90">Shortened for display.</p> : null}
                </div>
              ) : null}
              <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
                <div><dt className="text-[#326273]/90">Transaction</dt><dd className="font-mono text-[#1F4452]">{sent.txDigest ? shortAddress(sent.txDigest) : '—'}</dd></div>
                <div><dt className="text-[#326273]/90">Audit record</dt><dd className="font-mono text-[#1F4452]">{sent.auditHash ? `${sent.auditHash.slice(0, 12)}…` : '—'}</dd></div>
              </dl>
              <p className="mt-2 text-[12px] leading-5 text-[#326273]/90">
                Recorded now; anchored on chain once Splash&apos;s contracts are published on mainnet.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {sent.explorerUrl ? (
                  <a href={sent.explorerUrl} target="_blank" rel="noreferrer" className="dash-btn-ghost inline-flex items-center gap-1 !px-4 !py-2 !text-[13px]">
                    View on Suiscan <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
                <button type="button" onClick={startOver} className="dash-btn !px-4 !py-2 !text-[13px]">{quote?.kind === 'X402' ? 'Pay another' : 'Send another'}</button>
              </div>
            </div>
          ) : (
            <>
              <StepCard n={1} title="Pay from" done={Boolean(sender)} disabled={Boolean(quote)}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setSource('SPLASH')}
                    disabled={Boolean(quote)}
                    aria-pressed={source === 'SPLASH'}
                    className={`rounded-xl border p-3 text-left transition-colors ${source === 'SPLASH' ? 'border-[#0C3E48] bg-[#0C3E48]/5' : 'border-[#326273]/15 hover:border-[#5C9EAD]'}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#1F4452]"><Fingerprint className="h-4 w-4 text-[var(--info)]" /> Splash wallet</div>
                    <p className="mt-1 text-[13px] leading-5 text-[#326273]/90">Your passkey&apos;s own Sui address. Only your device can sign; Splash never holds the key.</p>
                  </button>
                  <div className={`rounded-xl border p-3 ${source === 'EXTERNAL' ? 'border-[#0C3E48] bg-[#0C3E48]/5' : 'border-[#326273]/15'}`}>
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#1F4452]"><Wallet className="h-4 w-4 text-[var(--info)]" /> Your own wallet</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {wallets.length === 0 ? (
                        <p className="text-[13px] leading-5 text-[#326273]/90">No Slush or MetaMask (Sui Snap) found in this browser.</p>
                      ) : wallets.map((w) => (
                        <button key={w.kind} type="button" disabled={busy !== null || Boolean(quote)} onClick={() => void connect(w)} className="dash-btn-ghost inline-flex items-center gap-2 !px-3 !py-1.5 !text-[13px]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={w.icon} alt="" width={16} height={16} className="h-4 w-4" />
                          {external?.accepted.kind === w.kind ? 'Connected' : w.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <WalletBalances view={senderView} source={source} />
              </StepCard>

              <div role="tablist" aria-label="What are you paying?" className="inline-flex rounded-lg border border-[#326273]/15 bg-[#F6F0ED] p-1">
                {([['WALLET', 'A wallet recipient'], ['X402', 'An x402 API']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={mode === value}
                    disabled={Boolean(quote)}
                    onClick={() => { setMode(value); setError(''); }}
                    className={`inline-flex min-h-10 items-center rounded-md px-3 text-[13px] font-semibold transition-colors ${mode === value ? 'bg-[#0C3E48] text-white' : 'text-[#326273] hover:bg-white'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === 'X402' ? (
                <StepCard n={2} title="API & price" done={Boolean(quote)} disabled={!sender || Boolean(quote) || !lane?.x402.open}>
                  {lane && !lane.x402.open ? <p className="text-[13px] text-[var(--error)]">{lane.x402.reason}</p> : null}
                  <label htmlFor="x402-url" className="text-[13px] font-medium text-[#326273]/90">Resource URL</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <input
                      id="x402-url"
                      value={x402Url}
                      onChange={(e) => { setX402Url(e.target.value); setX402Probe(null); }}
                      placeholder="https://api.example.com/data"
                      spellCheck={false}
                      disabled={Boolean(quote)}
                      className="min-w-0 flex-1 rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-3 py-2 font-mono text-[13px] text-[#1F4452] focus:border-[#5C9EAD] focus-ring"
                    />
                    <button type="button" onClick={() => void checkX402Price()} disabled={busy !== null || !x402Url.trim() || Boolean(quote)} className="dash-btn-ghost !px-3 !py-2 !text-[13px]">
                      Check price
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setX402Url(`${window.location.origin}/api/x402/demo/corridor-fees`); setX402Probe(null); }}
                    disabled={Boolean(quote)}
                    className="mt-1 text-[12px] font-semibold text-[var(--info)] hover:underline"
                  >
                    Try the Splash demo seller (0.01 USDC)
                  </button>
                  {x402Probe ? (
                    x402Probe.ok ? (
                      <div className="mt-3 rounded-lg border border-[#326273]/12 bg-white p-3 text-[13px] text-[#1F4452]">
                        <div className="font-semibold">{x402Probe.resource?.description || 'x402 resource'}</div>
                        <div className="mt-1 font-mono tabular-nums">{formatUsdc(BigInt(x402Probe.amountMinor ?? '0'))} USDC → {shortAddress(x402Probe.payTo ?? '')}</div>
                        {!lane?.screeningConfigured ? (
                          <label className="mt-2 flex items-start gap-2 text-[12px] leading-5 text-[#326273]/90">
                            <input type="checkbox" checked={attestPayee} onChange={(e) => setAttestPayee(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#0C3E48]" />
                            No screening provider is configured. As an admin, I attest that I know this seller (recorded with my name).
                          </label>
                        ) : null}
                      </div>
                    ) : (
                      <p role="alert" className="mt-3 text-[13px] leading-5 text-[var(--error)]">{x402Probe.error}</p>
                    )
                  ) : null}
                  {!quote ? (
                    <button
                      type="button"
                      onClick={() => void getX402Quote()}
                      disabled={busy !== null || !sender || !x402Probe?.ok || !lane?.x402.open}
                      className="dash-btn mt-3 !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy === 'quote' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                      Reserve & prepare
                    </button>
                  ) : (
                    <div className="mt-3">
                      <TransactionLegs quote={quote} />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#326273]/90">
                        <span aria-live="polite">
                          {secondsLeft > 0
                            ? `Allowance held for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`
                            : 'This quote expired. Nothing was paid — start again.'}
                        </span>
                        <button type="button" onClick={startOver} className="font-semibold text-[var(--info)] hover:underline">Change</button>
                      </div>
                    </div>
                  )}
                </StepCard>
              ) : (
              <StepCard n={2} title="Recipient & amount" done={Boolean(quote)} disabled={!sender || Boolean(quote) || !lane?.lane.open}>
                {prefilled && !quote ? (
                  <p className="mb-3 rounded-lg border border-[#5C9EAD]/40 bg-[#5C9EAD]/10 px-3 py-2 text-[13px] leading-5 text-[#1F4452]" role="status">
                    Zeke filled this in. Check the recipient and the amount — nothing is reserved or sent until you continue, and it is approved and signed the usual way.
                  </p>
                ) : null}
                {recipients.length === 0 ? (
                  <p className="text-[13px] leading-5 text-[#326273]/90">
                    No wallet recipients yet. <Link href="/dashboard/recipients" className="font-semibold text-[var(--info)] hover:underline">Add one under Recipients</Link> — Splash and Zeke only send to recipients you have saved.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="send-recipient" className="text-[13px] font-medium text-[#326273]/90">Recipient</label>
                      <select
                        id="send-recipient"
                        value={recipientId}
                        onChange={(e) => setRecipientId(e.target.value)}
                        disabled={Boolean(quote)}
                        className="mt-1 w-full rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-3 py-2 text-sm text-[#1F4452] focus:border-[#5C9EAD] focus-ring"
                      >
                        <option value="">Choose a wallet recipient</option>
                        {recipients.map((r) => (
                          <option key={r.id} value={r.id}>{r.name} · {r.walletAddress ? shortAddress(r.walletAddress) : ''}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="send-amount" className="text-[13px] font-medium text-[#326273]/90">They receive (USDC)</label>
                      <input
                        id="send-amount"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                        inputMode="decimal"
                        placeholder="1,000.00"
                        disabled={Boolean(quote)}
                        className="mt-1 w-full rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-3 py-2 font-mono text-sm tabular-nums text-[#1F4452] focus:border-[#5C9EAD] focus-ring"
                        aria-describedby="send-amount-help"
                      />
                    </div>
                    <div id="send-amount-help" className="sm:col-span-2" aria-live="polite">
                      {preview?.ok ? (
                        <p className="text-[13px] tabular-nums text-[#326273]/90">
                          Fee {formatUsdc(preview.q.feeMinor)} USDC (0.80%) · you send <strong className="text-[#1F4452]">{formatUsdc(preview.q.totalDebitMinor)} USDC</strong>
                          {preview.q.principalMinor > remaining ? <span className="ml-2 font-semibold text-[var(--error)]">— more than your remaining allowance</span> : null}
                        </p>
                      ) : preview ? (
                        <p className="text-[13px] text-[var(--error)]">{preview.reason}</p>
                      ) : (
                        <p className="text-[13px] text-[#326273]/90">Minimum 1 USDC. The network fee (gas) is paid in SUI from the sending wallet.</p>
                      )}
                    </div>
                  </div>
                )}
                {!quote ? (
                  <button
                    type="button"
                    onClick={() => void getQuote()}
                    disabled={busy !== null || !sender || !recipientId || !preview?.ok || !lane?.lane.open}
                    className="dash-btn mt-3 !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === 'quote' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    Get quote
                  </button>
                ) : (
                  <div className="mt-3">
                    <TransactionLegs quote={quote} />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#326273]/90">
                      <span aria-live="polite">
                        {secondsLeft > 0
                          ? `Allowance held for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`
                          : 'This quote expired. Nothing was sent — start again.'}
                      </span>
                      <button type="button" onClick={startOver} className="font-semibold text-[var(--info)] hover:underline">Change amount or recipient</button>
                    </div>
                  </div>
                )}
              </StepCard>
              )}

              <StepCard n={3} title="Approve" done={approved} disabled={!quote}>
                {quote ? (
                  <ApprovalFlow purpose="STABLECOIN_TRANSFER" subjectId={quote.outflowId} onApproved={() => setApproved(true)} />
                ) : (
                  <p className="text-[13px] text-[#326273]/90">Get a quote first.</p>
                )}
              </StepCard>

              <StepCard n={4} title="Sign & send" done={false} disabled={!approved}>
                <p className="text-[13px] leading-5 text-[#326273]/90">
                  {quote?.kind === 'X402'
                    ? `${source === 'SPLASH' ? 'Your passkey' : external?.accepted.label ?? 'Your wallet'} signs the exact payment quoted. Splash dry-runs it, re-checks the seller's price, hands the signed payment to the seller to settle, and confirms it on chain.`
                    : source === 'SPLASH'
                      ? 'Your passkey signs the exact transaction quoted. Splash dry-runs it, sends it, and checks the result on chain.'
                      : `${external?.accepted.label ?? 'Your wallet'} signs the exact transaction quoted — it does not broadcast it. Splash dry-runs it, sends it, and checks the result on chain.`}
                </p>
                {settling ? (
                  <div role="status" className="mt-2 rounded-lg border border-[#326273]/15 bg-white p-3 text-[13px] text-[#1F4452]">
                    {quote?.kind === 'X402' ? 'The seller accepted the payment; it has not shown on chain yet.' : 'The network did not confirm the submission yet.'}{' '}
                    <button type="button" onClick={() => void checkAgain()} disabled={busy !== null} className="font-semibold text-[var(--info)] hover:underline">{quote?.kind === 'X402' ? 'Check again' : 'Send again'}</button>
                    <span className="block text-[12px] text-[#326273]/90">This resends the same signed transaction — it cannot be paid twice.</span>
                  </div>
                ) : null}
                <p className="mt-2 flex items-start gap-2 text-[12px] leading-5 text-[#326273]/90">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8b6418]" />
                  A transfer on Sui is final. Check the recipient address before you sign.
                </p>
                <button
                  type="button"
                  onClick={() => void signAndSend()}
                  disabled={!approved || busy !== null || secondsLeft === 0 || settling}
                  className="dash-btn mt-3 !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {quote ? `${quote.kind === 'X402' ? 'Sign & pay' : 'Sign & send'} ${formatUsdc(BigInt(quote.totalDebitMinor))} USDC` : 'Sign & send'}
                </button>
              </StepCard>
            </>
          )}
          {error ? <p role="alert" className="rounded-lg border border-[var(--error)]/30 bg-white p-3 text-[13px] font-medium text-[var(--error)]">{error}</p> : null}
        </div>

        <aside className="space-y-4">
          <ApprovalsInbox onChange={() => void loadLane()} />
          {lane?.approval.style === 'CLICK' ? (
            <ClickApprovals
              outflows={(lane?.outflows ?? []).filter((o) => o.status === 'PENDING'
                && new Date(o.reservedUntil).getTime() > now && o.id !== quote?.outflowId)}
              recipients={recipients}
              onChange={() => void loadLane()}
            />
          ) : null}
          {/* Reads the chain again when a send lands (sent flips) and on start-over. */}
          <WalletActivity address={sender} splash={source === 'SPLASH'} refreshKey={sent ? 1 : 0} />
          <RecentTransfers outflows={lane?.outflows ?? []} recipients={recipients} />
          <UsdyPreview />
        </aside>
      </section>
    </div>
  );
}

/**
 * What the wallet or passkey will sign, leg by leg: ONE Sui transaction paying
 * the recipient and Splash's fee together, both from the sending wallet. It is
 * the same arithmetic Splash checks on the dry run and again on chain.
 */
function TransactionLegs({ quote }: { quote: Quote }) {
  const legs = quote.kind === 'X402'
    ? [{ to: quote.recipient.name, address: quote.recipient.address, amount: BigInt(quote.principalMinor), note: 'the seller’s price, exactly' }]
    : [
      { to: quote.recipient.name, address: quote.recipient.address, amount: BigInt(quote.principalMinor), note: 'receives exactly this' },
      { to: 'Splash fee', address: null, amount: BigInt(quote.feeMinor), note: '0.80%, same transaction' },
    ];
  return (
    <figure className="overflow-hidden rounded-xl border border-[#0C3E48]/20 bg-white" aria-label="What you are signing">
      <figcaption className="flex items-center justify-between gap-2 bg-[#0C3E48] px-3 py-2 font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-white/80">
        <span>{quote.kind === 'X402' ? 'One x402 payment · no Splash fee' : 'One transaction · two legs'}</span>
        <span className="text-[#efc46f]">Sui mainnet</span>
      </figcaption>
      <div className="px-3 pb-3 pt-2">
        <div className="font-mono text-[12px] text-[#326273]/90">from {shortAddress(quote.senderAddress)}</div>
        <ol className="mt-1 border-l-2 border-[#0C3E48]/25 pl-3">
          {legs.map((leg) => (
            <li key={leg.to} className="relative flex items-baseline justify-between gap-3 py-1.5 text-[13px] tabular-nums">
              <span aria-hidden className="absolute -left-[15px] top-[13px] h-0.5 w-2.5 bg-[#0C3E48]/25" />
              <span className="min-w-0">
                <span className="font-semibold text-[#1F4452]">{leg.to}</span>
                {leg.address ? <span className="ml-1.5 font-mono text-[12px] text-[#326273]/90">{shortAddress(leg.address)}</span> : null}
                <span className="block text-[12px] text-[#326273]/90">{leg.note}</span>
              </span>
              <span className="shrink-0 font-mono font-semibold text-[#1F4452]">{formatUsdc(leg.amount)} USDC</span>
            </li>
          ))}
        </ol>
        <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-dashed border-[#326273]/20 pt-2 text-[13px] tabular-nums">
          <span className="font-semibold text-[#1F4452]">Leaves your wallet</span>
          <span className="font-mono text-base font-bold text-[#0C3E48]">{formatUsdc(BigInt(quote.totalDebitMinor))} USDC</span>
        </div>
        <p className="mt-1 text-[12px] text-[#326273]/90">Plus a small network fee in SUI.</p>
      </div>
    </figure>
  );
}

type Check = { key: string; label: string; state: 'ok' | 'todo' | 'waiting' | 'note'; detail: string; href?: string; action?: string };

/**
 * What has to be true before a real mainnet transfer can go, in the order
 * it is usually fixed. Every row is read from the server or the chain —
 * nothing here is a guess — and each open row says what to do next.
 */
function Readiness({
  lane,
  mode,
  source,
  sender,
  senderView,
  walletRecipients,
}: {
  lane: Lane;
  mode: 'WALLET' | 'X402';
  source: 'SPLASH' | 'EXTERNAL';
  sender: string | null;
  senderView: WalletView | null | undefined;
  walletRecipients: number;
}) {
  const usdc = senderView?.usdcMinor !== undefined ? BigInt(senderView.usdcMinor) : null;
  const minimum = BigInt(lane.minimumMinor);
  const checks: Check[] = [
    mode === 'X402'
      ? { key: 'lane', label: 'x402 payments open', state: lane.x402.open ? 'ok' : 'todo', detail: lane.x402.open ? 'No Splash fee on x402.' : lane.x402.reason }
      : { key: 'lane', label: 'Wallet transfers open', state: lane.lane.open ? 'ok' : 'todo', detail: lane.lane.open ? 'Mainnet, with the 0.80% fee added on top.' : lane.lane.reason },
    {
      key: 'approval',
      label: lane.approval.style === 'WHATSAPP_PASSKEY' ? 'Approver reachable on WhatsApp' : 'An approver',
      state: lane.approval.ready === false ? 'todo' : 'ok',
      detail: lane.approval.ready === false
        ? lane.approval.readyReason ?? 'Approvals cannot be given right now.'
        : lane.approval.style === 'WHATSAPP_PASSKEY'
          ? 'The main admin has a confirmed number and a passkey.'
          : 'An admin or checker approves with a click.',
      href: lane.approval.ready === false ? '/dashboard/settings' : undefined,
      action: 'Settings',
    },
    sender
      ? { key: 'wallet', label: 'A wallet to pay from', state: 'ok', detail: `${source === 'SPLASH' ? 'Splash wallet' : 'Your wallet'} ${shortAddress(sender)}.` }
      : source === 'SPLASH'
        ? { key: 'wallet', label: 'A wallet to pay from', state: 'todo', detail: 'Your Splash wallet is your passkey’s address. Create one — or restore the one already on this device — then come back.', href: '/settings/security', action: 'Passkey settings' }
        : { key: 'wallet', label: 'A wallet to pay from', state: 'todo', detail: 'Connect Slush or MetaMask (Sui Snap) under Pay from.' },
    !sender || usdc === null
      ? { key: 'usdc', label: 'USDC to send', state: 'waiting', detail: 'Shown once a wallet is chosen.' }
      : usdc >= minimum
        ? { key: 'usdc', label: 'USDC to send', state: 'ok', detail: `${formatUsdc(usdc)} USDC in the wallet.` }
        : { key: 'usdc', label: 'USDC to send', state: 'todo', detail: `${formatUsdc(usdc)} USDC in the wallet. Send USDC on Sui to it from Slush, MetaMask or an exchange — or bring it from another chain (Add funds, under Pay from).` },
    !sender || senderView?.suiMist === undefined
      ? { key: 'gas', label: 'SUI for network fees', state: 'waiting', detail: 'Shown once a wallet is chosen.' }
      : senderView.gasLow
        ? { key: 'gas', label: 'SUI for network fees', state: 'todo', detail: 'About 0.05 SUI covers the network fee on many transfers. Without it the wallet can hold USDC but not send it.' }
        : { key: 'gas', label: 'SUI for network fees', state: 'ok', detail: 'Enough for the network fee.' },
    ...(mode === 'WALLET'
      ? [walletRecipients > 0
        ? { key: 'recipient', label: 'A saved wallet recipient', state: 'ok' as const, detail: `${walletRecipients} saved. Recipients are only ever added by hand.` }
        : { key: 'recipient', label: 'A saved wallet recipient', state: 'todo' as const, detail: 'Add the Slush or MetaMask Sui address you are paying, by hand.', href: '/dashboard/recipients', action: 'Recipients' }]
      : []),
    {
      key: 'screening',
      label: 'Recipient screening',
      state: lane.screeningConfigured ? 'ok' : 'note',
      detail: lane.screeningConfigured
        ? 'Each wallet recipient is checked against sanctions lists when it is saved.'
        : 'No screening provider is connected, so an owner or finance admin vouches for each wallet recipient when saving it.',
    },
  ];
  const open = checks.filter((c) => c.state === 'todo').length;
  const ready = open === 0 && checks.every((c) => c.state !== 'waiting');

  return (
    <section className="dash-block p-4" aria-labelledby="send-readiness-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="send-readiness-title" className="dash-kicker">Before you send</h2>
        <span className={`text-[13px] font-semibold ${ready ? 'text-[var(--ok)]' : 'text-[#326273]/90'}`} role="status">
          {ready ? 'Ready for a mainnet transfer' : open > 0 ? `${open} to sort out` : 'Choose a wallet to finish the check'}
        </span>
      </div>
      <ul className="mt-3 grid gap-x-5 gap-y-2.5 md:grid-cols-2">
        {checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2.5">
            <CheckMark state={c.state} />
            <div className="min-w-0 text-[13px] leading-5">
              <span className="font-semibold text-[#1F4452]">{c.label}</span>
              <span className="block text-[#326273]/90">
                {c.detail}
                {c.href && c.state === 'todo' ? (
                  <>
                    {' '}
                    <Link href={c.href} className="font-semibold text-[var(--info)] hover:underline">{c.action} <ArrowRight className="inline h-3 w-3" aria-hidden /></Link>
                  </>
                ) : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckMark({ state }: { state: Check['state'] }) {
  if (state === 'ok') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ok)]" aria-label="Done" />;
  if (state === 'todo') return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8b6418]" aria-label="To do" />;
  if (state === 'note') return <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" aria-label="Note" />;
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[#326273]/90" aria-label="Waiting" />;
}

/** A seller's JSON, indented; anything else as it came. */
function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function StepCard({ n, title, done, disabled, children }: { n: number; title: string; done: boolean; disabled: boolean; children: React.ReactNode }) {
  return (
    <section className={`dash-surface p-4 transition-opacity ${disabled && !done ? 'opacity-60' : ''}`} aria-labelledby={`send-step-${n}`}>
      <h2 id={`send-step-${n}`} className="flex items-center gap-2 text-sm font-semibold text-[#1F4452]">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full font-mono text-[12px] ${done ? 'bg-[#6FB4A0] text-[#073d49]' : 'bg-[#0C3E48] text-white'}`}>
          {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
        </span>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function WalletBalances({ view, source }: { view: WalletView | null | undefined; source: 'SPLASH' | 'EXTERNAL' }) {
  if (!view) return null;
  if (!view.address) {
    return (
      <p className="mt-3 text-[13px] leading-5 text-[#326273]/90">
        {view.reason ?? 'No wallet yet.'}{' '}
        {source === 'SPLASH' ? <Link href="/settings/security" className="font-semibold text-[var(--info)] hover:underline">Create or restore a passkey</Link> : null}
      </p>
    );
  }
  const copy = () => {
    void navigator.clipboard.writeText(view.address ?? '');
    toast.success('Address copied');
  };
  return (
    <div className="mt-3 rounded-lg border border-[#326273]/12 bg-[#F6F0ED]/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <code className="min-w-0 break-all font-mono text-[12px] text-[#1F4452]">{view.address}</code>
        <button type="button" onClick={copy} aria-label="Copy address" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#326273] hover:bg-white">
          <Copy className="h-4 w-4" />
        </button>
      </div>
      {view.error ? (
        <p className="mt-2 text-[13px] text-[var(--error)]">{view.error}</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular-nums text-[#1F4452]">
          <span><strong>{view.usdcMinor ? formatUsdc(BigInt(view.usdcMinor)) : '—'}</strong> USDC</span>
          <span><strong>{view.suiMist ? (Number(BigInt(view.suiMist) / 1_000_000n) / 1000).toFixed(3) : '—'}</strong> SUI for gas</span>
        </div>
      )}
      {view.gasLow ? (
        <p className="mt-2 text-[12px] leading-5 text-[#9F5839]">Add a little SUI (about 0.05) to pay network fees — without it this wallet can hold USDC but not send it.</p>
      ) : null}
      {source === 'SPLASH' ? (
        <>
          <p className="mt-2 text-[12px] leading-5 text-[#326273]/90">
            Fund it from MetaMask (Sui Snap), Slush, an exchange or any wallet that sends <strong>USDC on Sui</strong> to this address.
          </p>
          <FundingPlanner destination={view.address} />
        </>
      ) : null}
    </div>
  );
}

/** Click style: transfers others prepared, waiting for an admin or checker to approve. */
function ClickApprovals({ outflows, recipients, onChange }: { outflows: Lane['outflows']; recipients: RecipientRecord[]; onChange: () => void }) {
  if (outflows.length === 0) return null;
  const names = new Map(recipients.map((r) => [r.id, r.name]));
  return (
    <section className="dash-surface p-4" aria-labelledby="click-approvals-title">
      <h2 id="click-approvals-title" className="text-sm font-semibold text-[#326273]">Transfers waiting for approval</h2>
      <ul className="mt-3 space-y-3">
        {outflows.map((o) => (
          <li key={o.id} className="rounded-lg border border-[#326273]/12 bg-white p-3">
            <div className="mb-2 text-[12px] font-semibold text-[#326273]/90">
              {names.get(o.supplierId ?? '') ?? shortAddress(o.recipientAddress)} · {formatUsdc(BigInt(o.principalMinor))} USDC
            </div>
            <ApprovalFlow purpose="STABLECOIN_TRANSFER" subjectId={o.id} onApproved={onChange} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentTransfers({ outflows, recipients }: { outflows: Lane['outflows']; recipients: RecipientRecord[] }) {
  const names = new Map(recipients.map((r) => [r.id, r.name]));
  return (
    <section className="dash-surface p-4" aria-labelledby="recent-usdc-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="recent-usdc-title" className="text-sm font-semibold text-[#326273]">Sent with Splash</h2>
        {outflows.length > 0 ? (
          <a href="/api/stablecoin/export" download className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--info)] hover:underline">
            <Download className="h-3.5 w-3.5" aria-hidden /> All records (CSV)
          </a>
        ) : null}
      </div>
      {outflows.length === 0 ? (
        <p className="mt-2 text-[13px] text-[#326273]/90">None yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {outflows.slice(0, 8).map((o) => (
            <li key={o.id} className="rounded-lg border border-[#326273]/10 bg-white p-2.5 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-[#1F4452]">{o.kind === 'X402' ? 'x402 payment' : names.get(o.supplierId ?? '') ?? shortAddress(o.recipientAddress)}</span>
                <span className="font-mono tabular-nums text-[#1F4452]">{formatUsdc(BigInt(o.principalMinor))}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-[12px] text-[#326273]/90">
                <span>{o.status === 'CONFIRMED' ? 'Verified on chain' : o.status === 'PENDING' ? 'Awaiting approval / signature' : o.status.toLowerCase()}</span>
                {o.explorerUrl ? (
                  <a href={o.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-[var(--info)] hover:underline">
                    Suiscan <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
