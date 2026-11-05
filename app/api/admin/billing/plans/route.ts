/**
 * Subscription plans for Splash staff (A1 §6: plans editable without code),
 * behind FEATURE_SUBSCRIPTION_BILLING, which is OFF: while off this answers
 * 404 before it reads a session or the database.
 *
 * GET  every plan, inactive ones too.
 * PUT  { id, name, priceMinor, termMonths?, lifetimeCapMinor?, active? }:
 *      add or change a plan. A price change applies to new subscriptions; a
 *      live one keeps the price its wallet signed.
 *
 * Operations staff only. Cross-tenant by nature (plans belong to no
 * business), through the *ForStaff service functions.
 */
import { NextResponse } from 'next/server';

import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { getAdminSession } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';
import { listPlansForStaff, upsertPlanForStaff } from '@/lib/server/subscription-billing';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

async function database(): Promise<DrizzleDb | null> {
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('@/lib/db/client');
  return getDb() as unknown as DrizzleDb;
}

const minor = (v: unknown): bigint | null => (typeof v === 'string' && /^[0-9]{1,19}$/.test(v) ? BigInt(v) : null);

export async function GET() {
  if (!subscriptionBillingEnabled()) return notFound();
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (session.role !== 'operations') return NextResponse.json({ error: 'Billing is for operations staff' }, { status: 403 });
  const db = await database();
  if (!db) return NextResponse.json({ error: 'DATABASE_URL is not set' }, { status: 503 });
  const result = await listPlansForStaff({ db });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ plans: result.plans });
}

export async function PUT(request: Request) {
  if (!subscriptionBillingEnabled()) return notFound();
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (session.role !== 'operations') return NextResponse.json({ error: 'Billing is for operations staff' }, { status: 403 });
  const body = await readJsonBody(request);
  const id = typeof body.id === 'string' ? body.id : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const priceMinor = minor(body.priceMinor);
  const lifetimeCapMinor = body.lifetimeCapMinor === null || body.lifetimeCapMinor === undefined ? null : minor(body.lifetimeCapMinor);
  const termMonths = body.termMonths === undefined ? undefined : Number(body.termMonths);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || name.length < 1 || name.length > 80 || priceMinor === null || priceMinor <= 0n) {
    return NextResponse.json({ error: 'a plan needs an id (letters, digits, - or _), a name and a price above zero in USDC minor units' }, { status: 400 });
  }
  if ((body.lifetimeCapMinor !== null && body.lifetimeCapMinor !== undefined && (lifetimeCapMinor === null || lifetimeCapMinor <= 0n)) || (termMonths !== undefined && (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 36))) {
    return NextResponse.json({ error: 'a lifetime cap is above zero and a term is 1 to 36 calendar months' }, { status: 400 });
  }
  const db = await database();
  if (!db) return NextResponse.json({ error: 'DATABASE_URL is not set' }, { status: 503 });
  await upsertPlanForStaff(db, { id, name, priceMinor, lifetimeCapMinor, ...(termMonths !== undefined ? { termMonths } : {}), ...(typeof body.active === 'boolean' ? { active: body.active } : {}) });
  const result = await listPlansForStaff({ db });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ plans: result.plans });
}
