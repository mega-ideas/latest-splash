/**
 * The live wiring of the audit trail (lib/server/payment-trail.ts): the Seal and Walrus services that seal each decision record, and the
 * hooks the signing layer and the asks call. In production a demo Seal policy or a demo Walrus blob seals nothing and the decision waits,
 * on record and unsealed, for the sweep (`app/api/cron/wallet-signing`).
 */
import 'server-only';

import { makeRecordSealer } from '@/lib/server/payment-record';
import { recordPaymentDecision, sealPendingDecisions, type DecisionInput } from '@/lib/server/payment-trail';
import { sealAdapter } from '@/lib/server/seal';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';
import { storeEncryptedInvoice } from '@/lib/server/walrus';

const sealer = () => makeRecordSealer({ seal: sealAdapter, store: storeEncryptedInvoice });

/** The hook for signing and asks: records the decision and seals its record. */
export function liveDecisionHook(db: DrizzleDb) {
  return (decision: Omit<DecisionInput, 'orgId'> & { orgId: string }) => recordPaymentDecision({ db, seal: sealer() }, decision);
}

/** Seal what could not be sealed when it was recorded. */
export function sweepDecisionRecords(db: DrizzleDb) {
  return sealPendingDecisions({ db, seal: sealer() });
}
