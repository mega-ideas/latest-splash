'use client';

import { BookOpen, KeyRound } from 'lucide-react';

import CopyBlock from '@/components/landing-v2/CopyBlock';
import { PageHeader } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { Button } from '@/components/system';
import { brand } from '@/lib/brand';
import { getNetworkProfile } from '@/lib/network';

const REQUEST = `POST /api/transfers/authorize
Cookie: splash_session=<workspace session>
Content-Type: application/json

{
  "quoteId": "qte_2f9a…",
  "recipientId": "rec_7c1e…",
  "paymentRail": "bank",
  "fundingSessionId": "fs_91b0…"
}`;

const RESPONSE = `201 Created
{
  "id": "ti_5d02…",
  "state": "AUTHORIZED",
  "targetCurrency": "PHP",
  "targetAmount": "282100.00",
  "sourceAmountUsd": "5000.00",
  "suiTxDigest": null,
  "links": { "self": "/api/transfers/ti_5d02…" }
}`;

const EVENTS = ['payment.authorized', 'payment.settled', 'payment.delivered', 'payment.returned', 'proposal.created', 'proposal.approved', 'receipt.anchored'];

/**
 * Developers: the clearance lifecycle as an API. Everything shown exists
 * today behind the workspace session; API keys, HMAC-signed webhooks and
 * rate limits are roadmap-chipped rather than pretended.
 */
export default function DevelopersPage() {
  const { badges, live } = getNetworkProfile();
  return (
    <>
      <PageHeader
        title="Developers"
        supporting="Build payment clearance into your product."
        actions={
          <>
            <Button href="/docs" variant="secondary">
              <BookOpen aria-hidden="true" /> Open documentation
            </Button>
            <Button disabled>
              <KeyRound aria-hidden="true" /> Create API key
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="quickstart" className="border border-[var(--border-default)] bg-[var(--surface-raised)]">
          <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
            <h2 id="quickstart" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Quick start</h2>
            <StatusLabel compact tone={live ? 'verified' : 'attention'}>{live ? 'Live' : 'Sandbox'}</StatusLabel>
          </div>
          <ol className="grid divide-y divide-[var(--border-default)] text-[13px]">
            {[
              ['Sign in', 'POST /api/auth/login returns the HMAC-signed workspace session cookie. Sandbox credentials are on /sandbox.'],
              ['Verify a beneficiary', 'POST /api/recipients creates the record; KYB completes before a first payout clears screening.'],
              ['Price', 'POST /api/quotes returns an executable quote that holds for 30 seconds with its source and expiry.'],
              ['Create the proposal', 'POST /api/transfers/authorize binds the quote, recipient and funding session. Creation does not move funds.'],
              ['Approve', 'POST /api/proposals/{id}/submit is the only path that approves — bound to the approval hash the checker saw.'],
              ['Trace', 'GET /api/transfers/{id} returns the delivery state machine and the Sui digest once settled; /api/receipts/share mints a read-only receipt.'],
            ].map(([title, body], index) => (
              <li key={title} className="grid grid-cols-[36px_minmax(0,1fr)] gap-2 px-4 py-3">
                <span className="font-mono text-[12px] text-[var(--signal)]">0{index + 1}</span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="block text-[12.5px] text-[var(--text-2)]">{body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 border-t border-[var(--border-default)] p-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">Request</div>
              <pre className="overflow-x-auto border border-[var(--border-default)] bg-[var(--ink-900)] p-3 font-mono text-[11.5px] leading-[1.5] text-[var(--text-on-dark)]">{REQUEST}</pre>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">Response</div>
              <pre className="overflow-x-auto border border-[var(--border-default)] bg-[var(--ink-900)] p-3 font-mono text-[11.5px] leading-[1.5] text-[var(--text-on-dark)]">{RESPONSE}</pre>
            </div>
          </div>
        </section>

        <div className="grid content-start gap-4">
          <section aria-labelledby="keys" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="keys" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">API keys</h2>
            <p className="mt-2 text-[13px] text-[var(--text-2)]">Programmatic keys, scopes and rotation arrive with the developer console. Today the API is addressed with the workspace session.</p>
            <div className="mt-2"><RoadmapChip detail="developer console after first live corridor" /></div>
          </section>
          <section aria-labelledby="health" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="health" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Environment</h2>
            <dl className="mt-2 grid gap-1.5 text-[12.5px]">
              <div className="flex justify-between gap-2"><dt className="text-[var(--text-2)]">Network</dt><dd className="font-mono">{badges.network}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-[var(--text-2)]">Base URL</dt><dd className="font-mono">{brand.siteUrl}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-[var(--text-2)]">Auth</dt><dd className="font-mono">session cookie · origin-checked</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-[var(--text-2)]">Rate limits</dt><dd className="font-mono">not enforced in sandbox</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-[var(--text-2)]">Idempotency</dt><dd className="font-mono">quote id + recipient bind a proposal</dd></div>
            </dl>
          </section>
          <section aria-labelledby="events" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="events" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Event stream</h2>
            <ul className="mt-2 grid gap-1 font-mono text-[12px]">
              {EVENTS.map((name) => (
                <li key={name} className="flex items-center justify-between border-b border-[var(--border-default)] py-1">
                  {name}
                  <span className="text-[10.5px] text-[var(--text-muted)]">server-side</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-[var(--text-2)]">Delivered today as server-side product events (see Audit log). Signed webhooks with HMAC-SHA256 are on the roadmap.</p>
          </section>
          <section aria-labelledby="sandbox" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="sandbox" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Verify the package</h2>
            <p className="mt-2 text-[12.5px] text-[var(--text-2)]">The mainnet package cannot hold customer funds. One command proves it.</p>
            <div className="mt-2"><CopyBlock command="npm run check:core" /></div>
          </section>
        </div>
      </div>
    </>
  );
}
