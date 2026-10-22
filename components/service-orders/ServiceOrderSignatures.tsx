'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Clock, KeyRound, Loader2, PenLine } from 'lucide-react';

import { serviceOrderWindow, type SignatureParty } from '@/lib/sui/service-orders';
import {
  connectWallet,
  describeSignError,
  discoverWallets,
  signWithPasskey,
  type AcceptedWallet,
} from '@/lib/wallet/sui-signers';

/**
 * WS3. A payout Splash funds needs three signatures by three parties, and
 * this says plainly which of them exist.
 *
 *   1. the member who created the payment signs the order, in their wallet
 *   2. a different approver of the account signs the approval
 *   3. Splash's operator pays, only after 1 and 2, exactly what was approved
 *
 * The time left is the contract's: the server reads `expires_at` off the
 * intent on chain and this only counts down to it. No window is assumed here.
 */

type OrderView = {
  id: string;
  transferId: string;
  state: 'AWAITING_ORDER_SIGNATURE' | 'AWAITING_APPROVAL' | 'SETTLING' | 'SETTLED' | 'FAILED';
  recipientLabel: string;
  amountMinor: string;
  targetCurrency: string;
  intentId: string | null;
  makerUserId: string;
  signatures: SignatureParty[];
  window: { totalMs: number } | null;
  expiresAtMs: number | null;
  failureReason: string | null;
};

type Passkey = { address: string; publicKey: string; rpId: string };
type Listing = {
  viewer: { userId: string };
  orders: OrderView[];
  passkeys: Passkey[];
  now: number;
  /** The server's clock minus this one, so a skewed laptop clock does not move
   *  the boundary. The contract's own clock still decides; this is a display. */
  offset: number;
};
type Signer =
  | { kind: 'passkey'; label: string; address: string; passkey: Passkey }
  | { kind: 'wallet'; label: string; wallet: AcceptedWallet };

function usd(minor: string) {
  const value = BigInt(minor);
  const whole = value / 1_000_000n;
  const cents = (value % 1_000_000n) / 10_000n;
  return `USD ${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}

type StdAccount = { address: string; chains: readonly string[] };

/** Sign the exact bytes Splash built, on the network the order lives on. */
async function signWithStandardWallet(accepted: AcceptedWallet, account: StdAccount, bytes: string, network: string) {
  const { Transaction } = await import('@mysten/sui/transactions');
  const { fromBase64 } = await import('@mysten/sui/utils');
  const json = await Transaction.from(fromBase64(bytes)).toJSON();
  const feature = accepted.wallet.features['sui:signTransaction'] as {
    signTransaction(input: { transaction: { toJSON(): Promise<string> }; account: StdAccount; chain: string }): Promise<{ bytes: string; signature: string }>;
  };
  return feature.signTransaction({ transaction: { toJSON: async () => json }, account, chain: `sui:${network}` });
}

function Countdown({ order, offset }: { order: OrderView; offset: number }) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() + offset), 1000);
    return () => window.clearInterval(timer);
  }, [offset]);
  if (order.expiresAtMs === null || !order.window) {
    return <span className="text-[13px] font-medium text-[#326273]/90">The window starts when the order is signed.</span>;
  }
  const left = serviceOrderWindow({ createdAtMs: order.expiresAtMs - order.window.totalMs, expiresAtMs: order.expiresAtMs }, now);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[13px] font-bold tabular-nums ${left.expired ? 'text-[var(--error)]' : 'text-[#1F4452]'}`}
      aria-live="off"
    >
      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
      {left.expired ? 'Window closed. Nothing moved; create the payment again.' : `${left.label} to approve`}
    </span>
  );
}

function PartyRow({ party }: { party: SignatureParty }) {
  return (
    <li className="flex items-start gap-2.5">
      {party.signed ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ok)]" aria-hidden="true" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[#326273]" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <p className="text-[13px] font-bold text-[#1F4452]">{party.title}</p>
        <p className="truncate text-[12px] font-medium text-[#326273]/90">
          {party.label}
          {party.digest ? <span className="font-mono"> ({party.digest.slice(0, 10)}…)</span> : null}
        </p>
      </div>
    </li>
  );
}

function OrderCard({
  order,
  viewerId,
  signers,
  offset,
  onChanged,
}: {
  order: OrderView;
  viewerId: string;
  signers: Signer[];
  offset: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const step = order.state === 'AWAITING_ORDER_SIGNATURE' ? 'order' : order.state === 'AWAITING_APPROVAL' ? 'approve' : null;
  // Who may sign what. The server and the chain enforce both; this only
  // avoids offering a button that would be refused.
  const mine = order.makerUserId === viewerId;
  const canSign = step === 'order' ? mine : step === 'approve' ? !mine : false;
  const waitingOn =
    step === 'order' && !mine ? 'Waiting for the member who created it to sign the order.'
      : step === 'approve' && mine ? 'You ordered this payment, so a different approver must sign it.'
        : null;

  async function sign(signer: Signer) {
    if (!step) return;
    setBusy(true);
    setMessage(null);
    try {
      let address: string;
      let signed: { bytes: string; signature: string };
      const build = async (signerAddress: string) => {
        const response = await fetch('/api/service-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'build', orderId: order.id, step, signer: signerAddress }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `Splash could not compose the transaction (HTTP ${response.status}).`);
        return body as { bytes: string; network: string };
      };
      if (signer.kind === 'passkey') {
        address = signer.address;
        const built = await build(address);
        signed = await signWithPasskey(signer.passkey, built.bytes);
      } else {
        const account = await connectWallet(signer.wallet);
        address = account.address;
        const built = await build(address);
        signed = await signWithStandardWallet(signer.wallet, account, built.bytes, built.network);
      }
      const response = await fetch('/api/service-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', orderId: order.id, step, bytes: signed.bytes, signature: signed.signature }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `Splash refused the signature (HTTP ${response.status}). Nothing moved.`);
      setMessage(step === 'order' ? 'Order signed. A second approver signs next.' : 'Approved. Splash has paid it.');
      onChanged();
    } catch (error) {
      setMessage(describeSignError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 px-4 py-4 md:grid-cols-[1.1fr_1.3fr_1fr]">
      <div className="min-w-0">
        <strong className="block truncate text-sm text-[#1F4452]">{order.recipientLabel}</strong>
        <p className="money mt-1 text-sm font-medium text-[#1F4452]">{usd(order.amountMinor)} to {order.targetCurrency}</p>
        <div className="mt-2">
          <Countdown order={order} offset={offset} />
        </div>
      </div>
      <ol className="flex flex-col gap-2" aria-label="Signatures">
        {order.signatures.map((party) => (
          <PartyRow key={party.role} party={party} />
        ))}
      </ol>
      <div className="flex flex-col gap-1.5 md:items-end">
        {canSign && signers.length === 0 && (
          <p className="text-[12px] font-semibold text-[#326273]/90 md:text-right">
            Enrol a Splash passkey or connect a Sui wallet to sign.
          </p>
        )}
        {canSign &&
          signers.map((signer) => (
            <button
              key={signer.kind === 'passkey' ? signer.address : signer.wallet.label}
              type="button"
              onClick={() => void sign(signer)}
              disabled={busy}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#1F4452] px-4 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-ring disabled:cursor-not-allowed disabled:opacity-45 md:w-auto"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : signer.kind === 'passkey' ? <KeyRound className="h-4 w-4" aria-hidden="true" /> : <PenLine className="h-4 w-4" aria-hidden="true" />}
              {step === 'order' ? 'Sign order' : 'Sign approval'} with {signer.label}
            </button>
          ))}
        {waitingOn && <p className="text-[12px] font-semibold text-[#326273]/90 md:text-right">{waitingOn}</p>}
        {order.state === 'SETTLING' && <p className="text-[12px] font-semibold text-[#326273]/90 md:text-right">Approved. Splash is paying it now.</p>}
        {order.failureReason && <p className="text-[12px] font-semibold text-[var(--error)] md:text-right">{order.failureReason}</p>}
        {message && <p role="status" className="text-[12px] font-semibold text-[#1F4452] md:text-right">{message}</p>}
      </div>
    </div>
  );
}

/**
 * This workspace's service orders in flight. On the transfer screen pass the
 * order just created; in the approval queue pass nothing and see them all.
 */
export default function ServiceOrderSignatures({ orderId }: { orderId?: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<AcceptedWallet[]>([]);
  // Bumped after a signature lands, so the list reloads at once.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/service-orders', { cache: 'no-store' });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setListing({ ...(body as Omit<Listing, 'offset'>), offset: (body as Listing).now - Date.now() });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load service orders.');
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reloads]);

  useEffect(() => {
    void discoverWallets().then(setWallets).catch(() => setWallets([]));
  }, []);

  if (error) return <p className="text-[13px] font-semibold text-[var(--error)]">Signatures could not be loaded: {error}</p>;
  if (!listing) return <div className="h-24 animate-pulse rounded-lg bg-white/60" aria-label="Loading signatures" />;

  const orders = orderId ? listing.orders.filter((order) => order.id === orderId) : listing.orders;
  if (orders.length === 0) return null;

  const signers: Signer[] = [
    ...listing.passkeys.map((passkey) => ({ kind: 'passkey' as const, label: 'Splash passkey', address: passkey.address, passkey })),
    ...wallets.map((wallet) => ({ kind: 'wallet' as const, label: wallet.label, wallet })),
  ];

  return (
    <section aria-labelledby="service-orders-title" className="overflow-hidden rounded-lg border border-[#326273]/20 bg-white/85">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/10 px-4 py-3">
        <h2 id="service-orders-title" className="text-sm font-bold text-[#1F4452]">
          Payments waiting for signatures
        </h2>
        <p className="text-[13px] font-medium text-[#326273]/90">
          Two members sign before Splash pays. Nothing moves until both have.
        </p>
      </div>
      <div className="divide-y divide-[#326273]/10">
        {orders.map((order) => (
          <OrderCard key={order.id} order={order} viewerId={listing.viewer.userId} signers={signers} offset={listing.offset} onChanged={() => setReloads((n) => n + 1)} />
        ))}
      </div>
    </section>
  );
}
