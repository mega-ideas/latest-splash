import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';

import { adminConsolePath } from '@/lib/admin-routing';
import { getAdminSession } from '@/lib/server/admin-auth';
import { listEvents, type EventName, type ProductEvent } from '@/lib/server/events';

export const dynamic = 'force-dynamic';

/**
 * D8 — retention console. Reads `product_events` (or the dev ring buffer)
 * and renders the five retention views as plain tables: cohort NVR,
 * activation funnel, five-lock adoption, corridor mix, 0xWal reliability.
 *
 * Every figure here is computed over hashed org ids — nothing on this page
 * can name a customer. Styling uses styles/tokens.css variables only.
 */

const DAY_MS = 86_400_000;
const WINDOW_OPTIONS = [30, 90, 180] as const;

const FUNNEL_STAGES: { name: EventName; label: string }[] = [
  { name: 'account_created', label: 'Account created' },
  { name: 'kyb_submitted', label: 'KYB submitted' },
  { name: 'kyb_approved', label: 'KYB approved' },
  { name: 'first_funding_received', label: 'First funding received' },
  { name: 'intent_created', label: 'Intent created' },
  { name: 'intent_settled', label: 'Intent settled' },
];

const FIVE_LOCKS: { name: EventName; label: string; lock: string }[] = [
  { name: 'policy_created', label: 'Approvals', lock: 'policy_created' },
  { name: 'recipient_reused', label: 'Recipients', lock: 'recipient_reused' },
  { name: 'batch_settled', label: 'Batch', lock: 'batch_settled' },
  { name: 'export_downloaded', label: 'Exports', lock: 'export_downloaded' },
  { name: 'action_approved', label: '0xWal', lock: 'action_approved' },
];

/* ── metrics (pure) ─────────────────────────────────────────────────────── */

function isoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function firstByOrg(events: ProductEvent[], name: EventName): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const event of events) {
    if (event.name !== name) continue;
    const seen = out.get(event.orgHash);
    if (!seen || event.occurredAt < seen) out.set(event.orgHash, event.occurredAt);
  }
  return out;
}

function distinctOrgs(events: ProductEvent[], name: EventName): Set<string> {
  const out = new Set<string>();
  for (const event of events) if (event.name === name) out.add(event.orgHash);
  return out;
}

type CohortRow = { week: string; signups: number; settled7: number; settled30: number; matured30: boolean };

function cohortNvr(events: ProductEvent[], now: Date): CohortRow[] {
  const signups = firstByOrg(events, 'account_created');
  const settled = firstByOrg(events, 'intent_settled');
  const rows = new Map<string, CohortRow>();
  for (const [org, signedUpAt] of signups) {
    const week = isoWeekStart(signedUpAt);
    const row = rows.get(week) ?? { week, signups: 0, settled7: 0, settled30: 0, matured30: false };
    row.signups += 1;
    const settledAt = settled.get(org);
    if (settledAt) {
      const lag = settledAt.getTime() - signedUpAt.getTime();
      if (lag >= 0 && lag <= 7 * DAY_MS) row.settled7 += 1;
      if (lag >= 0 && lag <= 30 * DAY_MS) row.settled30 += 1;
    }
    rows.set(week, row);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      // A cohort's 30-day window has closed once its week (7 days) plus 30 days is behind us.
      matured30: new Date(row.week).getTime() + 37 * DAY_MS <= now.getTime(),
    }))
    .sort((a, b) => (a.week < b.week ? 1 : -1));
}

type FunnelRow = { label: string; orgs: number; stepPct: number | null; topPct: number | null };

function activationFunnel(events: ProductEvent[]): FunnelRow[] {
  const top = distinctOrgs(events, FUNNEL_STAGES[0].name).size;
  let previous: number | null = null;
  return FUNNEL_STAGES.map((stage) => {
    const orgs = distinctOrgs(events, stage.name).size;
    const row: FunnelRow = {
      label: stage.label,
      orgs,
      stepPct: previous === null ? null : previous === 0 ? 0 : orgs / previous,
      topPct: top === 0 ? null : orgs / top,
    };
    previous = orgs;
    return row;
  });
}

type LockRow = { label: string; lock: string; orgs: number; share: number | null };

function fiveLockAdoption(events: ProductEvent[]): { total: number; rows: LockRow[]; allFive: number } {
  const total = new Set(events.map((event) => event.orgHash));
  const perLock = FIVE_LOCKS.map((lock) => ({ lock, orgs: distinctOrgs(events, lock.name) }));
  let allFive = 0;
  for (const org of total) if (perLock.every(({ orgs }) => orgs.has(org))) allFive += 1;
  return {
    total: total.size,
    allFive,
    rows: perLock.map(({ lock, orgs }) => ({
      label: lock.label,
      lock: lock.lock,
      orgs: orgs.size,
      share: total.size === 0 ? null : orgs.size / total.size,
    })),
  };
}

type CorridorRow = { corridor: string; settlements: number; share: number; orgs: number; usdMicro: bigint; otherCurrencies: number };

function corridorMix(events: ProductEvent[]): CorridorRow[] {
  const settled = events.filter((event) => event.name === 'intent_settled');
  const rows = new Map<string, CorridorRow & { orgSet: Set<string> }>();
  for (const event of settled) {
    const corridor = event.corridor ?? 'unknown';
    const row = rows.get(corridor) ?? { corridor, settlements: 0, share: 0, orgs: 0, usdMicro: BigInt(0), otherCurrencies: 0, orgSet: new Set<string>() };
    row.settlements += 1;
    row.orgSet.add(event.orgHash);
    if (event.amountMinor !== null) {
      if (event.currency === 'USD_MICRO') row.usdMicro += event.amountMinor;
      else row.otherCurrencies += 1;
    }
    rows.set(corridor, row);
  }
  return [...rows.values()]
    .map(({ orgSet, ...row }) => ({ ...row, orgs: orgSet.size, share: settled.length === 0 ? 0 : row.settlements / settled.length }))
    .sort((a, b) => b.settlements - a.settlements);
}

function oxwalReliability(events: ProductEvent[]) {
  const count = (name: EventName) => events.filter((event) => event.name === name).length;
  const sessions = count('session_started');
  const reconnects = count('stream_reconnect');
  return {
    sessions,
    reconnects,
    reconnectsPerSession: sessions === 0 ? null : reconnects / sessions,
    messages: count('message'),
    proposed: count('action_proposed'),
    approved: count('action_approved'),
  };
}

/* ── formatting ─────────────────────────────────────────────────────────── */

const pctFormat = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const intFormat = new Intl.NumberFormat('en-US');
const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const pct = (value: number | null) => (value === null ? '—' : pctFormat.format(value));
const int = (value: number) => intFormat.format(value);
// Display-only: bigint micro-USD → whole dollars without ever going through a float on the money path.
const usdFromMicro = (micro: bigint) => usdFormat.format(Number(micro / BigInt(1_000_000)));

/* ── page ───────────────────────────────────────────────────────────────── */

export default async function AdminRetentionPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const session = await getAdminSession();
  const headerStore = await headers();
  const hostname = headerStore.get('host');
  if (!session) redirect(adminConsolePath('/login', hostname));

  const params = await searchParams;
  const requested = Number(Array.isArray(params.days) ? params.days[0] : params.days);
  const days = (WINDOW_OPTIONS as readonly number[]).includes(requested) ? requested : 90;

  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const events = await listEvents({ since });

  const cohorts = cohortNvr(events, now);
  const funnel = activationFunnel(events);
  const locks = fiveLockAdoption(events);
  const corridors = corridorMix(events);
  const oxwal = oxwalReliability(events);
  const persisted = Boolean(process.env.DATABASE_URL);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="dash-surface p-6 md:p-8">
        <div className="grid gap-5 xl:grid-cols-[1fr_auto] xl:items-end">
          <div>
            <span className="dash-kicker">Retention</span>
            <h1 className="dash-title mt-2 text-4xl">Activation, cohorts and lock adoption</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6" style={muted}>
              Computed from <code style={mono}>product_events</code> over the last {days} days. Org and actor ids are
              stored as SHA-256 hashes; nothing here identifies a customer.
              {persisted ? ' Source: Postgres.' : ' Source: in-process ring buffer (DATABASE_URL is unset) — figures reset on restart.'}
            </p>
          </div>
          <nav aria-label="Window" className="flex gap-2">
            {WINDOW_OPTIONS.map((option) => (
              <Link
                key={option}
                href={`?days=${option}`}
                aria-current={option === days ? 'page' : undefined}
                className="rounded-full px-3 py-1 text-xs font-bold"
                style={option === days ? chipActive : chip}
              >
                {option}d
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric label="Events" value={int(events.length)} />
          <Metric label="Active orgs" value={int(locks.total)} />
          <Metric label="Signups" value={int(funnel[0]?.orgs ?? 0)} />
          <Metric label="Settled orgs" value={int(funnel[funnel.length - 1]?.orgs ?? 0)} />
        </div>
      </header>

      {events.length === 0 && (
        <p className="dash-block p-5 text-sm leading-6" style={muted}>
          No product events in this window yet. They are emitted server-side as customers sign up, pass KYB, fund, pay,
          approve and export; UI surfaces report through <code style={mono}>POST /api/events</code>.
        </p>
      )}

      <Section
        title="Cohort NVR"
        detail="Weekly signup cohorts (account_created) and the share that reached intent_settled within 7 and 30 days of signup."
      >
        <Table
          head={['Cohort week', 'Signups', 'Settled ≤ 7d', 'Settled ≤ 30d', '30-day window']}
          numeric={[false, true, true, true, false]}
          rows={cohorts.map((row) => [
            row.week,
            int(row.signups),
            `${int(row.settled7)} · ${pct(row.signups ? row.settled7 / row.signups : null)}`,
            `${int(row.settled30)} · ${pct(row.signups ? row.settled30 / row.signups : null)}`,
            row.matured30 ? 'closed' : 'still open',
          ])}
          empty="No signup cohorts in this window."
        />
      </Section>

      <Section
        title="Activation funnel"
        detail="Distinct orgs reaching each stage at least once. Step % is conversion from the previous stage; overall % is against account_created."
      >
        <Table
          head={['Stage', 'Orgs', 'Step conversion', 'Overall']}
          numeric={[false, true, true, true]}
          rows={funnel.map((row) => [row.label, int(row.orgs), pct(row.stepPct), pct(row.topPct)])}
          empty="No funnel events in this window."
        />
      </Section>

      <Section
        title="Five-lock adoption"
        detail={`Share of active orgs (any event in window) with at least one event per lock. ${int(locks.allFive)} of ${int(locks.total)} orgs have all five.`}
      >
        <Table
          head={['Lock', 'Signal', 'Orgs', 'Share of active orgs']}
          numeric={[false, false, true, true]}
          rows={locks.rows.map((row) => [row.label, <code key={row.lock} style={mono}>{row.lock}</code>, int(row.orgs), pct(row.share)])}
          empty="No active orgs in this window."
        />
      </Section>

      <Section
        title="Corridor mix"
        detail="intent_settled by corridor. Volume sums only events recorded in USD_MICRO; other currencies are counted, not summed."
      >
        <Table
          head={['Corridor', 'Settlements', 'Share', 'Orgs', 'Volume (USD)', 'Non-USD rows']}
          numeric={[false, true, true, true, true, true]}
          rows={corridors.map((row) => [
            <code key={row.corridor} style={mono}>{row.corridor}</code>,
            int(row.settlements),
            pct(row.share),
            int(row.orgs),
            usdFromMicro(row.usdMicro),
            int(row.otherCurrencies),
          ])}
          empty="No settled intents in this window."
        />
      </Section>

      <Section
        title="0xWal reliability"
        detail="Stream reconnects per started session; reconnects are reported by the chat client, sessions by the server."
      >
        <Table
          head={['Sessions started', 'Stream reconnects', 'Reconnects / session', 'Messages', 'Actions proposed', 'Actions approved']}
          numeric={[true, true, true, true, true, true]}
          rows={[[
            int(oxwal.sessions),
            int(oxwal.reconnects),
            oxwal.reconnectsPerSession === null ? '—' : oxwal.reconnectsPerSession.toFixed(2),
            int(oxwal.messages),
            int(oxwal.proposed),
            int(oxwal.approved),
          ]]}
          empty="No 0xWal sessions in this window."
        />
      </Section>
    </div>
  );
}

/* ── presentation ───────────────────────────────────────────────────────── */

const muted: CSSProperties = { color: 'var(--text-2)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: '0.8125em' };
const chip: CSSProperties = { background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--line)' };
const chipActive: CSSProperties = { background: 'var(--accent)', color: 'var(--surface)', border: '1px solid var(--accent)' };
const numeral: CSSProperties = { fontVariantNumeric: 'tabular-nums', textAlign: 'right' };

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl px-5 py-3" style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
      <div className="text-2xl font-black" style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wide" style={muted}>{label}</div>
    </div>
  );
}

function Section({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <section className="dash-block p-5 md:p-6">
      <h2 className="text-xl font-black" style={{ color: 'var(--text)' }}>{title}</h2>
      <p className="mt-1 text-sm leading-6" style={muted}>{detail}</p>
      <div className="mt-4 overflow-x-auto">{children}</div>
    </section>
  );
}

function Table({ head, rows, numeric, empty }: { head: string[]; rows: ReactNode[][]; numeric: boolean[]; empty: string }) {
  if (rows.length === 0) {
    return <p className="rounded-xl p-4 text-sm" style={{ ...muted, background: 'var(--surface-2)' }}>{empty}</p>;
  }
  return (
    <table className="w-full border-collapse text-sm" style={{ color: 'var(--text)' }}>
      <thead>
        <tr>
          {head.map((label, index) => (
            <th
              key={label}
              scope="col"
              className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide"
              style={{ ...muted, borderBottom: '1px solid var(--line-strong)', textAlign: numeric[index] ? 'right' : 'left' }}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, rowIndex) => (
          <tr key={rowIndex}>
            {cells.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className="px-3 py-2"
                style={{ borderBottom: '1px solid var(--line)', ...(numeric[cellIndex] ? numeral : {}) }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
