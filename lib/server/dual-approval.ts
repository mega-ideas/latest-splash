/**
 * The other half of "this needs a second approver".
 *
 * Both money routes already detected the case. Neither did anything with it:
 *
 *   `/api/transfers/authorize` and `/api/batches/authorize` answered 409 with
 *   "It needs a second approver — submit it through the approval queue", and
 *   nothing put anything in the approval queue. The operator was told where to
 *   go and given no way to get there. A control that stops work without
 *   offering the sanctioned path is a control people route around: they split
 *   the payment under the threshold, which is worse than no threshold at all.
 *
 * Everything the sanctioned path needs already existed — `proposals` and
 * `approvals` tables, a write-through store, a state machine that enforces
 * maker≠checker against a DB-derived identity, a submit route that re-evaluates
 * policy and compliance at approval time, and a queue that renders lanes. The
 * one missing piece was a proposal.
 *
 * This creates it, and returns the id so the 409 can say WHERE the payment now
 * is rather than only that it stopped.
 *
 * ─── Who the maker is ───────────────────────────────────────────────────────
 *
 * `createdBy` is the authenticated user id from the session, never a request
 * field. It is what `proposals/[id]/submit` compares against the approver to
 * refuse self-approval, so it is the whole substance of maker-checker: get it
 * from the client and the control is decorative.
 *
 * ─── Why it is created already simulated ────────────────────────────────────
 *
 * The submit route refuses a proposal with no simulation, and rightly — an
 * approver must see the effect they are signing for. For an agent proposal that
 * simulation is a dry-run PTB. For one of these, the route reached this point
 * having ALREADY run every check that precedes payment: the amount floor, the
 * per-transfer and daily ceilings, the funding source, the balance, the KYB
 * gate, the compliance pause, TOTP. The simulation records that those passed
 * and what the money movement is. It does not claim a chain dry-run happened.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { EvidenceItem, ProposalKind, UnsignedProposal } from '@/lib/agent/types';

/** How long an unapproved payment stays approvable. Beyond this the quote and
 *  the balance behind it are stale enough that re-authorizing is the honest
 *  path, and the queue's EXPIRING_QUOTES lane surfaces it before then. */
const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** USD decimal string to 6-decimal minor units, truncating. A proposal must
 *  never round UP the amount an approver is asked to sign for. */
function usdToMinor(amount: string): bigint {
  const [whole, frac = ''] = amount.trim().replace(/,/g, '').split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1_000_000n + BigInt(padded || '0');
}

/** The gates a payment clears before it reaches the approval threshold.
 *  Each becomes one evidence line an approver can read. */
export type PassedCheck = {
  source: EvidenceItem['source'];
  ref: string;
};

export type PendingApproval = {
  orgId: string;
  /** The authenticated maker. From the session, never the request. */
  createdBy: string;
  kind: Extract<ProposalKind, 'PAYMENT' | 'BATCH_PAYOUT'>;
  amountUsd: string;
  targetCurrency: string;
  /** What the operator sees in the queue, in their words. */
  recommendation: string;
  /** The checks that already passed, recorded as evidence rather than claimed. */
  passedChecks: PassedCheck[];
  /** Enough to rebuild the payment when it is approved. */
  payload: Record<string, unknown>;
  /** Ties the proposal to the same replay key the route derived, so a
   *  re-submitted file finds the pending proposal instead of making a second. */
  idempotencyKey: string;
  approvalThresholdUsd: number;
};

/**
 * Create the proposal a blocked payment becomes.
 *
 * Returns the proposal, or `null` when the store is unavailable — the caller
 * still refuses the payment, because failing to create the approval record is
 * not a reason to let an over-threshold payment through.
 */
export async function proposeForApproval(
  input: PendingApproval,
): Promise<UnsignedProposal | null> {
  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');

    const store = getOxwalProposalStore();
    // A pending proposal for this exact payment may already be in Postgres from
    // a previous process; without hydrating first we would mint a second.
    await ensureProposalStoreHydrated(store);

    const existing = store
      .list()
      .find((p) => p.orgId === input.orgId && p.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;

    const createdAt = new Date().toISOString();
    const simulatedAt = createdAt;
    const proposal: UnsignedProposal = {
      id: `prop_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      status: 'DRAFTED',
      tier: 'TIER_0_PROPOSE',
      orgId: input.orgId,
      corridor: input.targetCurrency,
      unsignedTxBytes: createHash('sha256')
        .update(`${input.kind}\u0000${input.orgId}\u0000${input.idempotencyKey}`)
        .digest('hex'),
      explain: {
        recommendation: input.recommendation,
        financialImpact: {
          // Micro units, which is the scale `financialImpact` carries.
          //
          // `amountIn` only. The payment is refused before a quote is taken, so
          // there is no target-currency figure yet — and setting `amountOut` to
          // the USD amount while labelling it `currencyOut` would put "PHP
          // 15,000.00" in front of the approver for a 15,000 USD payment.
          // The corridor is on the proposal; the converted amount is not known
          // and is not claimed.
          amountIn: usdToMinor(input.amountUsd),
          currencyIn: 'USD',
        },
        // Each check that already passed, named. An approver seeing "dual
        // approval required" and nothing else has to take the amount on trust.
        evidence: input.passedChecks.map((check) => ({
          source: check.source,
          ref: check.ref,
          observedAt: createdAt,
          // Server-side checks on server-held state. Nothing here came
          // from the request body.
          trusted: true,
          status: 'LIVE' as const,
        })),
        confidence: 1,
        risk: 'MEDIUM',
        // The policy engine decides the real number at submit time; this is the
        // floor that put the payment here.
        requiredApprovers: 2,
        reasoningTraceRef: `dual-approval:${input.idempotencyKey.slice(0, 20)}`,
      },
      // The maker. Compared against the approver by the submit route, and the
      // reason this cannot come from the request body.
      createdBy: input.createdBy,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + APPROVAL_WINDOW_MS).toISOString(),
      approvals: [],
      settlement: undefined,
      // On the proposal, so an approval that outlives this process can still
      // be carried out, and so the thing approved and the thing executed are
      // one record rather than two that can drift.
      executionPayload: input.payload,
    };

    const stored = store.create(proposal);

    // Record the checks as the simulation. Honest about what it is: the money
    // movement and the gates it already cleared, not a chain dry-run.
    //
    // The balance change is in MICRO units, the same scale as
    // `financialImpact` above. `lib/policy/evaluate.ts` compares the two at
    // approval time and blocks on "simulation mismatch" when they disagree —
    // which is exactly what it did when this said `-22500.50`, and rightly: a
    // proposal whose stated impact and simulated effect differ is one an
    // approver would be signing blind.
    store.transition(stored.id, {
      type: 'SIMULATION_COMPLETED',
      simulation: {
        ok: true,
        balanceChanges: [
          {
            owner: input.orgId,
            coinType: 'USDC',
            amount: (-usdToMinor(input.amountUsd)).toString(),
          },
        ],
        gasSponsored: false,
        simulatedAt,
      },
    });

    // The payload the payment is rebuilt from lives with the proposal so the
    // approval and the thing approved cannot drift apart.
    rememberPayload(stored.id, input.payload);

    await store.flush();
    const created = store.get(stored.id) ?? stored;

    // Ask the approvers. Fire-and-forget on purpose: a notification that
    // cannot be delivered must not fail the payment path that raised it.
    // The proposal exists, the queue shows it, and an approver can still act
    // in the app — WhatsApp is a faster route to the same decision, not the
    // only one.
    void (async () => {
      try {
        const { requestApprovals } = await import('./approval-requests.ts');
        const outcome = await requestApprovals({
          proposal: created,
          orgName: input.orgId,
          amountUsd: input.amountUsd,
          // The maker never votes on their own payment.
          excludeUserId: input.createdBy,
          now: new Date(),
        });
        if (outcome.unreachable.length > 0) {
          console.info(
            '[approvals] %d of %d approvers were not reachable on WhatsApp: %s',
            outcome.unreachable.length,
            outcome.approversAsked,
            outcome.unreachable.join(', '),
          );
        }
      } catch (error) {
        console.error('[approvals] could not notify approvers', error);
      }
    })();

    return created;
  } catch (error) {
    console.error(
      '[dual-approval] could not create the approval proposal — the payment stays refused',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * The authorize payload a pending payment is rebuilt from.
 *
 * globalThis-anchored like every other store here. It is deliberately NOT the
 * proposal's `explain`: that is what an approver reads, and stuffing a raw
 * request body into it would put unvalidated client input in front of the
 * person whose signature releases the money.
 *
 * In-process today, which means an approval surviving a restart finds no
 * payload and must be re-authorized. The proposal itself is durable; this is
 * the next thing to move, and the queue tells the operator rather than failing
 * silently.
 */
type PayloadStore = Map<string, Record<string, unknown>>;
const payloadGlobal = globalThis as typeof globalThis & { splashApprovalPayloads?: PayloadStore };
const payloads: PayloadStore = payloadGlobal.splashApprovalPayloads ?? new Map();
payloadGlobal.splashApprovalPayloads = payloads;

function rememberPayload(proposalId: string, payload: Record<string, unknown>) {
  payloads.set(proposalId, payload);
}

export function recallPayload(proposalId: string): Record<string, unknown> | null {
  return payloads.get(proposalId) ?? null;
}
