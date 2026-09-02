import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPEN_STATUSES = new Set(['SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL']);
const HISTORY_STATUSES = new Set(['APPROVED', 'SIGNED', 'SUBMITTED', 'EXECUTED', 'ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED']);

function amountLabel(value: bigint | number | undefined, currency: string | undefined): string | null {
  if (value === undefined || value === null) return null;
  const raw = typeof value === 'bigint' ? Number(value) : value;
  // Amounts arrive in micro units above ~10k, plain units below (action-card heuristic).
  const units = Math.abs(raw) >= 10_000 ? raw / 1_000_000 : raw;
  return `${units.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? 'USD'}`;
}

/**
 * Open proposals for the signed-in organisation: what the dashboard shows as
 * "awaiting approval". Read-only; approval only ever happens through
 * POST /api/proposals/[id]/submit.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const ctx = await resolveAuthorityForSession(auth.session);
  const store = getOxwalProposalStore();
  await ensureProposalStoreHydrated(store);

  const scope = new URL(request.url).searchParams.get('scope') === 'history' ? HISTORY_STATUSES : OPEN_STATUSES;
  const items = store
    .list()
    .filter((proposal) => scope.has(proposal.status) && proposal.orgId === ctx.orgId)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
    .map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      corridor: proposal.corridor ?? null,
      recommendation: proposal.explain.recommendation,
      createdBy: proposal.createdBy,
      approvalHash: proposal.approvalHash ?? null,
      evidenceQuality: proposal.explain.evidence.every((item) => item.trusted) ? 'trusted' : 'untrusted',
      amountLabel: amountLabel(
        proposal.explain.financialImpact.amountOut ?? proposal.explain.financialImpact.amountIn,
        proposal.explain.financialImpact.currencyOut ?? proposal.explain.financialImpact.currencyIn,
      ),
      risk: proposal.explain.risk,
      approvalsCollected: new Set(proposal.approvals.map((approval) => approval.userId)).size,
      requiredApprovers: proposal.explain.requiredApprovers,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt ?? null,
    }));

  return new Response(JSON.stringify({ items, total: items.length }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
