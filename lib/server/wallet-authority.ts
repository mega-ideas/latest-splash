/**
 * The Business Splash Wallet's off-chain authority (v2 §4.1, Sky's answers of
 * 25 Oct), beside the multisig itself:
 *
 *   The person in charge   An off-chain role an OWNER appoints and revokes,
 *                          per business. With the owners, the "highest
 *                          authority". It moves no money and signs nothing on
 *                          chain; it can sign off a staff member's migration.
 *   Migration sign-off     A staff member (anyone who is not an owner) may move
 *                          the USDC in their own passkey wallet into the
 *                          business wallet only once the highest authority has
 *                          signed off. The approver's passkey signs a statement
 *                          naming the business, the member, the wallet the USDC
 *                          leaves, the business wallet it goes to, a nonce and
 *                          an expiry (24 hours). Nobody signs off their own
 *                          move. It covers that one source and destination
 *                          until it expires (a large wallet may take more than
 *                          one transfer); a rotation is a new destination.
 *                          Revoking a person in charge voids what they signed.
 *   The audit trail        Every appointment, revocation, sign-off and approval
 *                          ask goes to `wallet_authority_events`, which the
 *                          database keeps append-only (migration 0035).
 *
 * Owners are memberships with role admin. Every read and write takes the
 * caller's org, and a person or row of another org reads as absent.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

import { memberships, passkeyCredentials, walletAuthorityEvents, walletMigrationSignoffs, walletOffboardedSpenders, walletPersonsInCharge } from '../db/schema.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type AuthorityAction =
  | 'person_in_charge_appointed'
  | 'person_in_charge_revoked'
  | 'migration_sign_off_prepared'
  | 'migration_signed_off'
  | 'migration_sign_off_used'
  | 'migration_sign_off_voided'
  | 'approval_requested'
  | 'approval_accepted'
  | 'approval_declined'
  | 'approval_withdrawn'
  | 'approval_completed'
  | 'member_offboarded'
  | 'spending_rules_revoke_opened';

export type AuthorityFailure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): AuthorityFailure => ({ ok: false, status, code, error });
type Clock = () => Date;
const clock = (now?: Clock) => (now ?? (() => new Date()))();

/** How long a migration sign-off stays usable. */
export const SIGN_OFF_TTL_MS = 24 * 60 * 60 * 1000;

// ─── The audit trail ────────────────────────────────────────────────────────

export async function recordAuthorityEvent(
  db: DrizzleDb,
  e: { orgId: string; actorUserId: string; action: AuthorityAction; subjectUserId?: string | null; ref?: string | null; detail?: Record<string, unknown>; now?: Clock },
): Promise<void> {
  await db.insert(walletAuthorityEvents).values({
    id: `wae_${randomUUID()}`,
    orgId: e.orgId,
    actorUserId: e.actorUserId,
    action: e.action,
    subjectUserId: e.subjectUserId ?? null,
    ref: e.ref ?? null,
    detail: e.detail ?? {},
    createdAt: clock(e.now),
  });
}

export type AuthorityEvent = { id: string; actorUserId: string; action: string; subjectUserId: string | null; ref: string | null; detail: unknown; createdAt: Date };

/** The org's trail, oldest first. */
export async function listAuthorityEvents(db: DrizzleDb, orgId: string, limit = 500): Promise<AuthorityEvent[]> {
  const rows = await db
    .select()
    .from(walletAuthorityEvents)
    .where(eq(walletAuthorityEvents.orgId, orgId))
    .orderBy(desc(walletAuthorityEvents.seq))
    .limit(limit);
  return rows
    .map((r) => ({ id: r.id, actorUserId: r.actorUserId, action: r.action, subjectUserId: r.subjectUserId, ref: r.ref, detail: r.detail, createdAt: r.createdAt }))
    .reverse();
}

// ─── Who holds what ─────────────────────────────────────────────────────────

/** The member's role in this org (maker, checker, admin, viewer), or null. */
export async function memberRole(db: DrizzleDb, orgId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return row ? String(row.role) : null;
}

/** Owner, person in charge, or neither, in this org now. */
export async function highestAuthority(db: DrizzleDb, orgId: string, userId: string): Promise<'owner' | 'person_in_charge' | null> {
  const role = await memberRole(db, orgId, userId);
  if (role === null) return null;
  if (role === 'admin') return 'owner';
  // Only someone who makes or approves payments can be in charge: a viewer
  // never, whatever the appointment table still says.
  if (role !== 'maker' && role !== 'checker') return null;
  const [pic] = await db
    .select({ id: walletPersonsInCharge.id })
    .from(walletPersonsInCharge)
    .where(and(eq(walletPersonsInCharge.orgId, orgId), eq(walletPersonsInCharge.userId, userId), isNull(walletPersonsInCharge.revokedAt)))
    .limit(1);
  return pic ? 'person_in_charge' : null;
}

export async function listPersonsInCharge(db: DrizzleDb, orgId: string): Promise<Array<{ userId: string; grantedBy: string; grantedAt: Date }>> {
  const rows = await db
    .select()
    .from(walletPersonsInCharge)
    .where(and(eq(walletPersonsInCharge.orgId, orgId), isNull(walletPersonsInCharge.revokedAt)));
  return rows.map((r) => ({ userId: r.userId, grantedBy: r.grantedBy, grantedAt: r.grantedAt })).sort((a, b) => a.userId.localeCompare(b.userId));
}

/** An owner appoints a member of this business as a person in charge. */
export async function appointPersonInCharge(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; now?: Clock },
): Promise<{ ok: true } | AuthorityFailure> {
  if ((await memberRole(db, input.orgId, input.actorUserId)) !== 'admin') return fail(403, 'not_an_owner', 'only an owner appoints a person in charge');
  const role = await memberRole(db, input.orgId, input.userId);
  if (role === null) return fail(404, 'not_a_member', 'no such member of this business');
  if (role === 'admin') return fail(409, 'already_an_owner', 'an owner already has the highest authority');
  if (role === 'viewer') return fail(400, 'viewer_cannot_be_in_charge', 'a viewer cannot be put in charge; change their role first');
  if ((await highestAuthority(db, input.orgId, input.userId)) === 'person_in_charge') {
    return fail(409, 'already_appointed', 'this member is already a person in charge');
  }
  const now = clock(input.now);
  try {
    await db.insert(walletPersonsInCharge).values({ id: `wpic_${randomUUID()}`, orgId: input.orgId, userId: input.userId, grantedBy: input.actorUserId, grantedAt: now });
  } catch {
    // Two owners appointing at once: the partial unique index lets one in.
    return fail(409, 'already_appointed', 'this member is already a person in charge');
  }
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'person_in_charge_appointed', subjectUserId: input.userId, now: input.now });
  return { ok: true };
}

/** An owner revokes a person in charge. What they signed off and is still usable is voided. */
export async function revokePersonInCharge(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; userId: string; now?: Clock },
): Promise<{ ok: true; voided: number } | AuthorityFailure> {
  if ((await memberRole(db, input.orgId, input.actorUserId)) !== 'admin') return fail(403, 'not_an_owner', 'only an owner revokes a person in charge');
  const now = clock(input.now);
  const revoked = await db
    .update(walletPersonsInCharge)
    .set({ revokedAt: now, revokedBy: input.actorUserId })
    .where(and(eq(walletPersonsInCharge.orgId, input.orgId), eq(walletPersonsInCharge.userId, input.userId), isNull(walletPersonsInCharge.revokedAt)))
    .returning({ id: walletPersonsInCharge.id });
  if (revoked.length === 0) return fail(404, 'not_in_charge', 'this member is not a person in charge');
  const voided = await db
    .update(walletMigrationSignoffs)
    .set({ voidedAt: now })
    .where(and(eq(walletMigrationSignoffs.orgId, input.orgId), eq(walletMigrationSignoffs.signedBy, input.userId), isNull(walletMigrationSignoffs.voidedAt), gt(walletMigrationSignoffs.expiresAt, now)))
    .returning({ id: walletMigrationSignoffs.id });
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'person_in_charge_revoked', subjectUserId: input.userId, detail: { voidedSignOffs: voided.length }, now: input.now });
  for (const v of voided) {
    await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'migration_sign_off_voided', subjectUserId: input.userId, ref: v.id, now: input.now });
  }
  return { ok: true, voided: voided.length };
}

// ─── Offboarding ────────────────────────────────────────────────────────────

/** Every Sui address a user has a passkey wallet at, active or retired: who an address on chain is. */
export async function passkeyAddressesOf(db: DrizzleDb, userId: string): Promise<string[]> {
  const rows = await db.select({ address: passkeyCredentials.suiAddress }).from(passkeyCredentials).where(eq(passkeyCredentials.userId, userId));
  return [...new Set(rows.map((r) => normalizeSuiAddress(r.address)))];
}

/**
 * A member leaves a business (their membership is removed; a role change is
 * a removal and a new grant). What Splash holds goes at once: an
 * appointment as person in charge is revoked, and every sign-off they gave
 * or were given that is still usable is voided. What the chain holds cannot
 * be taken back from here: each of their addresses is recorded, so the
 * spending-rule index shows any rule it still has as orphaned until the
 * owners' quorum revokes it (lib/server/spend-rules.ts revokeOrphanedRules).
 * `by` is the actor: an owner's user id, or `operator:<email>`.
 */
export async function offboardMember(
  db: DrizzleDb,
  input: { orgId: string; userId: string; by: string; addresses: string[]; now?: Clock },
): Promise<{ revokedInCharge: boolean; voidedSignOffs: number; addresses: string[] }> {
  const now = clock(input.now);
  const at = () => now;
  const addresses = [...new Set(input.addresses.map((a) => normalizeSuiAddress(a)))];
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.by, action: 'member_offboarded', subjectUserId: input.userId, detail: { addresses }, now: at });
  const revoked = await db
    .update(walletPersonsInCharge)
    .set({ revokedAt: now, revokedBy: input.by })
    .where(and(eq(walletPersonsInCharge.orgId, input.orgId), eq(walletPersonsInCharge.userId, input.userId), isNull(walletPersonsInCharge.revokedAt)))
    .returning({ id: walletPersonsInCharge.id });
  if (revoked.length > 0) {
    await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.by, action: 'person_in_charge_revoked', subjectUserId: input.userId, detail: { reason: 'membership_removed' }, now: at });
  }
  const voided = await db
    .update(walletMigrationSignoffs)
    .set({ voidedAt: now })
    .where(
      and(
        eq(walletMigrationSignoffs.orgId, input.orgId),
        or(eq(walletMigrationSignoffs.signedBy, input.userId), eq(walletMigrationSignoffs.memberUserId, input.userId)),
        isNull(walletMigrationSignoffs.voidedAt),
        gt(walletMigrationSignoffs.expiresAt, now),
      ),
    )
    .returning({ id: walletMigrationSignoffs.id });
  for (const v of voided) {
    await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.by, action: 'migration_sign_off_voided', subjectUserId: input.userId, ref: v.id, detail: { reason: 'membership_removed' }, now: at });
  }
  for (const address of addresses) {
    await db.insert(walletOffboardedSpenders).values({ id: `wofs_${randomUUID()}`, orgId: input.orgId, userId: input.userId, address, reason: 'removed', offboardedBy: input.by, offboardedAt: now });
  }
  return { revokedInCharge: revoked.length > 0, voidedSignOffs: voided.length, addresses };
}

// ─── Migration sign-off ─────────────────────────────────────────────────────

/** The statement the approver's passkey signs. Every field is bound. */
export function signOffMessage(s: { orgId: string; memberUserId: string; fromAddress: string; toWallet: string; nonce: string; expiresAt: Date }): string {
  return [
    'Splash: I approve this member moving their USDC into the business wallet.',
    `Business: ${s.orgId}`,
    `Member: ${s.memberUserId}`,
    'Asset: USDC',
    `From: ${normalizeSuiAddress(s.fromAddress)}`,
    `To: ${normalizeSuiAddress(s.toWallet)}`,
    `Nonce: ${s.nonce}`,
    `Expires: ${s.expiresAt.toISOString()}`,
  ].join('\n');
}

/**
 * The highest authority starts a sign-off: Splash writes the statement, with
 * a fresh nonce, for their passkey to sign. Not for an owner's own move (an
 * owner needs none) and never for the approver's own.
 */
export async function prepareMigrationSignOff(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; memberUserId: string; fromAddress: string; toWallet: string; now?: Clock },
): Promise<{ ok: true; signOff: { id: string; message: string; expiresAt: string } } | AuthorityFailure> {
  if (!(await highestAuthority(db, input.orgId, input.actorUserId))) {
    return fail(403, 'not_the_highest_authority', 'only an owner or the person in charge signs off a migration');
  }
  const memberRoleNow = await memberRole(db, input.orgId, input.memberUserId);
  if (memberRoleNow === null) return fail(404, 'not_a_member', 'no such member of this business');
  if (input.memberUserId === input.actorUserId) return fail(409, 'self_sign_off', 'someone else with the highest authority signs off your own move');
  if (memberRoleNow === 'admin') return fail(409, 'not_needed', 'an owner moves their own USDC without a sign-off');
  let from: string;
  let to: string;
  try {
    from = normalizeSuiAddress(input.fromAddress);
    to = normalizeSuiAddress(input.toWallet);
  } catch {
    return fail(400, 'bad_address', 'an address could not be read');
  }
  if (!/^0x[0-9a-f]{64}$/.test(from) || !/^0x[0-9a-f]{64}$/.test(to)) return fail(400, 'bad_address', 'an address could not be read');
  const now = clock(input.now);
  const expiresAt = new Date(now.getTime() + SIGN_OFF_TTL_MS);
  const nonce = randomBytes(16).toString('hex');
  const id = `wmso_${randomUUID()}`;
  const message = signOffMessage({ orgId: input.orgId, memberUserId: input.memberUserId, fromAddress: from, toWallet: to, nonce, expiresAt });
  await db.insert(walletMigrationSignoffs).values({
    id,
    orgId: input.orgId,
    memberUserId: input.memberUserId,
    fromAddress: from,
    toWallet: to,
    signedBy: input.actorUserId,
    message,
    nonce,
    expiresAt,
    createdAt: now,
  });
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'migration_sign_off_prepared', subjectUserId: input.memberUserId, ref: id, detail: { from, to }, now: input.now });
  return { ok: true, signOff: { id, message, expiresAt: expiresAt.toISOString() } };
}

/**
 * The approver sends their passkey's signature over the statement. It must
 * verify under `signerAddress`, which the caller reads from the approver's
 * own active passkey on this site, never from the request.
 */
export async function signMigrationSignOff(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; id: string; signature: string; signerAddress: string; now?: Clock },
): Promise<{ ok: true } | AuthorityFailure> {
  const [row] = await db
    .select()
    .from(walletMigrationSignoffs)
    .where(and(eq(walletMigrationSignoffs.orgId, input.orgId), eq(walletMigrationSignoffs.id, input.id), eq(walletMigrationSignoffs.signedBy, input.actorUserId)))
    .limit(1);
  if (!row) return fail(404, 'not_found', 'no such sign-off');
  const now = clock(input.now);
  if (row.signedAt) return fail(409, 'already_signed', 'this sign-off is already signed');
  if (row.voidedAt) return fail(409, 'voided', 'this sign-off was voided');
  if (row.expiresAt.getTime() <= now.getTime()) return fail(410, 'expired', 'this sign-off has expired; start a new one');
  if (!(await highestAuthority(db, input.orgId, input.actorUserId))) {
    return fail(403, 'not_the_highest_authority', 'only an owner or the person in charge signs off a migration');
  }
  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(row.message), String(input.signature ?? ''), { address: normalizeSuiAddress(input.signerAddress) });
  } catch {
    return fail(400, 'bad_signature', 'that signature is not your passkey signing this statement');
  }
  const signed = await db
    .update(walletMigrationSignoffs)
    .set({ signature: input.signature, signerAddress: normalizeSuiAddress(input.signerAddress), signedAt: now })
    .where(and(eq(walletMigrationSignoffs.id, row.id), isNull(walletMigrationSignoffs.signedAt), isNull(walletMigrationSignoffs.voidedAt)))
    .returning({ id: walletMigrationSignoffs.id });
  if (signed.length === 0) return fail(409, 'already_signed', 'this sign-off changed while you signed it');
  await recordAuthorityEvent(db, {
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action: 'migration_signed_off',
    subjectUserId: row.memberUserId,
    ref: row.id,
    detail: { from: row.fromAddress, to: row.toWallet, signer: normalizeSuiAddress(input.signerAddress) },
    now: input.now,
  });
  return { ok: true };
}

/**
 * May this member move the USDC at `fromAddress` into `toWallet` now? An
 * owner: yes. Anyone else: only with a signed, unexpired, unvoided sign-off
 * for exactly that source and destination, whose signer still holds the
 * highest authority.
 */
export async function migrationClearance(
  db: DrizzleDb,
  input: { orgId: string; userId: string; fromAddress: string; toWallet: string; now?: Clock },
): Promise<{ ok: true; signedOffBy: string | null; signOffId: string | null } | AuthorityFailure> {
  const role = await memberRole(db, input.orgId, input.userId);
  if (role === null) return fail(404, 'not_a_member', 'no such member of this business');
  if (role === 'admin') return { ok: true, signedOffBy: null, signOffId: null };
  const now = clock(input.now);
  const rows = await db
    .select()
    .from(walletMigrationSignoffs)
    .where(
      and(
        eq(walletMigrationSignoffs.orgId, input.orgId),
        eq(walletMigrationSignoffs.memberUserId, input.userId),
        eq(walletMigrationSignoffs.fromAddress, normalizeSuiAddress(input.fromAddress)),
        eq(walletMigrationSignoffs.toWallet, normalizeSuiAddress(input.toWallet)),
        isNotNull(walletMigrationSignoffs.signedAt),
        isNull(walletMigrationSignoffs.voidedAt),
        gt(walletMigrationSignoffs.expiresAt, now),
      ),
    );
  for (const row of rows) {
    if (row.signedBy === input.userId) continue;
    if (await highestAuthority(db, input.orgId, row.signedBy)) return { ok: true, signedOffBy: row.signedBy, signOffId: row.id };
  }
  return fail(409, 'sign_off_needed', 'an owner or the person in charge signs off before you move your USDC into the business wallet');
}
