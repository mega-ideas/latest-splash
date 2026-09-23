/**
 * A workspace of one's own.
 *
 * ─── What this replaces ─────────────────────────────────────────────────────
 *
 * Every zkLogin sign-in wrote its user and wallet identity with
 * `orgId: DEFAULT_ORG_ID` — the literal `'demo-business'`. So every person who
 * signed in with Google was filed under the same organisation.
 *
 * The damage was bounded by an accident rather than a decision: zkLogin grants
 * no membership, and `resolveAuthorityForSession` reads authority from the
 * membership row, so a new signer could authorise nothing. But their identity
 * and their Sui address sat in the demo org's namespace, and the moment anyone
 * granted that user a role they would have landed inside it.
 *
 * A new signer gets their own org now, in REGISTERED — which is the state that
 * can do nothing until KYB completes.
 *
 * ─── Why the org id is derived, not random ──────────────────────────────────
 *
 * Two people from the same company signing in should land in the SAME
 * workspace, not two. The email domain is the only signal available at sign-in
 * that says "these two work together", and getting it wrong in the safe
 * direction means a colleague waits for an invite rather than silently getting
 * access to a stranger's payments.
 *
 * Public mailbox domains are deliberately excluded: two people with gmail
 * addresses are not colleagues, and treating them as such would put strangers
 * in one workspace — the exact defect being fixed.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { organizations } from '@/lib/db/schema';

/**
 * Domains that say nothing about who someone works with.
 *
 * Not exhaustive and does not need to be: an unlisted public domain costs a
 * user their own workspace, which is the harmless outcome. A listed corporate
 * domain would cost a stranger access, which is not.
 */
const PUBLIC_MAILBOX_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'proton.me',
  'protonmail.com', 'aol.com', 'gmx.com', 'mail.com', 'yandex.com',
  'qq.com', '163.com', 'zoho.com', 'fastmail.com', 'hey.com',
]);

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export type WorkspaceIdentity = {
  orgId: string;
  /** What to call it before anyone has filled in a legal name. */
  displayName: string;
  /** True when this is a shared-company workspace rather than a personal one. */
  shared: boolean;
};

/**
 * Which workspace this email belongs to.
 *
 * Pure — the caller decides whether to create it. Kept separate so the
 * behaviour is testable without a database, and so the rule is readable in one
 * place rather than inferred from an insert.
 */
export function workspaceForEmail(email: string): WorkspaceIdentity {
  const normalised = email.trim().toLowerCase();
  const [local, domain] = normalised.split('@');

  if (!domain || PUBLIC_MAILBOX_DOMAINS.has(domain)) {
    // A personal workspace, keyed by the whole address. Two gmail users are not
    // colleagues, and putting them together is the defect this file fixes.
    return {
      orgId: `org-${slug(normalised)}`,
      displayName: local ? `${local}'s workspace` : 'New workspace',
      shared: false,
    };
  }

  return {
    orgId: `org-${slug(domain)}`,
    // The domain, not a guessed company name. A legal name arrives with KYB and
    // inventing one here would put a fiction on a compliance record.
    displayName: domain,
    shared: true,
  };
}

/**
 * Find or create the workspace, in REGISTERED.
 *
 * REGISTERED is the state that can do nothing: `canMoveMoney` is true only at
 * ACTIVE, and reaching ACTIVE needs both the provider's verdict and a human
 * sign-off. A new sign-up therefore lands somewhere real and inert.
 *
 * Never grants a membership. Authority comes from a membership row and this
 * function does not hand any out — a workspace you are the only person in is
 * still a workspace you cannot move money from until KYB completes.
 */
export async function ensureWorkspaceForEmail(email: string): Promise<WorkspaceIdentity> {
  const workspace = workspaceForEmail(email);
  if (!process.env.DATABASE_URL) return workspace;

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, workspace.orgId))
    .limit(1);
  if (existing.length > 0) return workspace;

  await db
    .insert(organizations)
    .values({
      id: workspace.orgId,
      name: workspace.displayName,
      // Explicit rather than relying on the column default, because this is the
      // security-relevant half: a workspace that arrived at any other state
      // without KYB would be one that can move money.
      kybLifecycle: 'REGISTERED',
    })
    .onConflictDoNothing({ target: organizations.id });

  return workspace;
}
