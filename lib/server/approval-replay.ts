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
 * checks". It lifts the second-approver requirement, because that is exactly
 * what it supplied, and the maker's second factor, which was checked when the
 * payment was proposed and cannot be checked again (approved-proposal.ts).
 *
 * ─── Who the route sees ─────────────────────────────────────────────────────
 *
 * The approval, bound to the Request object built here
 * (approval-replay-identity.ts). Not a cookie: the route reads the session
 * through `cookies()`, which answers from the INCOMING request's scope and
 * never from this object, so a forwarded cookie was never read — code and
 * in-app approvals ran as the approver's ambient session, and WhatsApp replies
 * ran as nobody and got 401. And not a header: anything in this Request is
 * something a client could also send.
 */
import 'server-only';

import {
  issueApprovalReplay,
  type ApprovalReplayIdentity,
} from '@/lib/server/approval-replay-identity';

export type ReplayResult =
  | {
      ok: true;
      ref?: string;
      /** The route found this exact payment already made and returned it
       *  rather than making it again (the batch replay key). */
      alreadyMade?: boolean;
    }
  | { ok: false; error: string; code?: string };

type ReplayInput = {
  /** What the payment runs as. Bound to the Request, never written into it. */
  identity: ApprovalReplayIdentity;
  body: Record<string, unknown>;
  /** Where the request says it is addressed. Nothing in the route reads it
   *  for authority. */
  origin: string;
};

type RouteHandler = (request: Request) => Promise<Response>;

/**
 * Invoke a route handler as the replay of one approved proposal.
 *
 * Exported for tests, which stand a plain function in for the route: the
 * route modules import `next/server` and cannot load outside Next.
 */
export async function replayThroughHandler(
  handler: RouteHandler,
  path: string,
  input: ReplayInput,
): Promise<ReplayResult> {
  const request = issueApprovalReplay(
    new Request(new URL(path, input.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.body),
    }),
    input.identity,
  );

  const response = await handler(request);
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
    return { ok: false, error: detail, code: typeof parsed.code === 'string' ? parsed.code : undefined };
  }

  const ref =
    (typeof parsed.id === 'string' && parsed.id) ||
    (typeof parsed.transferIntentId === 'string' && parsed.transferIntentId) ||
    undefined;
  return { ok: true, ref, alreadyMade: parsed.idempotentReplay === true };
}

export async function authorizeTransferForApproval(input: ReplayInput): Promise<ReplayResult> {
  const { POST } = await import('@/app/api/transfers/authorize/route');
  return replayThroughHandler(POST, '/api/transfers/authorize', input);
}

export async function authorizeBatchForApproval(input: ReplayInput): Promise<ReplayResult> {
  const { POST } = await import('@/app/api/batches/authorize/route');
  return replayThroughHandler(POST, '/api/batches/authorize', input);
}
