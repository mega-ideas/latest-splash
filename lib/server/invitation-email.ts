/**
 * Emailing an invitation, once (v2 Phase 3, p3-invite-email).
 *
 * Sky's decision of 1 Nov: people who are invited also get an email, through
 * Resend. The email is a courtesy; the invitation in the app is the invitation.
 * So:
 *
 *   - The invitation is made first (lib/server/team-invitations.ts) and stands
 *     whatever happens here. A failed, refused or unconfigured send loses
 *     nothing: the person sees the invitation after signing in.
 *   - The send is CLAIMED with one UPDATE that moves `email_state` to
 *     `sending`. Only the call that wins the claim sends, so a retry, a double
 *     click, two owners and two servers cannot send twice. The outcome is
 *     recorded on the invitation (`sent` with the time and the provider's
 *     message id, `failed`, or `not_configured`).
 *   - The first send claims only an invitation never tried. Sending again is an
 *     OWNER's click: it claims a failed, not-configured or never-tried one, or
 *     one whose outcome was never reported for 5 minutes. A sent one is never
 *     sent again. Neither works after the invitation ends or is withdrawn.
 *   - The provider is given an idempotency key (the invitation and the attempt),
 *     so even a send whose outcome was lost and is claimed again is recognised
 *     and dropped by the provider, not delivered twice.
 *   - A send whose outcome is not known (a timeout, a lost connection, a server
 *     error, or an email that went but could not be recorded) stays `sending`:
 *     it is not shown as failed and not sent again at once, and when it is
 *     claimed again after 5 minutes the provider gets the SAME key. Only an
 *     answered refusal (a client error) is `failed`, and only then is the next
 *     attempt a new one with a new key.
 *   - A withdrawal or an end that lands between the claim and the send stops it.
 *   - Nothing reaches a log but the invitation's id and the kind of failure (the
 *     HTTP status or the error's name): no key, no address, no link. A send that
 *     could not go because email is not set up is logged too, with the reason.
 *   - The link is made only where production would allow one (https, a public
 *     name). Otherwise nothing is sent and the owner is told email is not set up.
 *
 * The business and the actor are the caller's (the session, in the routes). An
 * invitation of another business reads as absent.
 */
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import { invitationLink } from '../approve/link.ts';
import { EmailDeliveryError, resolveEmailTransport, type EmailTransport } from '../auth/email-transport.ts';
import { organizations, teamInvitations, users } from '../db/schema.ts';
import { SEND_STALE_MS, invitationEmail, inviteEmailWire, type InviteEmailState } from '../team/invitation-email.ts';
import { fail, teamManager, type TeamFailure } from './team-admin.ts';
import { EXPIRED, NO_LONGER_OPEN } from './team-invitations.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type InviteEmailResult = { ok: true; state: InviteEmailState; sent: boolean; sentAt: string | null } | TeamFailure;

type Input = {
  orgId: string;
  invitationId: string;
  actorUserId: string;
  now?: () => Date;
  /** The environment. A parameter so tests pass literal objects. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** A sender to use. `undefined` asks the environment; `null` means none is set up. */
  transport?: EmailTransport | null;
};

/** The real sender the environment names, or null when none is set up here. A console sender is a line in a terminal, not an email. */
function realTransport(env: Input['env']): EmailTransport | null {
  try {
    const transport = resolveEmailTransport(env as NodeJS.ProcessEnv);
    return transport.name === 'resend' ? transport : null;
  } catch {
    return null;
  }
}

const NOT_YOURS_TO_SEND = () => fail(403, 'owner_only', 'Only an owner can send an invitation email again.');

async function run(db: DrizzleDb, input: Input, mode: 'first' | 'again'): Promise<InviteEmailResult> {
  const now = (input.now ?? (() => new Date()))();
  const env = input.env ?? process.env;

  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (!manager) return fail(403, 'not_allowed', 'Only an owner or the Finance lead can send an invitation.');
  if (mode === 'again' && manager !== 'owner') return NOT_YOURS_TO_SEND();

  // Another business's invitation reads as absent.
  const [inv] = await db
    .select()
    .from(teamInvitations)
    .where(and(eq(teamInvitations.id, String(input.invitationId)), eq(teamInvitations.orgId, input.orgId)))
    .limit(1);
  if (!inv) return fail(404, 'not_found', 'That invitation was not found.');
  if (inv.status === 'expired' || (inv.status === 'pending' && inv.expiresAt.getTime() <= now.getTime())) return EXPIRED();
  if (inv.status !== 'pending') return NO_LONGER_OPEN();

  // The claim. One UPDATE; whoever it changes a row for sends, nobody else does.
  const untried = isNull(teamInvitations.emailState);
  const claimable =
    mode === 'first'
      ? untried
      : or(
          untried,
          sql`${teamInvitations.emailState} in ('failed', 'not_configured')`,
          and(eq(teamInvitations.emailState, 'sending'), lte(teamInvitations.emailAttemptAt, new Date(now.getTime() - SEND_STALE_MS))),
        );
  const claimed = await db
    .update(teamInvitations)
    .set({
      emailState: 'sending',
      emailAttemptAt: now,
      // A new attempt is a new provider key. Claiming again a send whose outcome was never known keeps the key, so the provider can drop the repeat.
      emailAttempts: sql`case when ${teamInvitations.emailState} = 'sending' then ${teamInvitations.emailAttempts} else ${teamInvitations.emailAttempts} + 1 end`,
    })
    .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.orgId, input.orgId), eq(teamInvitations.status, 'pending'), gt(teamInvitations.expiresAt, now), claimable))
    .returning({ attempts: teamInvitations.emailAttempts });

  if (claimed.length === 0) {
    // Someone else holds it, or it has gone already: say how it stands and send nothing.
    const [current] = await db.select().from(teamInvitations).where(eq(teamInvitations.id, inv.id)).limit(1);
    if (!current) return fail(404, 'not_found', 'That invitation was not found.');
    if (current.status !== 'pending') return NO_LONGER_OPEN();
    const wire = inviteEmailWire(current, { now, owner: true });
    return { ok: true, state: wire.state, sent: false, sentAt: wire.sentAt };
  }
  const attempt = claimed[0].attempts;

  const settle = async (state: 'sent' | 'failed' | 'not_configured', extra: { emailSentAt?: Date; emailMessageRef?: string | null } = {}) => {
    // Only this attempt's own claim may record its outcome.
    await db
      .update(teamInvitations)
      .set({ emailState: state, ...extra })
      .where(and(eq(teamInvitations.id, inv.id), eq(teamInvitations.emailState, 'sending'), eq(teamInvitations.emailAttempts, attempt)));
  };

  const transport = input.transport === undefined ? realTransport(env) : input.transport;
  const link = invitationLink(env.NEXT_PUBLIC_APP_URL, inv.id, { NODE_ENV: env.NODE_ENV });
  if (!transport || transport.name !== 'resend' || !link) {
    // Nobody operating the platform sees the owner's alert, so the log says why nothing went: the invitation and the reason, never an address or a link.
    const reason = !transport || transport.name !== 'resend' ? 'no email sender is set up' : 'the app address cannot be used in a link';
    console.warn(`[invitation-email] the email for ${inv.id} was not sent (${reason})`);
    await settle('not_configured');
    return { ok: true, state: 'not_configured', sent: false, sentAt: null };
  }

  // Preparing the message. Nothing has been sent yet, so anything that goes wrong here is a plain failure.
  let message: ReturnType<typeof invitationEmail>;
  try {
    const [inviter] = await db.select({ name: users.name }).from(users).where(eq(users.id, inv.invitedBy)).limit(1);
    const [business] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, inv.orgId)).limit(1);
    // A withdrawal or an end that landed since the claim stops the email: it would only be a pointless message about a closed invitation.
    const [still] = await db.select({ status: teamInvitations.status }).from(teamInvitations).where(eq(teamInvitations.id, inv.id)).limit(1);
    if (!still || still.status !== 'pending') {
      await settle('failed');
      return NO_LONGER_OPEN();
    }
    message = invitationEmail({ inviterName: inviter?.name ?? '', businessName: business?.name ?? '', link, expiresAt: inv.expiresAt, now });
  } catch (error) {
    console.warn(`[invitation-email] the email for ${inv.id} was not sent (${errorKind(error)})`);
    await settle('failed').catch(() => undefined);
    return { ok: true, state: 'failed', sent: false, sentAt: null };
  }

  let providerRef: string | null;
  try {
    const result = await transport.sendMessage({
      to: inv.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
      idempotencyKey: `splash-invitation-${inv.id}-${attempt}`,
    });
    providerRef = result.providerRef;
  } catch (error) {
    if (refusedByProvider(error)) {
      // The provider answered and said no: the message did not go, and the next attempt is a new one with a new key.
      console.warn(`[invitation-email] the email for ${inv.id} was not sent (${errorKind(error)})`);
      await settle('failed');
      return { ok: true, state: 'failed', sent: false, sentAt: null };
    }
    // A timeout, a lost connection or a server error: the provider may well have the message. The row stays "sending", so
    // the owner is not told it failed, a click cannot send a second email at once, and once the window passes the next
    // attempt reuses this key, which the provider recognises as the same message.
    console.warn(`[invitation-email] the email for ${inv.id} may or may not have gone (${errorKind(error)})`);
    return { ok: true, state: 'sending', sent: false, sentAt: null };
  }

  try {
    await settle('sent', { emailSentAt: now, emailMessageRef: providerRef });
  } catch (error) {
    // The email went; only the record of it did not. Leave it "sending" (not "failed"): a repeat then carries the same key.
    console.warn(`[invitation-email] the email for ${inv.id} went but could not be recorded (${errorKind(error)})`);
    return { ok: true, state: 'sending', sent: true, sentAt: now.toISOString() };
  }
  return { ok: true, state: 'sent', sent: true, sentAt: now.toISOString() };
}

/** What may be logged about a failure: the HTTP status the provider gave, or the error's name. Never its words, which can quote the key or the address. */
function errorKind(error: unknown): string {
  if (error instanceof EmailDeliveryError && error.status) return `HTTP ${error.status}`;
  return error instanceof Error ? error.name : 'unknown error';
}

/** The provider answered, and the answer was a refusal of this message (a client error), not a busy or slow server. */
function refusedByProvider(error: unknown): boolean {
  if (!(error instanceof EmailDeliveryError) || error.status === null) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409;
}

/** The first send, right after the invitation is made. Claims only an invitation never tried, so a retry of the invitation sends nothing. */
export function deliverInvitationEmail(db: DrizzleDb, input: Input): Promise<InviteEmailResult> {
  return run(db, input, 'first');
}

/** An owner's click on "Send the email again". At most one send per click, and none for an invitation that was sent, ended or withdrawn. */
export function resendInvitationEmail(db: DrizzleDb, input: Input): Promise<InviteEmailResult> {
  return run(db, input, 'again');
}
