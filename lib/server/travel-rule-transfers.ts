/**
 * The Travel Rule message for a payment to an exchange recipient (v2 §4.6,
 * D5a, D8): the paying business's details and the supplier's, sent to
 * Sumsub, which delivers them to the supplier's exchange (VASP to VASP).
 *
 * Once per payment. The row is written before Sumsub is asked, keyed by the
 * business and the payment's reference (the intent id, Sumsub's txnId), and
 * the caller that sends first claims it (`preparing` to `sending`, a
 * compare-and-set), so two callers cannot both ask Sumsub: the second is
 * told it is in progress. A failed send goes back to `preparing` and may be
 * retried under the same txnId; a send Sumsub answers as a duplicate (its
 * 409: it may already have that txnId from a send whose answer was lost) is
 * held as `unconfirmed`, never resent and never taken for sent, until
 * Sumsub's webhook for that txnId and this business names its transfer. A
 * retry with any other request is refused (`travel_rule_conflict`), except
 * that a sandbox message on file (it never reached an exchange) is replaced
 * by the live provider's, never the other way round.
 * Sumsub's webhook moves the status forward only, for its own reference and
 * txnId.
 *
 * Production without Sumsub's Travel Rule configured refuses before anything
 * is written (the provider throws); no reference is made up.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

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
/** How long a claimed send may go unanswered before its outcome counts as unknown. */
export const SENDING_LEASE_MS = 10 * 60_000;
const unconfirmed = () =>
  refuse(409, 'travel_rule_unconfirmed', 'The provider may already hold this Travel Rule message. It is not sent again; the payment waits until the provider confirms it.');

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
  let row = inserted ?? (await readTravelRuleTransfer(deps.db, deps.orgId, input.intentId));
  if (!row) throw new Error('the Travel Rule transfer could not be stored');
  if (!inserted && row.sandbox && !deps.provider.sandbox) {
    // A sandbox message on file (a non-production server writing to this
    // database, say) never reached an exchange. The provider's message
    // replaces it in one step, under a new id, so a late answer to the
    // sandbox send (its updates name the old id) cannot land on this row.
    // Only a sandbox row is replaced; a provider's message never is.
    const [replaced] = await deps.db
      .update(travelRuleTransfers)
      .set({
        id: `trt_${randomUUID()}`,
        signingRequestId: input.signingRequestId,
        exchange: input.beneficiary.exchange,
        depositAddress: input.beneficiary.depositAddress,
        amountMinor: input.amountMinor,
        requestHash,
        provider: deps.provider.id,
        sandbox: false,
        providerRef: null,
        status: 'preparing',
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .where(and(eq(travelRuleTransfers.orgId, deps.orgId), eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.sandbox, true)))
      .returning();
    // Two callers at once: one replaces it, the other reads what it wrote.
    row = replaced ?? (await readTravelRuleTransfer(deps.db, deps.orgId, input.intentId));
    if (!row) throw new Error('the Travel Rule transfer could not be stored');
  }
  if (row.requestHash !== requestHash || row.provider !== deps.provider.id) {
    return refuse(409, 'travel_rule_conflict', 'A different Travel Rule message was already sent for this payment.');
  }
  if (row.providerRef) return { ok: true, created: false, transfer: travelRuleView(row) };
  if (row.status === 'unconfirmed') return unconfirmed();

  // Claim the send: only the caller that moves it from preparing asks Sumsub.
  const [claimed] = await deps.db
    .update(travelRuleTransfers)
    .set({ status: 'sending', updatedAt: deps.now() })
    .where(and(eq(travelRuleTransfers.orgId, deps.orgId), eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.status, 'preparing')))
    .returning();
  if (!claimed) {
    const now2 = await readTravelRuleTransfer(deps.db, deps.orgId, input.intentId);
    if (now2?.providerRef) return { ok: true, created: false, transfer: travelRuleView(now2) };
    if (now2?.status === 'unconfirmed') return unconfirmed();
    // A send claimed long ago and never answered (its process died): its
    // outcome is unknown, so it is held as unconfirmed, not sent again.
    if (now2?.status === 'sending' && deps.now().getTime() - now2.updatedAt.getTime() > SENDING_LEASE_MS) {
      await deps.db
        .update(travelRuleTransfers)
        .set({ status: 'unconfirmed', updatedAt: deps.now() })
        .where(and(eq(travelRuleTransfers.id, now2.id), eq(travelRuleTransfers.status, 'sending'), isNull(travelRuleTransfers.providerRef)));
      return unconfirmed();
    }
    return refuse(409, 'travel_rule_in_progress', 'The Travel Rule message for this payment is being sent. Ask again in a moment.');
  }

  const back = (status: 'preparing' | 'unconfirmed') =>
    deps.db
      .update(travelRuleTransfers)
      .set({ status, updatedAt: deps.now() })
      .where(and(eq(travelRuleTransfers.orgId, deps.orgId), eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.status, 'sending')));
  let sent;
  try {
    sent = await deps.provider.submitOutbound(input);
  } catch (error) {
    if (error instanceof ComplianceProviderUnavailable && error.code === 'provider_conflict') {
      // Sumsub may hold this txnId already: held, not resent, not taken for sent.
      await back('unconfirmed');
      return unconfirmed();
    }
    // A failure: back to preparing, and a retry asks again under the same txnId.
    await back('preparing');
    if (error instanceof ComplianceProviderUnavailable) return refuse(error.status, error.code, error.message);
    return refuse(502, 'provider_error', 'The Travel Rule message could not be sent. Nothing was recorded as sent.');
  }
  const [updated] = await deps.db
    .update(travelRuleTransfers)
    .set({ providerRef: sent.reference, status: sent.status, updatedAt: deps.now() })
    .where(and(eq(travelRuleTransfers.orgId, deps.orgId), eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.status, 'sending')))
    .returning();
  const final = updated ?? (await readTravelRuleTransfer(deps.db, deps.orgId, input.intentId))!;
  return { ok: true, created: Boolean(inserted), transfer: travelRuleView(final) };
}

/**
 * A Travel Rule webhook's status, applied to the transfer it names: the
 * provider's own reference, and the txnId Splash gave (when the webhook names
 * one) must be that transfer's payment. Forward only; a final status stays.
 */
/**
 * A send whose answer was lost (`sending` left behind, or `unconfirmed`):
 * Sumsub's webhook names the txnId Splash gave and the business
 * (externalUserId), and so the row it belongs to. Its reference is taken
 * only then, and only for that business's row with no reference yet.
 */
async function recoverByTxnId(
  db: DrizzleDb,
  event: { provider: 'sumsub'; reference: string; txnId: string | null; status: TravelRuleStatus; orgId: string | null },
  now: Date,
): Promise<{ applied: boolean; reason: string; orgId?: string }> {
  if (!event.txnId || !event.orgId) return { applied: false, reason: 'unknown transfer' };
  const [row] = await db
    .select()
    .from(travelRuleTransfers)
    .where(and(eq(travelRuleTransfers.orgId, event.orgId), eq(travelRuleTransfers.paymentRef, event.txnId), eq(travelRuleTransfers.provider, event.provider)))
    .limit(1);
  if (!row || row.providerRef || (row.status !== 'unconfirmed' && row.status !== 'sending')) return { applied: false, reason: 'unknown transfer' };
  const [moved] = await db
    .update(travelRuleTransfers)
    .set({ providerRef: event.reference, status: event.status, updatedAt: now })
    .where(and(eq(travelRuleTransfers.id, row.id), eq(travelRuleTransfers.status, row.status), isNull(travelRuleTransfers.providerRef)))
    .returning();
  return moved ? { applied: true, reason: `${row.status} -> ${event.status}`, orgId: row.orgId } : { applied: false, reason: 'moved concurrently' };
}

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
  if (!row) return recoverByTxnId(db, event, now);
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
