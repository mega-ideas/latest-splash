import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { CustomerSession } from '@/lib/auth/customer-session';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { canMoveMoney, kybGateReason, type KybLifecycleState } from '@/lib/compliance/kyb-state';
import { organizations, orgSettings, suppliers, termsAcceptances } from '@/lib/db/schema';
import { TERMS_VERSION } from '@/content/legal';
import type { PayoutPartner, PayoutPartnerId } from '@/lib/payouts/partner';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

/**
 * Onboarding — the derived setup state, and the one new gate.
 *
 * The stepper's state is COMPUTED from real records on every read, never
 * stored: a progress column would drift the first time the admin console
 * flips a KYB state. Only step 1 (terms) writes anything new; every other
 * step's done-ness is a fact the product already keeps.
 *
 * The Stablecorp-pattern intent ('pay' | 'collect' | 'treasury') tailors
 * which steps the UI emphasises and nothing else. It must never gate
 * differently from the KYB lifecycle, or this file becomes a second source
 * of truth beside lib/server/kyb-gate.ts — which stays the authority the
 * money routes enforce.
 */

export const INTENTS = ['pay', 'collect', 'treasury'] as const;
export type OnboardingIntent = (typeof INTENTS)[number];

export interface OnboardingStep {
  id: 'terms' | 'profile' | 'verify' | 'approvals' | 'recipient';
  title: string;
  detail: string;
  done: boolean;
  /** Waiting on someone other than the user (KYB in review). */
  pending?: boolean;
  href: string;
}

export interface OnboardingState {
  intent: OnboardingIntent | null;
  kyb: { state: KybLifecycleState; blocked: boolean; reason: string };
  steps: OnboardingStep[];
  /** Steps 1–4 complete (the recipient step is optional by design). */
  complete: boolean;
  termsVersion: string;
}

/** Structural, not nominal: node-postgres in the app, PGlite in the tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

async function db(): Promise<Db> {
  const { getDb } = await import('@/lib/db/client');
  return getDb() as unknown as Db;
}

/** Exported for tests, which drive it with a PGlite handle. */
export async function orgHasCurrentTerms(d: Db, orgId: string): Promise<boolean> {
  const rows = await d
    .select({ id: termsAcceptances.id })
    .from(termsAcceptances)
    .where(and(eq(termsAcceptances.orgId, orgId), eq(termsAcceptances.version, TERMS_VERSION)))
    .limit(1);
  return rows.length > 0;
}

/** The derived state, computed fresh on every call. */
export async function readOnboardingState(session: CustomerSession): Promise<OnboardingState> {
  const ctx = await resolveAuthorityForSession(session);
  return readOnboardingStateForOrg(await db(), ctx.orgId);
}

/** The derivation itself, injectable so tests drive it against PGlite. */
export async function readOnboardingStateForOrg(d: Db, orgId: string): Promise<OnboardingState> {
  const ctx = { orgId };

  const [org] = await d
    .select({
      intent: organizations.intent,
      legalName: organizations.legalName,
      registrationNumber: organizations.registrationNumber,
      addressCountry: organizations.addressCountry,
      kybLifecycle: organizations.kybLifecycle,
    })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId))
    .limit(1);
  if (!org) throw new Error(`organization ${ctx.orgId} not found`);

  const state = (org.kybLifecycle ?? 'REGISTERED') as KybLifecycleState;

  // Sequential on purpose: the local dev database (scripts/dev-db.mjs) is a
  // PGlite socket server that accepts ONE connection, and a Promise.all here
  // makes the pg pool open more — which resets the socket for everyone.
  // Three indexed reads in series cost nothing a human can feel.
  const terms = await orgHasCurrentTerms(d, ctx.orgId);
  const settingsRows = await d
    .select({ orgId: orgSettings.orgId })
    .from(orgSettings)
    .where(eq(orgSettings.orgId, ctx.orgId))
    .limit(1);
  const supplierRows = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(suppliers)
    .where(eq(suppliers.orgId, ctx.orgId));

  const profileDone = Boolean(org.legalName && org.registrationNumber && org.addressCountry);
  const verifyDone = state !== 'REGISTERED' && state !== 'REJECTED';
  const steps: OnboardingStep[] = [
    {
      id: 'terms',
      title: 'Accept the terms',
      detail: terms
        ? `Accepted, version ${TERMS_VERSION}.`
        : 'Read and accept the terms of service for this workspace.',
      done: terms,
      href: '/dashboard/setup#terms',
    },
    {
      id: 'profile',
      title: 'Business profile',
      detail: profileDone
        ? 'Legal name, registration number and country are on file.'
        : 'The legal name, registration number and country your payments will carry.',
      done: profileDone,
      href: '/dashboard/setup#profile',
    },
    {
      id: 'verify',
      title: 'Verify the business',
      detail: state === 'ACTIVE' ? 'Verified.' : kybGateReason(state) || 'Submit KYB.',
      done: state === 'ACTIVE',
      pending: verifyDone && state !== 'ACTIVE',
      href: '/settings/kyb',
    },
    {
      id: 'approvals',
      title: 'Approvals',
      detail:
        settingsRows.length > 0
          ? 'Approval threshold is set. Add a second approver any time.'
          : 'Confirm the approval threshold, and who signs above it.',
      done: settingsRows.length > 0,
      href: '/dashboard/settings',
    },
    {
      id: 'recipient',
      title: 'First recipient (optional)',
      detail:
        (supplierRows[0]?.n ?? 0) > 0
          ? 'At least one recipient is saved.'
          : 'Save the supplier you will pay first. You can skip this.',
      done: (supplierRows[0]?.n ?? 0) > 0,
      href: '/dashboard/recipients',
    },
  ];

  return {
    intent: (org.intent as OnboardingIntent | null) ?? null,
    kyb: { state, blocked: !canMoveMoney(state), reason: kybGateReason(state) },
    steps,
    complete: steps.slice(0, 4).every((s) => s.done),
    termsVersion: TERMS_VERSION,
  };
}

/** Step 1. Idempotent per user per version — the history of rows is the record. */
export async function acceptTerms(session: CustomerSession): Promise<void> {
  const ctx = await resolveAuthorityForSession(session);
  return acceptTermsFor(await db(), ctx);
}

/** Injectable half of acceptTerms, for the same reason as the derivation. */
export async function acceptTermsFor(d: Db, ctx: { userId: string; orgId: string }): Promise<void> {
  const existing = await d
    .select({ id: termsAcceptances.id })
    .from(termsAcceptances)
    .where(
      and(
        eq(termsAcceptances.userId, ctx.userId),
        eq(termsAcceptances.orgId, ctx.orgId),
        eq(termsAcceptances.version, TERMS_VERSION),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await d.insert(termsAcceptances).values({
    id: `terms_${randomUUID()}`,
    userId: ctx.userId,
    orgId: ctx.orgId,
    version: TERMS_VERSION,
  });
}

/** Chosen once on entry; changed later only from Settings (same call, explicit flag). */
export async function setIntent(
  session: CustomerSession,
  intent: OnboardingIntent,
  { allowChange = false }: { allowChange?: boolean } = {},
): Promise<{ changed: boolean }> {
  if (!INTENTS.includes(intent)) throw new Error(`unknown intent: ${intent}`);
  const ctx = await resolveAuthorityForSession(session);
  const d = await db();
  const [org] = await d
    .select({ intent: organizations.intent })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId))
    .limit(1);
  if (!org) throw new Error(`organization ${ctx.orgId} not found`);
  if (org.intent && org.intent !== intent && !allowChange) return { changed: false };
  await d.update(organizations).set({ intent }).where(eq(organizations.id, ctx.orgId));
  return { changed: true };
}

export type ProfileResult =
  | { ok: true; legalNameChanged: boolean; destinationsRevoked: number }
  | { ok: false; status: number; code: 'owner_only' | 'legal_name_locked' | 'no_org'; error: string };

/** KYB states in which the legal name is still the business's own to correct. */
const NAME_EDITABLE: ReadonlySet<string> = new Set(['REGISTERED', 'REJECTED']);

/**
 * Step 2 — the org-level half of the travel-rule record. Owners only.
 *
 * The legal name is what a withdrawal's bank account must be held in (v2
 * §4.4, lib/server/withdrawals.ts), so it is not a field any member may
 * rewrite: only an owner sets it, and once KYB is under way (submitted,
 * approved, active, suspended) it is fixed. A change of name before that
 * revokes every withdrawal bank account checked against the old one, and
 * cancels any withdrawal to them not yet sent.
 */
export async function saveBusinessProfileFor(
  d: Db,
  ctx: { orgId: string; userId: string; role: string },
  profile: { legalName: string; registrationNumber: string; addressCountry: string },
  opts: { now?: Date; partner?: (id: PayoutPartnerId) => PayoutPartner } = {},
): Promise<ProfileResult> {
  if (ctx.role !== 'OWNER') return { ok: false, status: 403, code: 'owner_only', error: "Only an owner can change the business's registered details." };
  const [org] = await d
    .select({ legalName: organizations.legalName, kybLifecycle: organizations.kybLifecycle })
    .from(organizations)
    .where(eq(organizations.id, ctx.orgId))
    .limit(1);
  if (!org) return { ok: false, status: 404, code: 'no_org', error: 'No such business.' };
  const next = profile.legalName.trim();
  const previous = (org.legalName ?? '').trim();
  const legalNameChanged = previous !== '' && previous !== next;
  if (legalNameChanged && !NAME_EDITABLE.has(org.kybLifecycle)) {
    return { ok: false, status: 409, code: 'legal_name_locked', error: 'The registered name is fixed once verification has started. Contact support to correct it.' };
  }
  await d
    .update(organizations)
    .set({
      legalName: next,
      registrationNumber: profile.registrationNumber,
      addressCountry: profile.addressCountry.toUpperCase(),
    })
    .where(eq(organizations.id, ctx.orgId));
  let destinationsRevoked = 0;
  if (legalNameChanged) {
    const { revokeDestinationsForNameChange } = await import('./withdrawals.ts');
    const now = opts.now ?? new Date();
    destinationsRevoked = await revokeDestinationsForNameChange({ db: d as unknown as DrizzleDb, now: () => now, orgId: ctx.orgId, actor: ctx.userId, partner: opts.partner });
  }
  return { ok: true, legalNameChanged, destinationsRevoked };
}

export async function saveBusinessProfile(
  session: CustomerSession,
  profile: { legalName: string; registrationNumber: string; addressCountry: string },
): Promise<ProfileResult> {
  const ctx = await resolveAuthorityForSession(session);
  const { payoutPartner } = await import('@/lib/payouts/registry');
  return saveBusinessProfileFor(await db(), ctx, profile, { partner: (id) => payoutPartner(id) });
}

let warnedTermsGateSkipped = false;

/**
 * The one NEW server gate: money routes refuse until someone in the org has
 * accepted the current terms. Sits BESIDE the KYB gate, never instead of it.
 * Mirrors the dev posture of lib/server/rate-limit.ts: without a database on
 * a development machine it is skipped once, loudly; production boots with a
 * database or not at all (lib/env.ts), so it cannot be skipped there.
 */
export async function requireTermsAccepted(orgId: string): Promise<Response | null> {
  if (!process.env.DATABASE_URL) {
    if (!warnedTermsGateSkipped) {
      warnedTermsGateSkipped = true;
      console.warn('[onboarding] DATABASE_URL is not set — the terms gate is SKIPPED on this machine.');
    }
    return null;
  }
  const d = await db();
  if (await orgHasCurrentTerms(d, orgId)) return null;
  // Plain Response, not NextResponse: this module is exercised by the bare
  // node test runner, where next/server does not resolve. Identical on the
  // wire.
  return Response.json(
    {
      error: 'terms_not_accepted',
      reason: `The terms of service (version ${TERMS_VERSION}) have not been accepted for this workspace. Finish setup to enable this action.`,
    },
    { status: 412 },
  );
}
