import { getOxwalRun, oxwalRunResponse } from '@/lib/agent/stream-hub';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resume a 0xWal run the browser lost mid-stream. Replays every event after
 * `?after=<seq>` (or the Last-Event-ID header) and keeps streaming until the
 * run finishes. Runs are org-scoped: another organisation's run id is a 404,
 * never a hint that it exists.
 */
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const ctx = await resolveAuthorityForSession(auth.session);

  const { runId } = await context.params;
  const run = getOxwalRun(runId);
  if (!run || run.orgId !== ctx.orgId) {
    return new Response(JSON.stringify({ error: 'run not found', code: 'run_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const afterParam = url.searchParams.get('after') ?? request.headers.get('last-event-id');
  const after = Number.parseInt(afterParam ?? '', 10);
  return oxwalRunResponse(run, Number.isFinite(after) ? after : -1);
}
