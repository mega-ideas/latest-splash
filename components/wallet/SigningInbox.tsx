'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Clock3, PenLine } from 'lucide-react';

import { usePhone } from '@/components/dashboard/Device';

import type { SigningView } from '@/components/transfer/api';
import SignPanel from '@/components/transfer/SignPanel';
import { QuietButton } from '@/components/transfer/ui';
import { requestTitle } from '@/lib/wallet-page/labels';
import { WALLET_LABELS } from './SetupWallet';
import { Card, Loading, Note, useLoad } from './parts';

type Waiting = SigningView & { purpose: string; sender: string };

const hours = (iso: string, now: number) => {
  const left = new Date(iso).getTime() - now;
  if (!Number.isFinite(left) || left <= 0) return 'expires now';
  const h = Math.floor(left / 3_600_000);
  return h >= 1 ? `expires in ${h} hour${h === 1 ? '' : 's'}` : `expires in ${Math.max(1, Math.round(left / 60_000))} minutes`;
};

/**
 * Needs your signature (v2 brief 4.1, 5.5): wallet requests waiting on this
 * person, each with its exact bytes. Opening one decodes the bytes on this
 * device (reviewOnDevice) and shows the transaction code to compare with the
 * WhatsApp message; nothing is signed from a summary the server wrote.
 */
export default function SigningInbox({ onChanged }: { onChanged: () => void }) {
  const inbox = useLoad<{ requests: Waiting[] }>('/api/wallet/signing-requests', 'Your requests could not be loaded.');
  const [openId, setOpenId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  // On a phone a request opens on the Approve screen, which is for nothing else (v2 brief 5.10).
  const phone = usePhone();

  if (inbox.loading) return <Card id="needs-signature" title="Needs your signature"><Loading label="Looking for requests…" /></Card>;
  if (!inbox.data) return <Card id="needs-signature" title="Needs your signature"><Note tone="error">{inbox.error}</Note></Card>;
  const waiting = inbox.data.requests.filter((r) => r.status === 'collecting' && r.you.mustSign && !r.you.signed && !r.you.declined);
  if (waiting.length === 0) return null;

  return (
    <Card id="needs-signature" title="Needs your signature" aside={<span className="text-[13px] font-semibold text-[#1F4452]">{waiting.length} waiting</span>}>
      <ul className="space-y-3">
        {waiting.map((r) => {
          const open = openId === r.id;
          return (
            <li key={r.id} className="rounded-xl border border-[#326273]/15 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[#0c3e48]">{requestTitle(r.purpose)}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[#326273]"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{r.signedWeight} of {r.threshold} signed, {hours(r.expiresAt, now)}</p>
                </div>
                {phone ? (
                  <Link href={`/dashboard/approve/${encodeURIComponent(r.id)}`} className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
                    <PenLine className="h-4 w-4" aria-hidden="true" />
                    Review and sign
                  </Link>
                ) : (
                  <QuietButton type="button" aria-expanded={open} onClick={() => setOpenId(open ? null : r.id)}>
                    <PenLine className="h-4 w-4" aria-hidden="true" />
                    {open ? 'Close' : 'Review and sign'}
                  </QuietButton>
                )}
              </div>
              {open && !phone ? (
                <div className="mt-3">
                  <SignPanel
                    initial={r}
                    labels={WALLET_LABELS}
                    onExecuted={() => {
                      setOpenId(null);
                      inbox.reload();
                      onChanged();
                    }}
                    onRestart={() => setOpenId(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
