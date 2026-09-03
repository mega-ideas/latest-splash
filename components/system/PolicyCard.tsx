import type { ReactNode } from 'react';

import Badge, { type BadgeTone } from './Badge';
import Card from './Card';
import Chip from './Chip';

/**
 * A policy is a rule a human set; the card states the rule in plain words,
 * who it applies to, and whether it is enforced. Policies gate execution;
 * the agent only proposes.
 */
export default function PolicyCard({
  title,
  rule,
  scope,
  status = { label: 'Enforced', tone: 'green' },
  chips = [],
  action,
}: {
  title: string;
  rule: string;
  scope?: string;
  status?: { label: string; tone: BadgeTone };
  chips?: string[];
  action?: ReactNode;
}) {
  return (
    <Card padding="sm" className="grid gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-[var(--text)]">{title}</h3>
          {scope ? <p className="text-[12px] text-[var(--text-muted)]">{scope}</p> : null}
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="text-[14px] leading-[1.55] text-[var(--text-2)]">{rule}</p>
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </div>
      ) : null}
      {action ? <div className="flex justify-end">{action}</div> : null}
    </Card>
  );
}
