/**
 * When nobody who can approve answers (v2 Phase 3, p3-no-approver; Sky's question).
 *
 * Money is never approved by default, by Splash, or by a timer. A request that waits for people who can
 * approve it (a payment the rules send to the owners, a staff payment above the second-approval line, a
 * batch, a withdrawal, an automatic run handed back to "ask me first") does exactly four things while it
 * waits, and one when it runs out:
 *
 *   0 minutes   every person who can approve it is told, in the app and by e-mail;
 *   10 minutes  they are told again, and the person who asked is told plainly who was asked and that
 *               nobody has answered yet;
 *   1 hour      they are reminded;
 *   4 hours     they are reminded;
 *   at its end  the request lapses UNPAID: "Nobody approved in time. Nothing was paid. Ask again." The
 *               person who asked and the owners are told, and a late approval is refused in the same words.
 *
 * Every time below is a constant in THIS file. The schedule is read by the existing cron
 * (/api/cron/wallet-signing); no timer lives anywhere, so a restart or a second instance cannot lose or
 * double a step (each step is one row, lib/server/approval-wait.ts). The words are here too, pure and
 * client-safe: no amount, no payee, no address and no secret ever goes into a notice. The one link is the
 * signed-in Approve page; opening it signs nothing.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** The steps of the ladder, each the age of the request at which it is due. The one place the timing is written. */
export const LADDER = [
  { step: 'asked', afterMs: 0 },
  { step: 'reminder_10m', afterMs: 10 * MINUTE_MS },
  { step: 'reminder_1h', afterMs: HOUR_MS },
  { step: 'reminder_4h', afterMs: 4 * HOUR_MS },
] as const;

export type LadderStep = (typeof LADDER)[number]['step'];
/** Every step a request can have recorded: the ladder, the lapse, and each "Remind them now". */
export type WaitStep = LadderStep | 'lapsed' | `manual_${number}`;
export type WaitKind = 'signing' | 'ask';

/** "Remind them now" may be used once in this long, per request. */
export const REMIND_NOW_COOLDOWN_MS = 10 * MINUTE_MS;

/** A lapse is told for a request that ended in this long; an older one is history, not news. */
export const LAPSE_NOTICE_WINDOW_MS = 7 * 24 * HOUR_MS;

/** How long the notices stay on the Approve page. */
export const NOTICE_SHOWN_MS = 7 * 24 * HOUR_MS;

/** The fewest people who should be able to approve payments. Below it the owners are warned; nothing is blocked. */
export const MIN_APPROVERS = 3;

/** What a request that nobody approved in time says, to the person who asked and to the owners, and to a late approver. */
export const LAPSE_WORDS = 'Nobody approved in time. Nothing was paid. Ask again.';

/**
 * What a refusal says about a request that is not open any more: for one that RAN OUT, the lapse words (the same
 * as the notice, so a late approver is told what the owners were told); for any other state, its state.
 */
export function closedWords(what: 'request' | 'ask', status: string): string {
  return status === 'expired' ? LAPSE_WORDS : `this ${what} is ${status}`;
}

/**
 * Which step to send now, or none.
 *
 * "Asked" goes first, always: the approvers must hear it before any reminder. After that, the latest step that
 * is due and not yet sent: a cron that was down for an hour sends the 1 hour reminder once, not three
 * reminders at once. A step already recorded is never sent again.
 */
export function stepToSend(ageMs: number, done: ReadonlySet<string>): LadderStep | null {
  if (!done.has('asked')) return 'asked';
  let due: LadderStep | null = null;
  for (const { step, afterMs } of LADDER) if (ageMs >= afterMs) due = step;
  if (due === null || done.has(due)) return null;
  // A later step already sent means an earlier one is never made up.
  const order = LADDER.map((l) => l.step as string);
  const latestDone = Math.max(-1, ...[...done].map((s) => order.indexOf(s)));
  return order.indexOf(due) > latestDone ? due : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "14:30 UTC on 3 November": the same words for everyone, whatever their time zone. */
export function utcWhen(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC on ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** "10 minutes", "1 hour", "4 hours", "2 days". */
export function waitedFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

const WHAT: Record<string, string> = {
  wallet_payment: 'a payment from the business wallet',
  wallet_batch: 'a batch of payments',
  withdrawal: 'a withdrawal to the business bank account',
  partner_payout: 'a payment to a supplier’s bank account',
  spend_approval: 'a second approval for a payment',
  staff_rule_payment: 'a payment under a spending rule',
  spend_rule: 'a change to a spending rule',
  spend_policy: 'new spending rules',
  migration_transfer: 'a move of USDC into the business wallet',
  rotation_transfer: 'a move of USDC to the new business wallet',
  partner_test_deposit: 'a small test deposit',
  subscription: 'a change to the Splash billing allowance',
};

/** What is waiting, in a few plain words and without an amount or a payee. */
export function whatIsWaiting(kind: WaitKind, purpose?: string | null): string {
  if (kind === 'ask') return 'a payment a team member asked the owners to approve';
  return WHAT[purpose ?? ''] ?? 'a request for the business wallet';
}

/** One notice, before it is addressed to a person. */
export type NoticeWords = { title: string; body: string };

type Facts = {
  kind: WaitKind;
  purpose?: string | null;
  /** The person who asked, as "Name (Title)", or null where they cannot be named. */
  requester: string | null;
  expiresAt: Date;
};

const openLine = 'Open it, check the details and approve it with your passkey. Nothing is paid unless it is approved.';
const theRequester = (f: Facts) => f.requester ?? 'A member of your team';

/** Step 0, to each person who can approve. */
export function askedNotice(f: Facts): NoticeWords {
  const what = whatIsWaiting(f.kind, f.purpose);
  return {
    title: `Needs your approval: ${what}`,
    body: `${theRequester(f)} asked for ${what}.\n\n${openLine} It stays open until ${utcWhen(f.expiresAt)}.`,
  };
}

/** The reminders at 10 minutes, 1 hour and 4 hours, to each person who can still approve. */
export function reminderNotice(f: Facts, step: Exclude<LadderStep, 'asked'>): NoticeWords {
  const what = whatIsWaiting(f.kind, f.purpose);
  const waited = step === 'reminder_10m' ? waitedFor(10 * MINUTE_MS) : step === 'reminder_1h' ? waitedFor(HOUR_MS) : waitedFor(4 * HOUR_MS);
  const ends = step === 'reminder_4h' ? ` If nobody approves it before ${utcWhen(f.expiresAt)}, it ends and nothing is paid.` : ` It stays open until ${utcWhen(f.expiresAt)}.`;
  return {
    title: `Still waiting for your approval: ${what}`,
    body: `${theRequester(f)} asked for ${what}, and it has been waiting ${waited}.\n\n${openLine}${ends}`,
  };
}

/** The 10 minute notice to the person who asked: who was asked, and that nobody has answered yet. */
export function requesterNotice(f: Facts, asked: string[]): NoticeWords {
  const what = whatIsWaiting(f.kind, f.purpose);
  const who = asked.length === 0 ? 'Nobody who can approve it was found' : `We asked ${listOf(asked)}`;
  return {
    title: `Nobody has answered yet: ${what}`,
    body:
      `Nobody has answered your request for ${what} yet.\n\n${who}${asked.length === 0 ? '' : ' and told them again'}. ` +
      `You can remind them from the Approve page, or cancel the request. If nobody approves it before ${utcWhen(f.expiresAt)}, it ends and nothing is paid.`,
  };
}

/** "Remind them now", to each person who can still approve. */
export function manualNotice(f: Facts, by: string | null): NoticeWords {
  const what = whatIsWaiting(f.kind, f.purpose);
  return {
    title: `Reminder: ${what} is waiting for your approval`,
    body: `${by ?? 'A member of your team'} reminded you about ${what}.\n\n${openLine} It stays open until ${utcWhen(f.expiresAt)}.`,
  };
}

/** The lapse, to the person who asked and to the owners. */
export function lapseNotice(f: Facts): NoticeWords {
  const what = whatIsWaiting(f.kind, f.purpose);
  return {
    title: `Nobody approved in time: ${what}`,
    body: `${LAPSE_WORDS}\n\nThe request for ${what} ended at ${utcWhen(f.expiresAt)}. Nobody approved it, so it was not paid and cannot be approved now. Ask again from Splash when you are ready.`,
  };
}

/** "A", "A and B", "A, B and C". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The warning the owners see on Limits and on Team when fewer than MIN_APPROVERS people can currently sign for
 * payments (people who really can, with a passkey that works here, not everyone on the team). Null from three up.
 * It blocks nothing.
 */
export function fewApproversWarning(count: number): string | null {
  if (!Number.isFinite(count) || count >= MIN_APPROVERS) return null;
  if (count <= 0) return 'Nobody can approve payments right now. Payments wait until someone can. Add another approver.';
  return `Only ${count} ${count === 1 ? 'person' : 'people'} can approve payments. If they are all away, payments wait. Add another approver.`;
}

/** Where "Add another approver" goes: the add-a-person form in Settings, Team. */
export const ADD_APPROVER_PATH = '/dashboard/settings#add-person';

/** The signed-in page the notices point at for a request that has no page of its own (an ask the owners were asked about). */
export const APPROVE_PATH = '/dashboard/approve';
