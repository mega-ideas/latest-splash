/**
 * Carrying out an approved payment by running the real route, not a copy of it.
 *
 * ─── Why not a second implementation ────────────────────────────────────────
 *
 * The obvious way to execute an approved payment is to write a function that
 * does what the authorize route does. That is a second implementation of a
 * money path, and the two drift: a guard added to the route in six months —
 * a new sanctions check, a corridor pause, a ceiling — silently does not apply
 * to approved payments, which are the LARGEST ones, because being large is what
 * sent them for approval.
 *
 * So this invokes the route handler itself. A Next route handler is an exported
 * async function taking a Request; calling it in-process runs every guard in
 * its real order, against real state, with no duplication to keep in step.
 *
 * ─── Why the guards re-run at all ───────────────────────────────────────────
 *
 * Time passes between proposing and approving — up to a day. In that window a
 * balance can drain, a corridor can be paused, a beneficiary can fail
 * screening, and the daily ceiling can be consumed by other payments. An
 * approval says "this payment is authorised". It does not say "skip the
 * checks". The only thing it removes is the second-approver requirement,
 * because that is exactly what it supplied.
 *
 * ─── The header is a claim, not a credential ────────────────────────────────
 *
 * `x-splash-approved-proposal` tells the route which approval to look for. The
 * route does not trust it: it loads that proposal, checks it belongs to the
 * caller's org, checks it is genuinely approved, checks it describes this
 * payment, and spends it (lib/server/approved-proposal.ts). A client sending
 * the header by hand gets nowhere.
 *
 * ─── Presented once ─────────────────────────────────────────────────────────
 *
 * When the route returns, whatever it returned, the replay closes the claim.
 * A route that refused before reaching it would otherwise leave an approved,
 * unspent claim behind for the next request to present.
 */
import 'server-only';

import { closeApprovalClaim } from '@/lib/server/approved-proposal';

export const APPROVED_PROPOSAL_HEADER = 'x-splash-approved-proposal';

export type ReplayResult = { ok: true; ref?: string } | { ok: false; error: string };

type ReplayInput = {
  orgId: string;
  approvedProposalId: string;
  body: Record<string, unknown>;
  /** The approver's own cookie, forwarded so the route resolves a real session
   *  and a real membership rather than being handed an identity. */
  cookie: string;
  origin: string;
};

/** Exported for the tests, which drive it with a stand-in handler. */
export async function replayThroughRoute(
  handler: (request: Request) => Promise<Response>,
  path: string,
  input: ReplayInput,
): Promise<ReplayResult> {
  const request = new Request(`${input.origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: input.cookie,
      [APPROVED_PROPOSAL_HEADER]: input.approvedProposalId,
    },
    body: JSON.stringify(input.body),
  });

  let response: Response;
  try {
    response = await handler(request);
  } finally {
    // One approval, one attempt: spent now if the route did not spend it.
    await closeApprovalClaim(input.approvedProposalId, input.orgId);
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A non-JSON body from a money route means something unexpected; report the
    // status rather than pretending the payment succeeded.
    return { ok: false, error: `Settlement returned ${response.status} with an unreadable body.` };
  }

  if (!response.ok) {
    const detail = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    return { ok: false, error: detail };
  }

  // The route answered with a run it had ALREADY carried out: this approval
  // paid nothing. Counted as a success, it read "Payout run started" and nobody
  // was paid. A payment proposed again after the first was carried out is a new
  // proposal now, so its replay can meet the earlier run's replay key.
  if (parsed.idempotentReplay === true) {
    const earlier = typeof parsed.id === 'string' ? ` as ${parsed.id}` : '';
    return { ok: false, error: `This run had already been carried out${earlier}; nothing new was paid for this approval.` };
  }

  const ref =
    (typeof parsed.id === 'string' && parsed.id) ||
    (typeof parsed.transferIntentId === 'string' && parsed.transferIntentId) ||
    undefined;
  return { ok: true, ref };
}

export async function authorizeTransferForApproval(input: ReplayInput): Promise<ReplayResult> {
  const { POST } = await import('@/app/api/transfers/authorize/route');
  return replayThroughRoute(POST, '/api/transfers/authorize', input);
}

export async function authorizeBatchForApproval(input: ReplayInput): Promise<ReplayResult> {
  const { POST } = await import('@/app/api/batches/authorize/route');
  return replayThroughRoute(POST, '/api/batches/authorize', input);
}
