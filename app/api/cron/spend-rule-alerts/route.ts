/**
 * Near-threshold alerts for spending rules (v2 Phase 2; Phase 1 R5).
 *
 * For every business with an on-chain account, reads its spending rules from
 * the chain (the SpendPolicy's running totals and RuleSpend), flags one
 * spender paying one recipient again and again just under the
 * second-approval threshold, and several spenders paying one recipient past
 * it together (lib/server/near-threshold.ts), records each alert once and
 * emails that business's owners. Detective only: it blocks nothing.
 *
 * Each business is read with its OWN context (liveWalletContext(orgId)),
 * never another's. Fails closed: without CRON_SECRET nobody is authorised;
 * without a database, or when any business's rules could not be read, it
 * answers 502 so the scheduler's failure alerting sees it. Hourly is enough:
 * the running windows are a day or more.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { readSpendingRules } from '@/lib/server/spend-rules';
import { liveSpendContext } from '@/lib/server/spend-rules-deps';
import { runNearThresholdMonitor, type ViewRead } from '@/lib/server/near-threshold-monitor';
import { liveWalletContext, orgMemberWalletAddresses } from '@/lib/server/wallet-deps';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** One business's rules, read with its own context. A business without a wallet or policy yet is skipped. */
async function readView(orgId: string): Promise<ViewRead> {
  const live = await liveWalletContext(orgId);
  if (!live.ok) return { ok: false, skip: live.status === 409, error: live.error };
  const spend = await liveSpendContext({ ctx: live.ctx, db: live.db, orgId });
  if (!spend.ok) return { ok: false, error: spend.error };
  const result = await readSpendingRules(spend.sc);
  if (!result.ok) return { ok: false, skip: result.status === 409 || result.status === 404, error: result.error };
  // Names for the words: each member's own passkey address in this business.
  const people = await orgMemberWalletAddresses(live.db, orgId);
  const { users } = await import('@/lib/db/schema');
  const { inArray } = await import('drizzle-orm');
  const ids = [...new Set(people.map((p) => p.userId))];
  const rows: Array<{ id: string; name: string }> = ids.length
    ? await live.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const nameByAddress = new Map(people.map((p) => [p.address, nameById.get(p.userId) ?? null]));
  return { ok: true, view: result.view, nameOf: (address) => nameByAddress.get(address) ?? null };
}

async function handle(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  const result = await runNearThresholdMonitor({ readView });
  if (!result.ok) {
    console.error('[cron/spend-rule-alerts] monitor did not run:', result.reason);
    return NextResponse.json({ success: false, error: result.reason }, { status: 502 });
  }
  if (result.errors.length > 0) {
    return NextResponse.json({ success: false, ...result, error: `${result.errors.length} business(es) could not be read` }, { status: 502 });
  }
  return NextResponse.json({ success: true, ...result });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
