import type { DeliveryRail } from '@/lib/network';
import { getNetworkProfile } from '@/lib/network';
import type { TransferIntentState } from '@/lib/server/operations';

import type { SettlementState, TimelineEntry } from './delivery-states';

/**
 * Map the operations-store transfer states onto the D7 settlement model.
 * States that are internal bookkeeping (EXCHANGING, QUEUED, SETTLING…) do not
 * become hops; the timeline only shows what an auditor can verify.
 */
const STATE_MAP: Partial<Record<TransferIntentState, SettlementState>> = {
  AUTHORIZED: 'INTENT_CREATED',
  DEPOSIT_CONFIRMED: 'FUNDED',
  SETTLED: 'SETTLED_ON_SUI',
  SWEEPING: 'DELIVERED_TO_EXCHANGE',
  DISBURSED: 'PAID_OUT',
  CREDITED: 'PAID_OUT',
  FAILED: 'RETURNED',
  REFUNDING: 'RETURNED',
  REFUNDED: 'RETURNED',
};

export function timelineEntriesFrom(
  history: Array<{ state: string; at: string }>,
  extras: { digest?: string | null; explorerUrl?: string | null; partnerRef?: string | null } = {},
): TimelineEntry[] {
  const seen = new Set<SettlementState>();
  const entries: TimelineEntry[] = [];
  for (const event of history) {
    const mapped = STATE_MAP[event.state as TransferIntentState];
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    const entry: TimelineEntry = { state: mapped, at: event.at };
    if (mapped === 'SETTLED_ON_SUI' && extras.digest) {
      entry.evidence = { label: 'Sui digest', value: extras.digest, href: extras.explorerUrl ?? undefined };
    }
    if (mapped === 'PAID_OUT' && extras.partnerRef) {
      entry.evidence = { label: 'Partner reference', value: extras.partnerRef };
    }
    entries.push(entry);
  }
  // A settled record always implies an intent and funding even when the
  // operations store skipped those transitions.
  if (seen.has('SETTLED_ON_SUI')) {
    const first = entries[0]?.at;
    if (!seen.has('INTENT_CREATED')) entries.unshift({ state: 'INTENT_CREATED', at: first });
    if (!seen.has('FUNDED')) entries.splice(1, 0, { state: 'FUNDED', at: first });
  }
  return entries;
}

/** Delivery rail for a target currency from the network profile; sui-native by default. */
export function railForCurrency(currency: string): DeliveryRail {
  const corridor = getNetworkProfile().corridors.find((entry) => entry.currency === currency);
  return corridor?.deliveryRail ?? 'sui-native';
}
