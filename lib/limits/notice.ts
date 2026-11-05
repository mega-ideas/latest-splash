/**
 * What the owners are told about a limit request, in plain words (v2 Phase 3):
 * when Splash approved a higher limit and when it will start, when Splash
 * declined it and why, and when the higher limit has started. Written once for
 * the e-mail and the WhatsApp message. The e-mail links to Settings, Limits,
 * where an owner can cancel before it starts; no link changes anything by
 * itself.
 *
 * Pure and client-safe.
 */
import { stampWords } from '../schedule/rules.ts';
import { LIMIT_WORDS, formatLimit, type LimitKind } from './rules.ts';

export type LimitNoticeKind = 'approved' | 'declined' | 'started';

export type LimitNotice = {
  kind: LimitNoticeKind;
  limit: LimitKind;
  /** What the owner asked for. */
  requested: bigint;
  /** What Splash approved (approved and started). */
  granted: bigint | null;
  /** What the limit was before. */
  before: bigint;
  /** When it starts (approved), or started (started). */
  startsAtMs: number | null;
  /** Splash's reason, in the words staff wrote (declined). */
  reason: string | null;
};

/** The Settings page that has the limits, and the button to cancel. */
export const LIMITS_PATH = '/dashboard/settings#limits';

export function limitNoticeText(n: LimitNotice): { subject: string; text: string } {
  const what = LIMIT_WORDS[n.limit].label.toLowerCase();
  const asked = formatLimit(n.limit, n.requested);
  switch (n.kind) {
    case 'approved': {
      const granted = n.granted ?? n.requested;
      const smaller = granted < n.requested ? ` It is less than the ${asked} you asked for.` : '';
      return {
        subject: 'Splash approved a higher limit',
        text:
          `Splash approved a higher limit for ${what}: ${formatLimit(n.limit, granted)}, up from ${formatLimit(n.limit, n.before)}.${smaller} ` +
          `It starts ${stampWords(n.startsAtMs ?? 0)}, after a 24 hour notice. Until then your limit stays ${formatLimit(n.limit, n.before)}. ` +
          'Any owner can cancel it before it starts.',
      };
    }
    case 'declined':
      return {
        subject: 'Splash declined a higher limit',
        text: `Splash declined the request for ${asked} for ${what}.${n.reason ? ` ${n.reason}` : ''} Your limit stays ${formatLimit(n.limit, n.before)}. You can ask again with a new reason.`,
      };
    default:
      return {
        subject: 'Your higher limit has started',
        text: `Your limit for ${what} is now ${formatLimit(n.limit, n.granted ?? n.requested)}, up from ${formatLimit(n.limit, n.before)}. It started ${stampWords(n.startsAtMs ?? 0)}. You can lower it at any time in Settings, Limits.`,
      };
  }
}
