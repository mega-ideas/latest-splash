/**
 * The Travel Rule message for a payment to an exchange recipient (v2 §4.6,
 * D5a, D8): the paying business's details and the supplier's, sent to
 * Sumsub, which delivers them to the supplier's exchange (VASP to VASP).
 *
 * Once per payment. The row is written before Sumsub is asked, keyed by the
 * business and the payment's reference (the intent id, Sumsub's txnId), so
 * two callers cannot send two messages; a retry with the same request asks
 * Sumsub again under the same txnId and gets the same transfer, and a retry
 * with anything else is refused (`travel_rule_conflict`). Sumsub's webhook
 * moves the status forward only, for its own reference and txnId.
 *
 * Production without Sumsub's Travel Rule configured refuses before anything
 * is written (the provider throws); no reference is made up.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { travelRuleTransfers } from '../db/schema.ts';
import {
  ComplianceProviderUnavailable,
  sumsubTravelRuleBody,
  travelRuleAdvances,
  type TravelRuleProvider,
  type TravelRuleStatus,
  type TravelRuleTransferInput,
} from '../compliance/sumsub.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type TravelRuleRow = typeof travelRuleTransfers.$inferSelect;

export type TravelRuleDeps = { db: DrizzleDb; provider: TravelRuleProvider; orgId: string; now: () => Date };

type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

export async function readTravelRuleTransfer(db: DrizzleDb, orgId: string, paymentRef: string): Promise<TravelRuleRow | null> {
  const [row] = await db.select().from(travelRuleTransfers).where(and(eq(travelRuleTransfers.orgId, orgId), eq(travelRuleTransfers.paymentRef, paymentRef))).limit(1);
  return row ?? null;
}

/** What makes two requests the same message: everything sent except the date. */
function requestHashOf(input: TravelRuleTransferInput): string {
  const body = sumsubTravelRuleBody(input) as Record<string, unknown>;
  const { txnDate: _date, ...rest } = body;
  void _date;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export type TravelRuleView = {
  paymentRef: string;
  exchange: string;
  depositAddress: string;
  amountMinor: string;
  provider: string;
  sandbox: boolean;
  reference: string | null;
  status: string;
};

export function travelRuleView(row: TravelRuleRow): TravelRuleView {
  return {
    paymentRef: row.paymentRef,
    exchange: row.exchange,
    depositAddress: row.depositAddress,
    amountMinor: row.amountMinor.toString(),
    provider: row.provider,
    sandbox: row.sandbox,
    reference: row.providerRef,
    status: row.status,
  };
}

/**
 * Send the Travel Rule message for one payment, once. `input.orgId` must be
 * the deps' org: the caller reads it from the session, never the request.
 */
export async function sendTravelRule(
  deps: TravelRuleDeps,
  input: TravelRuleTransferInput & { signingRequestId: string | null; createdBy: string },
): Promise<{ ok: true; created: boolean; transfer: TravelRuleView } | Refusal> {
  if (input.orgId !== deps.orgId) return refuse(404, 'not_found', 'No such payment.');
  if (input.amountMinor <= 0n) return refuse(400, 'bad_amount', 'The payment has no amount.');
  let requestHash: string;
  try {
    requestHash = requestHashOf(input);
  } catch (error) {
    if (error instanceof ComplianceProviderUnavailable) return refuse(error.status, error.code, error.message);
    throw error;
  }
  const now = deps.now();
  const [inserted] = await deps.db
    .insert(travelRuleTransfers)
    .values({
      id: `trt_${randomUUID()}`,
      orgId: deps.orgId,
      paymentRef: input.intentId,
      signingRequestId: input.signingRequestId,
      exchange: input.beneficiary.exchange,
      depositAddress: input.beneficiary.depositAddress,
      amountMinor: input.amountMinor,
      requestHash,
      provider: deps.provider.id,
      sandbox: deps.provider.sandbox,
      status: 'preparing',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted ?? (await readTravelRuleTransfer(deps.db, deps.orgId, input.intentId));
  if (!row) throw new Error('the Travel Rule transfer could not be stored');
  if (row.requestHash !== requestHash || row.provider !== deps.provider.id) {
    return refuse(409, 'travel_rule_conflict', 'A different Travel Rule message was already sent for this payment.');
  }
  if (row.providerRef) return { ok: true, created: false, transfer: travelRuleView(row) };

  let sent;
  try {
    sent = await deps.provider.submitOutbound(input);
  } catch (error) {
    // The row stays `preparing`; a retry asks again under the same txnId.
    if (error instanceof ComplianceProviderUnavailable) return refuse(error.status, error.code, error.message);
    return refuse(502, 'provider_error', 'The Travel Rule message could not be sent. Nothing was recorded as sent.');
  }
  const [updated] = await deps.db
    .update(travelRuleTransfers)
    .set({ providerRef: sent.reference, status: sent.status, updatedAt: deps.now() })
    .where(and(eq(travelRuleTransfers.orgId, deps.orgId), eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.status, 'preparing')))
    .returning();
  const final = updated ?? (await readTravelRuleTransfer(deps.db, deps.orgId, input.intentId))!;
  return { ok: true, created: Boolean(inserted), transfer: travelRuleView(final) };
}

/**
 * A Travel Rule webhook's status, applied to the transfer it names: the
 * provider's own reference, and the txnId Splash gave (when the webhook names
 * one) must be that transfer's payment. Forward only; a final status stays.
 */
export async function applyTravelRuleEvent(
  db: DrizzleDb,
  event: { provider: 'sumsub'; reference: string; txnId: string | null; status: TravelRuleStatus; orgId: string | null },
  now: Date,
): Promise<{ applied: boolean; reason: string; orgId?: string }> {
  const [row] = await db
    .select()
    .from(travelRuleTransfers)
    .where(and(eq(travelRuleTransfers.provider, event.provider), eq(travelRuleTransfers.providerRef, event.reference)))
    .limit(1);
  if (!row) return { applied: false, reason: 'unknown transfer' };
  if (event.orgId !== null && event.orgId !== row.orgId) return { applied: false, reason: 'another business' };
  if (event.txnId !== null && event.txnId !== row.paymentRef) return { applied: false, reason: 'txnId does not match' };
  if (!travelRuleAdvances(row.status as TravelRuleStatus, event.status)) return { applied: false, reason: `${row.status} does not move to ${event.status}` };
  const [moved] = await db
    .update(travelRuleTransfers)
    .set({ status: event.status, updatedAt: now })
    .where(and(eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.status, row.status)))
    .returning();
  return moved ? { applied: true, reason: `${row.status} -> ${event.status}`, orgId: row.orgId } : { applied: false, reason: 'moved concurrently' };
}
