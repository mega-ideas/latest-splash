'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Pay an invoice in USDC on Sui, straight to the issuer's own wallet.
 *
 * Splash never holds the money: the address is the issuer's Splash wallet
 * (their passkey's address). The amount carries a few extra millionths that
 * identify this invoice, so the payer is asked to send it exactly; "check"
 * reads the issuer's wallet from chain and records the transfer that matches
 * (lib/server/usdc-invoice-payments.ts).
 */

export type PublicUsdc = {
  paid: { digest: string; explorerUrl: string; paidAt: string | null } | null;
  terms: { address: string; amount: string } | null;
} | null;

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'paid'; explorerUrl: string }
  | { kind: 'message'; tone: 'wait' | 'problem'; text: string };

export default function PayWithUsdc({ slug, issuer, usdc }: { slug: string; issuer: string; usdc: PublicUsdc }) {
  const [check, setCheck] = useState<Check>(usdc?.paid ? { kind: 'paid', explorerUrl: usdc.paid.explorerUrl } : { kind: 'idle' });

  if (!usdc || (!usdc.paid && !usdc.terms)) return null;

  async function copy(value: string, what: string) {
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  }

  async function checkPayment() {
    setCheck({ kind: 'checking' });
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(slug)}/usdc`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { status?: string; explorerUrl?: string; reason?: string; error?: string };
      if (body.status === 'PAID' && body.explorerUrl) return setCheck({ kind: 'paid', explorerUrl: body.explorerUrl });
      if (body.status === 'NOT_SEEN') {
        return setCheck({
          kind: 'message',
          tone: 'wait',
          text: `Not seen yet. Transfers on Sui land within seconds — if you have just sent it, check again in a moment. If you sent a different amount, tell ${issuer} so they can match it by hand.`,
        });
      }
      if (body.status === 'ALREADY_USED') {
        return setCheck({ kind: 'message', tone: 'problem', text: `That transfer already paid a different invoice. Contact ${issuer}.` });
      }
      if (body.status === 'NO_WALLET') {
        return setCheck({ kind: 'message', tone: 'problem', text: `${issuer} can't receive USDC here right now. Pay by bank transfer instead.` });
      }
      const reason = body.reason ?? body.error ?? `the check failed (${res.status})`;
      setCheck({ kind: 'message', tone: 'problem', text: `Couldn't check Sui just now: ${reason} Try again shortly.` });
    } catch {
      setCheck({ kind: 'message', tone: 'problem', text: 'Couldn’t reach Splash. Check your connection and try again.' });
    }
  }

  return (
    <section aria-labelledby="pay-usdc-title" className="mt-7 border-t border-foreground/10 pt-6">
      <h2 id="pay-usdc-title" className="text-xl font-black">Or pay in USDC on Sui</h2>
      <p className="mt-1 text-sm text-foreground/60">
        Straight to {issuer}&rsquo;s own wallet — Splash never holds it.
      </p>

      {check.kind === 'paid' ? (
        <div role="status" className="mt-4 flex items-start gap-3 rounded-xl border border-[var(--ok)]/30 bg-[var(--ok-bg)] p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ok)]" aria-hidden="true" />
          <div>
            <strong className="block text-[var(--ink)]">Paid in USDC — verified on Sui</strong>
            <a href={check.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm font-bold text-[var(--ok)] hover:underline">
              View the transfer on Suiscan <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      ) : usdc.terms ? (
        <>
          <div className="mt-4 space-y-3">
            <button type="button" onClick={() => void copy(usdc.terms!.amount, 'Amount')} className="flex w-full items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/10 p-3 text-left">
              <span className="min-w-0">
                <small className="block uppercase tracking-wide text-foreground/45">Send exactly</small>
                <strong className="font-mono text-lg tabular-nums">{usdc.terms.amount} USDC</strong>
                <small className="mt-0.5 block text-foreground/55">The last digits identify this invoice — send every one of them.</small>
              </span>
              <Copy className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span className="sr-only">Copy amount</span>
            </button>
            <button type="button" onClick={() => void copy(usdc.terms!.address, 'Address')} className="flex w-full items-center justify-between gap-3 rounded-xl bg-muted/50 p-3 text-left">
              <span className="min-w-0">
                <small className="block uppercase tracking-wide text-foreground/45">To {issuer}&rsquo;s Sui wallet</small>
                <strong className="block break-all font-mono text-[13px]">{usdc.terms.address}</strong>
              </span>
              <Copy className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="sr-only">Copy address</span>
            </button>
          </div>
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-foreground/65">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" aria-hidden="true" />
            Native USDC on Sui mainnet only. USDC on another network, or any other token, will not arrive.
          </p>
          <button
            type="button"
            onClick={() => void checkPayment()}
            disabled={check.kind === 'checking'}
            className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 font-black text-card disabled:opacity-60"
          >
            {check.kind === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {check.kind === 'checking' ? 'Checking Sui…' : 'I’ve sent it — check'}
          </button>
          <div aria-live="polite">
            {check.kind === 'message' ? (
              <p className={`mt-3 text-[13px] leading-relaxed ${check.tone === 'problem' ? 'text-[var(--warn)]' : 'text-foreground/70'}`}>{check.text}</p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
