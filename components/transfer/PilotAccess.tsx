'use client';

import { useState } from 'react';

import { BANK_COUNTRIES } from '@/lib/transfer/payee';
import { call } from './api';
import { PrimaryButton, TextInput } from './ui';

/**
 * A corridor that is not live yet is under Pilot access: a request for access
 * (an email), never a quote or a payment. Shared by the desktop form and the
 * phone's questions.
 */
export default function PilotAccess({ country }: { country: string }) {
  const [request, setRequest] = useState<{ email: string; state: 'idle' | 'sending' | 'sent' | 'failed' }>({ email: '', state: 'idle' });

  async function requestAccess() {
    setRequest((r) => ({ ...r, state: 'sending' }));
    const answer = await call('/api/waitlist', { body: { email: request.email, source: `pilot-${country}` } });
    setRequest((r) => ({ ...r, state: answer.ok ? 'sent' : 'failed' }));
  }

  return (
    <div className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4">
      <p className="text-sm font-bold text-[#0c3e48]">{BANK_COUNTRIES.find((c) => c.country === country)?.name} is under Pilot access.</p>
      <p className="mt-1 text-[13px] leading-5 text-[#1F4452]">There is no quote or payment to {country} yet. Leave an email and we will contact you when your business can use it.</p>
      {request.state === 'sent' ? (
        <p role="status" className="mt-3 text-sm font-semibold text-[#145d6a]">Thanks. We will be in touch.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <TextInput type="email" autoComplete="email" aria-label="Work email" placeholder="you@company.com" value={request.email} onChange={(e) => setRequest({ email: e.target.value, state: 'idle' })} />
          </div>
          <PrimaryButton type="button" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email) || request.state === 'sending'} onClick={() => void requestAccess()}>
            {request.state === 'sending' ? 'Sending…' : 'Request access'}
          </PrimaryButton>
        </div>
      )}
      {request.state === 'failed' ? <p role="alert" className="mt-2 text-[13px] font-medium text-[var(--error)]">That did not go through. Try again.</p> : null}
    </div>
  );
}
