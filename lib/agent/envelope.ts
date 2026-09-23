import type { DataStatus, EvidenceItem, EvidenceQuality } from './types.ts';

/**
 * Track A WS2 — the truth envelope. Every tool result Zeke consumes is
 * wrapped with its source, observation time, and an honest LIVE / STALE /
 * MODELED / DEMO status. Fixture-backed data says so — it is never presented
 * as live fact. The real data sources land in Track B; the honesty ships now.
 */

export type { DataStatus, EvidenceQuality };

export interface Envelope<T> {
  orgId?: string;
  /** e.g. "ledger.postgres" | "fixture.balances" | "model.netting" | "pyth.hermes" */
  source: string;
  observedAt: string;
  /** After this instant a LIVE reading degrades to STALE. */
  expiresAt?: string;
  status: DataStatus;
  data: T;
}

export function classify(source: string, observedAt: Date, ttlSeconds?: number, now = new Date()): DataStatus {
  if (source.startsWith('fixture.') || source.startsWith('demo.')) return 'DEMO';
  if (source.startsWith('model.')) return 'MODELED';
  if (ttlSeconds && now.getTime() - observedAt.getTime() > ttlSeconds * 1000) return 'STALE';
  return 'LIVE';
}

export function makeEnvelope<T>(input: {
  data: T;
  source: string;
  orgId?: string;
  observedAt?: Date;
  ttlSeconds?: number;
}): Envelope<T> {
  const observedAt = input.observedAt ?? new Date();
  return {
    orgId: input.orgId,
    source: input.source,
    observedAt: observedAt.toISOString(),
    expiresAt: input.ttlSeconds ? new Date(observedAt.getTime() + input.ttlSeconds * 1000).toISOString() : undefined,
    status: classify(input.source, observedAt, input.ttlSeconds),
    data: input.data,
  };
}

/** ALL_LIVE requires every evidence item to be explicitly labeled LIVE. */
export function evidenceQualityOf(evidence: Pick<EvidenceItem, 'status'>[]): EvidenceQuality {
  return evidence.length > 0 && evidence.every((item) => item.status === 'LIVE')
    ? 'ALL_LIVE'
    : 'CONTAINS_DEMO_DATA';
}
