'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2, MessageSquare, ShieldAlert, Smartphone } from 'lucide-react';

/**
 * Where approval requests reach an approver, and in what form.
 *
 * ─── Why the choice is spelled out rather than labelled ─────────────────────
 *
 * The two modes are not fast-versus-slow. They authenticate different things.
 *
 * `code` sends a one-time code to WhatsApp which the approver types back into
 * Splash. Approving therefore needs the handset AND a live authenticated
 * session with an approver role — a stolen phone alone releases nothing.
 *
 * `reply` accepts APPROVE in the chat. It is faster, and it authenticates a
 * HANDSET rather than a person: whoever is holding the device can release a
 * payment. A phone left unlocked on a desk becomes an approver.
 *
 * An admin picking between these is making a security decision, so the
 * consequence is written next to each option instead of in documentation
 * nobody opens. `code` is the default for the reason stated above.
 *
 * ─── And the number is proved before it is used ─────────────────────────────
 *
 * Registering sends a code TO the number; it stays inert until that code comes
 * back. A single transposed digit otherwise routes every approval request to a
 * stranger's phone — silently, since the approver simply never gets asked.
 */

type ChannelState = { whatsapp: string | null; verified: boolean };

export default function ApprovalChannelCard({
  whatsappEnabled,
  approvalChannel,
  onChange,
}: {
  whatsappEnabled: boolean;
  approvalChannel: 'code' | 'reply';
  onChange: (patch: { whatsappEnabled?: boolean; approvalChannel?: 'code' | 'reply' }) => void;
}) {
  const [channel, setChannel] = useState<ChannelState | null>(null);
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/approvals/channel', { cache: 'no-store' });
        if (!response.ok) {
          // 403 is the honest answer for a viewer or maker: they do not approve
          // payments, so there is nothing to reach them about.
          setChannel({ whatsapp: null, verified: false });
          return;
        }
        const body = (await response.json()) as ChannelState;
        setChannel(body);
        if (body.whatsapp) setNumber(body.whatsapp);
      } catch {
        setChannel({ whatsapp: null, verified: false });
      }
    })();
  }, []);

  async function sendCode() {
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/approvals/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp: number }),
      });
      const body = (await response.json()) as { error?: string; message?: string; whatsapp?: string };
      if (!response.ok) {
        setNotice(body.error ?? 'That number could not be registered.');
        return;
      }
      setChannel({ whatsapp: body.whatsapp ?? number, verified: false });
      setAwaitingCode(true);
      setNotice(body.message ?? 'Check WhatsApp for your confirmation code.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode() {
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/approvals/channel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json()) as { error?: string; message?: string; whatsapp?: string };
      if (!response.ok) {
        setNotice(body.error ?? 'That code is not valid.');
        return;
      }
      setChannel({ whatsapp: body.whatsapp ?? number, verified: true });
      setAwaitingCode(false);
      setCode('');
      setNotice(body.message ?? 'Confirmed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dash-surface p-6">
      <div className="flex items-center gap-3">
        <MessageSquare className="text-[var(--info)]" />
        <div>
          <h2 className="text-xl font-bold text-[#326273]">Approvals on WhatsApp</h2>
          <p className="text-[13px] text-[#326273]/55">
            Where an approver is reached, and what they have to do to release a payment.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onChange({ whatsappEnabled: !whatsappEnabled })}
        aria-pressed={whatsappEnabled}
        className="mt-5 flex w-full items-center justify-between gap-3 rounded-xl border border-[#326273]/14 bg-white px-4 py-3 text-left transition hover:border-[#5C9EAD]/50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-bold text-[#1F4452]">Send approval requests to WhatsApp</span>
          <span className="mt-0.5 block text-[13px] font-medium text-[#326273]/55">
            Off means approvals happen only in the Splash approval queue.
          </span>
        </span>
        <span
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${whatsappEnabled ? 'bg-[#5C9EAD]' : 'bg-[#326273]/20'}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${whatsappEnabled ? 'left-[22px]' : 'left-0.5'}`}
          />
        </span>
      </button>

      {/* The security consequence sits next to the option, because choosing
          between these IS the security decision. */}
      <fieldset className="mt-4" disabled={!whatsappEnabled}>
        <legend className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#326273]/55">
          How an approver responds
        </legend>
        <div className="mt-2 space-y-2">
          <ChannelOption
            selected={approvalChannel === 'code'}
            disabled={!whatsappEnabled}
            onSelect={() => onChange({ approvalChannel: 'code' })}
            title="One-time code"
            recommended
            body="A code is sent to WhatsApp and typed back into Splash. Releasing a payment needs the phone and a signed-in approver account, so a stolen handset on its own releases nothing."
          />
          <ChannelOption
            selected={approvalChannel === 'reply'}
            disabled={!whatsappEnabled}
            onSelect={() => onChange({ approvalChannel: 'reply' })}
            title="Reply APPROVE or REJECT"
            body="Faster, and it proves possession of the handset rather than the identity of a person. Whoever is holding the phone can release the payment."
            caution
          />
        </div>
      </fieldset>

      <div className="mt-5 border-t border-[#326273]/10 pt-5">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-[var(--info)]" />
          <h3 className="text-sm font-bold text-[#1F4452]">Your number</h3>
          {channel?.verified && (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#5C9EAD]/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]">
              <Check className="h-3 w-3" /> Confirmed
            </span>
          )}
          {channel && channel.whatsapp && !channel.verified && (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#E39774]/20 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9A4A2D]">
              <ShieldAlert className="h-3 w-3" /> Not confirmed
            </span>
          )}
        </div>
        <p className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/55">
          An unconfirmed number is never used. Requests would otherwise go to whoever owns a
          mistyped number, and you would never know you had not been asked.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="tel"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            placeholder="+60102651678"
            className="min-w-[200px] flex-1 rounded-lg border border-[#326273]/16 bg-white px-3 py-2 font-mono text-sm text-[#1F4452] outline-none focus:border-[#5C9EAD] focus:ring-4 focus:ring-[#5C9EAD]/20"
          />
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={busy || number.trim().length < 6}
            className="inline-flex items-center gap-2 rounded-lg bg-[#1F4452] px-4 py-2 text-[13px] font-bold text-white transition hover:bg-[#326273] disabled:opacity-45"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {channel?.verified ? 'Change number' : 'Send code'}
          </button>
        </div>

        {awaitingCode && (
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="6-digit code"
              className="min-w-[160px] rounded-lg border border-[#326273]/16 bg-white px-3 py-2 font-mono text-sm tabular-nums text-[#1F4452] outline-none focus:border-[#5C9EAD] focus:ring-4 focus:ring-[#5C9EAD]/20"
            />
            <button
              type="button"
              onClick={() => void confirmCode()}
              disabled={busy || code.trim().length < 4}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1F4452] px-4 py-2 text-[13px] font-bold text-white transition hover:bg-[#326273] disabled:opacity-45"
            >
              Confirm
            </button>
          </div>
        )}

        {notice && (
          <p className="mt-2 rounded-lg border border-[#326273]/12 bg-[#F6F0ED] px-3 py-2 text-[13px] font-semibold leading-5 text-[#326273]">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

function ChannelOption({
  selected,
  disabled,
  onSelect,
  title,
  body,
  recommended = false,
  caution = false,
}: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  recommended?: boolean;
  caution?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full rounded-xl border px-4 py-3 text-left transition disabled:opacity-45 ${
        selected
          ? 'border-[#5C9EAD] bg-[#5C9EAD]/10 ring-2 ring-[#5C9EAD]/25'
          : 'border-[#326273]/14 bg-white hover:border-[#5C9EAD]/50'
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${selected ? 'border-[#0d6370]' : 'border-[#326273]/30'}`}
        >
          {selected && <span className="h-2 w-2 rounded-full bg-[#0d6370]" />}
        </span>
        <span className="text-sm font-bold text-[#1F4452]">{title}</span>
        {recommended && (
          <span className="rounded-md bg-[#5C9EAD]/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]">
            Default
          </span>
        )}
        {caution && (
          <span className="rounded-md bg-[#E39774]/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9A4A2D]">
            Weaker
          </span>
        )}
      </span>
      <span className="mt-1 block pl-6 text-[13px] font-medium leading-5 text-[#326273]/62">{body}</span>
    </button>
  );
}
