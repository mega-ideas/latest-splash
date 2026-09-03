import type { Metadata } from 'next';

import { Button, Chip } from '@/components/system';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Docs — ${brand.name}`,
  description: 'The customer API behind the payment desk: quotes, transfers, batches, recipients, receipts, proposals.',
};

/** Every route here exists under app/api; the desk uses the same ones. */
const ENDPOINTS: Array<{ group: string; items: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; purpose: string }> }> = [
  {
    group: 'Quotes and transfers',
    items: [
      { method: 'POST', path: '/api/quotes', purpose: 'Price a payout: amount, target currency, recipient, funding tier. Quotes hold for 30 seconds.' },
      { method: 'POST', path: '/api/rate-holds', purpose: 'Hold a rate for a later transfer.' },
      { method: 'POST', path: '/api/funding/sessions', purpose: 'Open a fiat funding session (bank USD or held balance).' },
      { method: 'POST', path: '/api/transfers/authorize', purpose: 'Authorize a payout against a quote; returns the transfer intent.' },
      { method: 'GET', path: '/api/transfers/{id}', purpose: 'Delivery state machine for one payout, including the Sui digest once settled.' },
      { method: 'GET', path: '/api/transfers?filter=pending|all', purpose: 'List payouts.' },
    ],
  },
  {
    group: 'Batches',
    items: [
      { method: 'POST', path: '/api/batches', purpose: 'Submit validated rows; settles in chunks, each chunk one atomic transaction.' },
      { method: 'GET', path: '/api/batches/{id}', purpose: 'Per-row and per-chunk state, one digest per chunk.' },
    ],
  },
  {
    group: 'Recipients and receipts',
    items: [
      { method: 'GET', path: '/api/recipients', purpose: 'Verified counterparties.' },
      { method: 'POST', path: '/api/recipients', purpose: 'Add a counterparty (starts unverified; KYB completes before first payout).' },
      { method: 'DELETE', path: '/api/recipients/{id}', purpose: 'Remove a counterparty. Past receipts keep their record.' },
      { method: 'POST', path: '/api/receipts/share', purpose: 'Mint a read-only receipt link for a transaction party.' },
    ],
  },
  {
    group: 'Approvals and the agent',
    items: [
      { method: 'GET', path: '/api/proposals?scope=open|history', purpose: 'Unsigned proposals awaiting a human, or the decided ones.' },
      { method: 'POST', path: '/api/proposals/{id}/submit', purpose: 'The one path that approves or rejects. Bound to the approval hash the reviewer saw.' },
      { method: 'POST', path: '/api/oxwal', purpose: `Start a ${brand.agentName} run; streams server-sent events with sequence ids.` },
      { method: 'GET', path: '/api/oxwal/{runId}?after={seq}', purpose: 'Resume a run after a dropped connection.' },
      { method: 'GET', path: '/api/settings', purpose: 'Operating controls the approval path enforces (PUT to change).' },
    ],
  },
];

const METHOD_TONE: Record<string, string> = {
  GET: 'text-[var(--green-700)] bg-[var(--green-100)]',
  POST: 'text-[var(--teal-600)] bg-[var(--teal-100)]',
  PUT: 'text-[var(--amber-700)] bg-[var(--amber-100)]',
  DELETE: 'text-[var(--red-600)] bg-[var(--red-100)]',
};

export default function DocsPage() {
  return (
    <SiteShell>
      <PageHeader line1="The API behind the desk." line2="Same routes, same guards, same proofs." lede="Every call is scoped to the signed-in workspace by a session cookie; identity and organisation are derived server-side and never accepted from the request body. Money moves only through the approval path.">
        <div className="mt-6 flex flex-wrap gap-2">
          <Button href="/sandbox">Try the sandbox</Button>
          <Button href="/api/openapi" variant="ghost" external>
            Admin OpenAPI (YAML)
          </Button>
        </div>
      </PageHeader>
      <PageBody>
        <section aria-labelledby="auth-title" className="grid gap-3 rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-6">
          <h2 id="auth-title" className="text-[20px] font-semibold">Authentication</h2>
          <p className="text-[14px] leading-[1.6] text-[var(--text-2)]">
            Sign in with <code className="font-mono">POST /api/auth/login</code> to receive an HMAC-signed session cookie. State-changing requests must originate from the workspace address (origin check) and must not carry authority-shaped fields such as an organisation or actor id; those are provenance violations and are rejected.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Chip>session cookie</Chip>
            <Chip>origin-checked</Chip>
            <Chip>server-derived authority</Chip>
          </div>
        </section>

        {ENDPOINTS.map((group) => (
          <section key={group.group} aria-labelledby={`group-${group.group}`} className="grid gap-3">
            <h2 id={`group-${group.group}`} className="text-[clamp(1.5rem,4vw,1.75rem)] font-semibold tracking-[-0.02em]">
              {group.group}
            </h2>
            <ul className="divide-y divide-[var(--divider)] overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--surface)]">
              {group.items.map((item) => (
                <li key={`${item.method} ${item.path}`} className="grid gap-1 p-4 md:grid-cols-[72px_minmax(0,1fr)_1.4fr] md:items-baseline md:gap-4">
                  <span className={`inline-flex h-6 w-fit items-center rounded-[6px] px-2 font-mono text-[11px] font-semibold ${METHOD_TONE[item.method]}`}>{item.method}</span>
                  <code className="break-all font-mono text-[13px]">{item.path}</code>
                  <p className="text-[14px] text-[var(--text-2)]">{item.purpose}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="rounded-[16px] bg-[var(--surface-2)] p-6 text-[14px] leading-[1.6] text-[var(--text-2)]">
          <h2 className="text-[17px] font-semibold text-[var(--text)]">Streaming</h2>
          <p className="mt-2">
            <code className="font-mono">/api/oxwal</code> responds with <code className="font-mono">text/event-stream</code>. Each frame carries <code className="font-mono">id: &lt;seq&gt;</code>; reconnect with <code className="font-mono">{'GET /api/oxwal/{runId}?after=<seq>'}</code> and the server replays what you missed, then continues. Runs are scoped to the organisation that started them.
          </p>
        </section>
      </PageBody>
    </SiteShell>
  );
}
