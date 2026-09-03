import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Badge, Card, Stat } from '@/components/system';
import DataTable from '@/components/site/DataTable';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { brand } from '@/lib/brand';
import { formatInstant } from '@/lib/format/time';
import { getNetworkProfile } from '@/lib/network';
import { EVENT_NAMES, listEvents, type EventName } from '@/lib/server/events';

export const metadata: Metadata = {
  title: `Metrics — ${brand.name}`,
  description: 'Operating metrics from server-side money-state events. Published only when live.',
};

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 30;

const LABELS: Partial<Record<EventName, string>> = {
  session_started: 'Agent sessions',
  action_proposed: 'Proposals prepared',
};

/**
 * /metrics — behind NEXT_PUBLIC_METRICS_LIVE (default off). Reads the same
 * server-side product events the retention admin uses (hashed ids, no
 * amounts in the clear), aggregated over the last 30 days. Off = 404, so
 * nothing half-true is ever indexable.
 */
/** Data loading lives outside the component so render stays pure. */
async function loadWindow() {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const events = await listEvents({ since });
  return { now, events };
}

export default async function MetricsPage() {
  if (process.env.NEXT_PUBLIC_METRICS_LIVE !== 'true') notFound();

  const { now, events } = await loadWindow();
  const { badges, live, corridors } = getNetworkProfile();

  const byName = new Map<string, number>();
  const byCorridor = new Map<string, number>();
  const orgs = new Set<string>();
  for (const event of events) {
    byName.set(event.name, (byName.get(event.name) ?? 0) + 1);
    if (event.corridor) byCorridor.set(event.corridor, (byCorridor.get(event.corridor) ?? 0) + 1);
    if (event.orgHash) orgs.add(event.orgHash);
  }

  const rows = EVENT_NAMES.filter((name) => byName.has(name)).map((name) => ({
    id: name,
    event: LABELS[name] ?? name.replace(/_/g, ' '),
    key: <code className="font-mono text-[12px]">{name}</code>,
    count: byName.get(name) ?? 0,
  }));

  return (
    <SiteShell>
      <PageHeader line1="Operating metrics." line2={`Last ${WINDOW_DAYS} days, from money-state events.`} lede="Counts come from server-side events emitted at state transitions — never from the client. Identifiers are hashed; amounts are not published here.">
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge tone={live ? 'green' : 'amber'}>{badges.live ?? badges.network}</Badge>
          <span className="font-mono text-[12px] text-[var(--text-muted)]">as of {formatInstant(now.toISOString())}</span>
        </div>
      </PageHeader>
      <PageBody>
        <section aria-label="Headline figures" className="grid gap-4 sm:grid-cols-3">
          <Card>
            <Stat label="Events recorded" value={String(events.length)} sub={`${WINDOW_DAYS}-day window`} />
          </Card>
          <Card>
            <Stat label="Active organisations" value={String(orgs.size)} sub="hashed, distinct" />
          </Card>
          <Card>
            <Stat label="Corridors touched" value={`${byCorridor.size} / ${corridors.length}`} sub={corridors.map((corridor) => corridor.currency).join(' · ')} />
          </Card>
        </section>

        {rows.length > 0 ? (
          <DataTable
            caption="Events by name"
            columns={[
              { key: 'event', header: 'Event' },
              { key: 'key', header: 'Key' },
              { key: 'count', header: 'Count', align: 'right', mono: true },
            ]}
            rows={rows}
            footnote="Server-side only. Client-originated events are limited to the allowlist in lib/server/events.ts and never move a money state."
          />
        ) : (
          <div className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-6 text-[15px] text-[var(--text-2)]">No events in the window yet.</div>
        )}
      </PageBody>
    </SiteShell>
  );
}
