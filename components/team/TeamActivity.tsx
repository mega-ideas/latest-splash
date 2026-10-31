'use client';

import LocalTime from '@/components/LocalTime';
import type { TeamActivityWire } from '@/lib/team/view';

const SHOWN = 6;

/**
 * Who changed the team, newest first: every person added, role changed or
 * removed, every Finance lead appointment and every Add funds or Withdraw
 * grant. These are lines of the business's own audit trail, which nobody can
 * rewrite. The latest few show; the rest fold under one control.
 */
export default function TeamActivity({ activity }: { activity: TeamActivityWire[] }) {
  if (activity.length === 0) {
    return <p className="text-[13px] leading-5 text-[#326273]">Nothing has changed yet. Each time someone is added, moved or removed, or given Add funds or Withdraw, it is written here.</p>;
  }
  const line = (a: TeamActivityWire) => (
    <li key={a.id} className="flex flex-col gap-0.5 py-2 text-sm text-[#1F4452] sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span>{a.summary}</span>
      <span className="shrink-0 text-[13px] tabular-nums text-[#326273]"><LocalTime value={a.createdAt} format="datetime" /></span>
    </li>
  );
  return (
    <div>
      <ul className="divide-y divide-[#326273]/10" aria-label="Recent team changes">{activity.slice(0, SHOWN).map(line)}</ul>
      {activity.length > SHOWN ? (
        <details className="group mt-1">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
            Show {activity.length - SHOWN} earlier
          </summary>
          <ul className="divide-y divide-[#326273]/10" aria-label="Earlier team changes">{activity.slice(SHOWN).map(line)}</ul>
        </details>
      ) : null}
    </div>
  );
}
