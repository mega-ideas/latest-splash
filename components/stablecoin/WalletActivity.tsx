'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, ExternalLink, Loader2 } from 'lucide-react';

import LocalTime from '@/components/LocalTime';
import { formatUsdc, shortAddress } from '@/lib/payments/stablecoin-lane';

/**
 * Money in and out of a wallet, read from Sui — the part of "a wallet in
 * Splash" that Splash's own records cannot show: deposits from Slush, an
 * exchange or another chain. Sends Splash made are named from its records; an
 * outgoing movement with no record is marked, because from a passkey wallet
 * only Splash can sign.
 */

type Movement = {
  digest: string;
  timestamp: string | null;
  success: boolean;
  direction: 'IN' | 'OUT';
  amountMinor: string;
  feeMinor: string | null;
  counterparty: string | null;
  label: string;
  origin: 'SPLASH' | 'RECEIVED' | 'SENT' | 'NO_RECORD';
  explorerUrl: string;
};

type Page = {
  address?: string | null;
  available?: boolean;
  reason?: string;
  error?: string;
  movements?: Movement[];
  olderCursor?: string | null;
};

function when(timestamp: string | null) {
  if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) return null;
  return <LocalTime value={timestamp} options={{ dateStyle: 'medium', timeStyle: 'short' }} />;
}

export default function WalletActivity({
  address,
  splash,
  refreshKey,
}: {
  /** The wallet on screen; null until one is chosen. */
  address: string | null;
  /** True for the Splash wallet (the server resolves the caller's own passkey address). */
  splash: boolean;
  /** Bump after a send so the list reads the chain again. */
  refreshKey: number;
}) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'first' | 'older' | null>(null);

  const fetchPage = useCallback(async (before: string | null): Promise<Page> => {
    const params = new URLSearchParams();
    if (!splash && address) params.set('address', address);
    if (before) params.set('before', before);
    const qs = params.toString();
    const res = await fetch(`/api/stablecoin/activity${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
    return (await res.json().catch(() => ({ error: `Activity could not be read (${res.status}).` }))) as Page;
  }, [address, splash]);

  const loadFirst = useCallback(async () => {
    setBusy('first');
    try {
      const page = await fetchPage(null);
      setMovements(page.movements ?? []);
      setOlderCursor(page.olderCursor ?? null);
      setNotice(page.error ?? (page.available === false ? `Sui activity is unavailable right now: ${page.reason}` : page.reason ?? ''));
    } finally {
      setBusy(null);
    }
  }, [fetchPage]);

  useEffect(() => {
    if (!address) return;
    // Deferred a tick so the effect itself sets no state (react-compiler rule).
    const first = window.setTimeout(() => void loadFirst(), 0);
    return () => window.clearTimeout(first);
  }, [address, loadFirst, refreshKey]);

  async function loadOlder() {
    if (!olderCursor) return;
    setBusy('older');
    try {
      const page = await fetchPage(olderCursor);
      setMovements((current) => [...current, ...(page.movements ?? []).filter((m) => !current.some((c) => c.digest === m.digest))]);
      setOlderCursor(page.olderCursor ?? null);
      if (page.error || page.available === false) setNotice(page.error ?? `Sui activity is unavailable right now: ${page.reason}`);
    } finally {
      setBusy(null);
    }
  }

  if (!address) return null;

  return (
    <section className="dash-surface p-4" aria-labelledby="wallet-activity-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="wallet-activity-title" className="text-sm font-semibold text-[#326273]">Wallet activity</h2>
        <span className="font-mono text-[12px] text-[#326273]/90">{shortAddress(address)}</span>
      </div>
      <p className="mt-0.5 text-[12px] leading-5 text-[#326273]/90">
        USDC in and out of {splash ? 'your Splash wallet' : 'this wallet'}, read from Sui mainnet.
      </p>

      {busy === 'first' && movements.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-[#326273]/90" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the chain…
        </p>
      ) : movements.length === 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-[#326273]/90">
          {notice || 'No USDC has moved in or out yet. Send USDC on Sui to the address above to fund it.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5" aria-busy={busy !== null}>
          {movements.map((m) => {
            const amount = formatUsdc(BigInt(m.amountMinor));
            const noRecord = m.origin === 'NO_RECORD';
            return (
              <li
                key={m.digest}
                className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-[13px] ${noRecord ? 'border-[var(--warn)] bg-[var(--warn-bg)]' : 'border-[#326273]/10 bg-white'}`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${m.direction === 'IN' ? 'bg-[var(--ok-bg)] text-[var(--ok)]' : 'bg-[#0C3E48]/8 text-[#0C3E48]'}`}
                >
                  {noRecord ? <AlertTriangle className="h-3.5 w-3.5 text-[#8b6418]" /> : m.direction === 'IN' ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold text-[#1F4452]" title={m.counterparty ?? undefined}>{m.label}</span>
                    <span className={`shrink-0 font-mono tabular-nums ${m.direction === 'IN' ? 'text-[#1F4452]' : 'text-[#1F4452]'}`}>
                      <span className="sr-only">{m.direction === 'IN' ? 'received' : 'sent'} </span>
                      {m.direction === 'IN' ? '+' : '−'}{amount}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[12px] text-[#326273]/90">
                    <span>
                      {when(m.timestamp)}
                      {!m.success ? ' · failed on chain' : ''}
                      {m.feeMinor ? ` · includes ${formatUsdc(BigInt(m.feeMinor))} Splash fee` : ''}
                    </span>
                    <a href={m.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-semibold text-[var(--info)] hover:underline">
                      Suiscan <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {movements.length > 0 && notice ? <p className="mt-2 text-[12px] text-[#8b6418]" role="alert">{notice}</p> : null}
      {olderCursor ? (
        <button type="button" onClick={() => void loadOlder()} disabled={busy !== null} className="dash-btn-ghost mt-3 inline-flex min-h-10 items-center gap-1.5 !px-3 !py-1.5 !text-[13px] disabled:opacity-50">
          {busy === 'older' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Show older
        </button>
      ) : null}
    </section>
  );
}
