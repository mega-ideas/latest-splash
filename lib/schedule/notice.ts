/**
 * The notices owners get about scheduled payments, in plain words (v2 Phase 3):
 *
 *   day_before     the day before an automatic run: what will be paid, when,
 *                  and a way to skip it or stop the schedule.
 *   running        as an automatic run starts.
 *   approval_ready a run that needs a person's passkey: the batch is prepared
 *                  and waiting. When an automatic run was handed back, this
 *                  says why.
 *   paid           the receipt: it went out.
 *   failed         it could not be completed, and what to do.
 *   lapsed         nobody approved it in time; nothing was paid, nothing is owed.
 *   skipped        an owner skipped it.
 *   paused         an owner paused every automatic payment.
 *
 * The words are written once, here, for the e-mail, the WhatsApp message and
 * the in-app card. No notice carries a link that pays, skips or stops by
 * itself: every link opens the Scheduled tab in the signed-in app, where
 * Skip and Stop are one click for an owner.
 *
 * Pure and client-safe.
 */
import { formatUsdc } from '../fees/copy.ts';
import { FALLBACK_NOTICE_TAIL, clockWords, stampWords, windowWords, type ScheduleMode } from './rules.ts';

export type NoticeKind = 'day_before' | 'running' | 'approval_ready' | 'paid' | 'failed' | 'lapsed' | 'skipped' | 'paused';

export type ScheduleNotice = {
  kind: NoticeKind;
  orgId: string;
  businessName: string;
  scheduleId: string | null;
  scheduleName: string;
  runId: string | null;
  mode: ScheduleMode;
  dueAtMs: number | null;
  totalMinor: string;
  feeMinor: string;
  itemCount: number;
  /** Plain words: why an automatic run was handed back, why it failed, who skipped it. */
  reason: string | null;
  /** Who did it, for a skip or a pause. */
  by: string | null;
  /** The signed-in page the notice opens (the Scheduled tab, or a receipt). */
  path: string;
  /** For an automatic run whose window is open: when its first payment may go out. Absent or null when there is no window. */
  startsAtMs?: number | null;
  /** The business's window, in minutes, when the notice was made. */
  graceMinutes?: number | null;
};

/**
 * A button the notice points at. It is not a link that acts: `path` is the
 * signed-in page that has the button, and the person must be signed in as an
 * owner there to press it.
 */
export type NoticeAction = { kind: 'skip' | 'stop'; label: string; path: string };

export const SKIP_LABEL = 'Skip this run';
export const STOP_LABEL = 'Stop schedule';

export const SCHEDULED_PATH = '/dashboard/transfer?view=scheduled';
export const scheduledRunPath = (runId: string) => `/dashboard/transfer?view=scheduled&run=${encodeURIComponent(runId)}`;

const payments = (n: number) => `${n} ${n === 1 ? 'payment' : 'payments'}`;
const money = (minor: string) => `${formatUsdc(BigInt(minor || '0'))} USDC`;

const BUTTONS = 'Both are buttons in the app, and work only when you are signed in as an owner. Nothing in this message skips or stops anything by itself.';

function noticeBody(n: ScheduleNotice): { subject: string; text: string; actions?: NoticeAction[] } {
  const what = `${n.scheduleName} (${payments(n.itemCount)}, ${money(n.totalMinor)})`;
  const when = n.dueAtMs ? stampWords(n.dueAtMs) : 'the due time';
  const reasonLine = n.reason ? `\n\n${n.reason}` : '';
  const buttons: NoticeAction[] = [
    { kind: 'skip', label: SKIP_LABEL, path: n.path },
    { kind: 'stop', label: STOP_LABEL, path: n.path },
  ];
  switch (n.kind) {
    case 'day_before': {
      const grace = n.graceMinutes ?? 0;
      const windowLine =
        grace > 0
          ? `At ${when} Splash sends a second notice, and the first payment goes out ${grace} ${grace === 1 ? 'minute' : 'minutes'} after that. Nothing is paid before then.`
          : `Nothing is paid before ${when}.`;
      return {
        subject: `Splash will pay ${n.scheduleName} automatically at ${when}`,
        text: `${n.businessName}: ${what} will be paid automatically from ${when}, inside the allowance your owners signed. The fee for each payment is shown on the run.\n\n${windowLine}\n\nIf you do not want it paid, open the Scheduled tab and choose ${SKIP_LABEL}, or ${STOP_LABEL}. ${BUTTONS}`,
        actions: buttons,
      };
    }
    case 'running': {
      if (n.startsAtMs) {
        const starts = windowWords(n.startsAtMs, n.startsAtMs - 1) as string;
        return {
          subject: `Splash will start paying ${n.scheduleName} at ${clockWords(n.startsAtMs)}`,
          text: `${n.businessName}: ${what} is about to be paid inside your allowance. ${starts}. Nothing has been paid yet.\n\nTo stop it, open the Scheduled tab and choose ${SKIP_LABEL}, or ${STOP_LABEL}. ${BUTTONS} A receipt follows once it is paid.${reasonLine}`,
          actions: buttons,
        };
      }
      return {
        subject: `Splash is paying ${n.scheduleName} now`,
        text: `${n.businessName}: ${what} is being paid now, inside your allowance. It goes out within moments, so there is rarely time to skip it now. To stop automatic payments at once, pause them in the Scheduled tab. A receipt follows.${reasonLine}`,
        actions: [],
      };
    }
    case 'approval_ready':
      return {
        subject: `${n.scheduleName} is ready for your approval`,
        text: n.reason
          ? `${n.businessName}: ${what} is ready for your approval.\n\n${n.reason}\n\n${FALLBACK_NOTICE_TAIL} Open Splash to review and sign it, or skip this run.`
          : `${n.businessName}: ${what} is ready for your approval. Nothing is paid until the owners sign it with their passkeys. Open Splash to review it, or skip this run. If nobody approves it in time it lapses and nothing is paid.`,
      };
    case 'paid':
      return {
        subject: `${n.scheduleName} was paid`,
        text: `${n.businessName}: ${what} was paid. Your receipt is in History.${reasonLine}`,
      };
    case 'failed':
      return {
        subject: `${n.scheduleName} did not go through`,
        text: `${n.businessName}: ${what} could not be completed.${reasonLine}\n\nOpen the Scheduled tab to see what was and was not paid.`,
      };
    case 'lapsed':
      return {
        subject: `${n.scheduleName} was not approved in time`,
        text: `${n.businessName}: ${what} was not approved in time, so it did not go out. Nothing was paid, and there is no late fee or penalty. The next run, if there is one, is unaffected.`,
      };
    case 'skipped':
      return {
        subject: `${n.scheduleName} was skipped`,
        text: `${n.businessName}: ${n.by ? `${n.by} skipped` : 'An owner skipped'} the run of ${what}. Nothing was paid.`,
      };
    case 'paused':
      return {
        subject: 'Automatic payments are paused',
        text: `${n.businessName}: ${n.by ? `${n.by} paused` : 'An owner paused'} automatic payments for the business. Scheduled batches now come to you for approval until an owner turns them back on.`,
      };
  }
}

/** The subject, the words, and the buttons the notice points at in the signed-in app (empty for a notice that has none). */
export function noticeText(n: ScheduleNotice): { subject: string; text: string; actions: NoticeAction[] } {
  const body = noticeBody(n);
  return { subject: body.subject, text: body.text, actions: body.actions ?? [] };
}
