import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { stuckPaymentItem, type StuckViewer } from '@/lib/queue/stuck-payments';
import { findStuckPayments, liveStuckRecords } from '@/lib/server/stuck-payments';

import StuckPaymentsLane from './StuckPaymentsLane';

/**
 * The queue's stuck-payments lane, loaded on the server: the viewer's own
 * workspace's approved payments with no recorded outcome, saved or in this
 * process, each with what its approval's spend shows
 * (lib/server/stuck-payments.ts). No viewer (no membership) means no
 * workspace, and nothing to show.
 */
export default async function StuckPaymentsSection({ viewer }: { viewer: StuckViewer | null }) {
  if (!viewer) return null;
  const store = getOxwalProposalStore();
  await ensureProposalStoreHydrated(store);
  const now = new Date();
  const stuck = await findStuckPayments(store, viewer.orgId, now, liveStuckRecords(store));
  // Rendered even when empty: the lane keeps what the approver just recorded
  // on screen across the refresh that removes the row, and hides itself.
  return <StuckPaymentsLane items={stuck.map(({ proposal, evidence }) => stuckPaymentItem(proposal, evidence, viewer, now))} />;
}
