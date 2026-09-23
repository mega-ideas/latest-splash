/**
 * The operating dials, per org, changeable only by an admin.
 *
 * ─── What this replaces ─────────────────────────────────────────────────────
 *
 * `lib/server/operating-settings.ts` read ONE JSON file with no org id in it,
 * and `PUT /api/settings` was guarded by `requireCustomerRequest` and nothing
 * else — no role check, no org scoping.
 *
 * So any authenticated user of any tenant could set `requireDualApproval` to
 * false and drop `approvalThresholdUsd` to a dollar, for EVERY tenant at once.
 * The maker-checker control reads that flag. The per-transfer and daily
 * ceilings read those numbers. A control the payer can switch off is not a
 * control, and one tenant switching it off for another is worse again.
 *
 * ─── Clamping, not rejecting ────────────────────────────────────────────────
 *
 * Kept from the file version deliberately. An operator who types 999999999
 * into a limit gets the maximum, not a 400 and a lost form — but they get it
 * visibly, because the saved value is returned and rendered back.
 *
 * The two cross-field invariants still throw, because they are not typos:
 * a daily limit below the per-transfer limit, or an approval threshold above
 * it, describe a policy that cannot be satisfied rather than a value out of
 * range.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { orgSettings } from '@/lib/db/schema';

export type ApprovalChannel = 'code' | 'reply';

export type OrgSettings = {
  perTransferLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  autoAllocateTreasuryPct: number;
  requireTotp: boolean;
  requireDualApproval: boolean;
  blockHighRiskCorridors: boolean;
  notifyOnSettlement: boolean;
  /**
   * How an approver is asked to approve.
   *
   * `code` — a one-time code delivered to WhatsApp and typed back into Splash.
   * Approving then needs the phone AND a live authenticated session with an
   * approver role, so a stolen handset alone releases nothing.
   *
   * `reply` — APPROVE or REJECT in the chat. Faster, and it authenticates a
   * handset rather than a person: whoever holds the device can approve.
   *
   * `code` is the default for that reason.
   */
  approvalChannel: ApprovalChannel;
  whatsappEnabled: boolean;
  updatedBy: string | null;
  updatedAt: string;
};

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  perTransferLimitUsd: 50_000,
  dailyLimitUsd: 250_000,
  approvalThresholdUsd: 10_000,
  autoAllocateTreasuryPct: 1,
  requireTotp: true,
  requireDualApproval: true,
  blockHighRiskCorridors: true,
  notifyOnSettlement: true,
  approvalChannel: 'code',
  whatsappEnabled: false,
  updatedBy: null,
  updatedAt: new Date(0).toISOString(),
};

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Any truthy JSON value used to be stored as-is; `"false"` is truthy. */
function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function channel(value: unknown, fallback: ApprovalChannel): ApprovalChannel {
  return value === 'code' || value === 'reply' ? value : fallback;
}

/**
 * Read one org's settings.
 *
 * A missing row is the DEFAULTS, which are the strict ones — dual approval on,
 * TOTP on. An org with no row must not be an org with no controls.
 */
export async function readOrgSettings(orgId: string): Promise<OrgSettings> {
  if (!process.env.DATABASE_URL) return { ...DEFAULT_ORG_SETTINGS };
  try {
    const { getDb } = await import('@/lib/db/client');
    const rows = await getDb().select().from(orgSettings).where(eq(orgSettings.orgId, orgId)).limit(1);
    const row = rows[0];
    if (!row) return { ...DEFAULT_ORG_SETTINGS };
    return {
      perTransferLimitUsd: row.perTransferLimitUsd,
      dailyLimitUsd: row.dailyLimitUsd,
      approvalThresholdUsd: row.approvalThresholdUsd,
      autoAllocateTreasuryPct: row.autoAllocateTreasuryPct,
      requireTotp: row.requireTotp,
      requireDualApproval: row.requireDualApproval,
      blockHighRiskCorridors: row.blockHighRiskCorridors,
      notifyOnSettlement: row.notifyOnSettlement,
      approvalChannel: channel(row.approvalChannel, 'code'),
      whatsappEnabled: row.whatsappEnabled,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch (error) {
    // Strict defaults on a read failure, never permissive ones. A database
    // blip must not silently turn dual approval off.
    console.error('[org-settings] read failed, falling back to strict defaults', error);
    return { ...DEFAULT_ORG_SETTINGS };
  }
}

export class SettingsInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsInvariantError';
  }
}

/**
 * Write one org's settings.
 *
 * `updatedBy` is the authenticated admin, from the session. It is the answer to
 * "who lowered the approval threshold last Tuesday", which is a question that
 * gets asked exactly once, after something has already gone wrong.
 */
export async function saveOrgSettings(
  orgId: string,
  patch: Partial<OrgSettings> & Record<string, unknown>,
  updatedBy: string,
): Promise<OrgSettings> {
  const current = await readOrgSettings(orgId);

  const next: OrgSettings = {
    perTransferLimitUsd: clamp(patch.perTransferLimitUsd, current.perTransferLimitUsd, 1, 10_000_000),
    dailyLimitUsd: clamp(patch.dailyLimitUsd, current.dailyLimitUsd, 1, 100_000_000),
    approvalThresholdUsd: clamp(patch.approvalThresholdUsd, current.approvalThresholdUsd, 1, 10_000_000),
    autoAllocateTreasuryPct: clamp(patch.autoAllocateTreasuryPct, current.autoAllocateTreasuryPct, 0, 100),
    requireTotp: bool(patch.requireTotp, current.requireTotp),
    requireDualApproval: bool(patch.requireDualApproval, current.requireDualApproval),
    blockHighRiskCorridors: bool(patch.blockHighRiskCorridors, current.blockHighRiskCorridors),
    notifyOnSettlement: bool(patch.notifyOnSettlement, current.notifyOnSettlement),
    approvalChannel: channel(patch.approvalChannel, current.approvalChannel),
    whatsappEnabled: bool(patch.whatsappEnabled, current.whatsappEnabled),
    updatedBy,
    updatedAt: new Date().toISOString(),
  };

  // Not typos — policies that cannot be satisfied.
  if (next.dailyLimitUsd < next.perTransferLimitUsd) {
    throw new SettingsInvariantError(
      'Daily limit must be greater than or equal to the per-transfer limit.',
    );
  }
  if (next.approvalThresholdUsd > next.perTransferLimitUsd) {
    throw new SettingsInvariantError(
      'Approval threshold cannot exceed the per-transfer limit — it would never be reached.',
    );
  }

  if (!process.env.DATABASE_URL) return next;

  const { getDb } = await import('@/lib/db/client');
  await getDb()
    .insert(orgSettings)
    .values({
      orgId,
      perTransferLimitUsd: next.perTransferLimitUsd,
      dailyLimitUsd: next.dailyLimitUsd,
      approvalThresholdUsd: next.approvalThresholdUsd,
      autoAllocateTreasuryPct: next.autoAllocateTreasuryPct,
      requireTotp: next.requireTotp,
      requireDualApproval: next.requireDualApproval,
      blockHighRiskCorridors: next.blockHighRiskCorridors,
      notifyOnSettlement: next.notifyOnSettlement,
      approvalChannel: next.approvalChannel,
      whatsappEnabled: next.whatsappEnabled,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgSettings.orgId,
      set: {
        perTransferLimitUsd: next.perTransferLimitUsd,
        dailyLimitUsd: next.dailyLimitUsd,
        approvalThresholdUsd: next.approvalThresholdUsd,
        autoAllocateTreasuryPct: next.autoAllocateTreasuryPct,
        requireTotp: next.requireTotp,
        requireDualApproval: next.requireDualApproval,
        blockHighRiskCorridors: next.blockHighRiskCorridors,
        notifyOnSettlement: next.notifyOnSettlement,
        approvalChannel: next.approvalChannel,
        whatsappEnabled: next.whatsappEnabled,
        updatedBy,
        updatedAt: new Date(),
      },
    });

  return next;
}
