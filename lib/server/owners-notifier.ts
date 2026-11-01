/**
 * How a business's owners are told about a schedule (v2 Phase 3): by e-mail and,
 * where an owner has a verified WhatsApp number and the business turned it on, by
 * WhatsApp. The words are lib/schedule/notice.ts; the e-mail carries a link to the
 * signed-in Scheduled tab (it pays, skips and stops nothing by itself), and
 * WhatsApp carries none.
 *
 * It answers with HOW MANY OWNERS IT REACHED: those a message was accepted for,
 * by either channel. The runner trusts that number. The warning window before an
 * automatic payment is recorded as given only when it is above zero, and a notice
 * that reaches no one (no transport, no address, the provider refusing) never
 * throws: it answers 0.
 *
 * Kept apart from the route wiring (scheduled-payments-deps.ts) so it can be read
 * and tested without Next.
 */
import 'server-only';

import { resolveEmailTransport, type EmailTransport } from '@/lib/auth/email-transport';
import { noticeText, type ScheduleNotice } from '@/lib/schedule/notice';
import { listApprovers } from '@/lib/server/approver-channels';
import { listOrgOwners } from '@/lib/server/near-threshold-store';
import { readOrgSettings } from '@/lib/server/org-settings';
import { sendWhatsApp, whatsappConfigured } from '@/lib/server/whatsapp';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

/** Tell this business's owners, by e-mail and by WhatsApp where they have it. Answers how many owners it reached. */
export function ownersNotifier(db: DrizzleDb, orgId: string, env: NodeJS.ProcessEnv = process.env): (notice: ScheduleNotice) => Promise<number> {
  return async (notice: ScheduleNotice) => {
    const { subject, text } = noticeText(notice);
    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${appUrl}${notice.path}`;
    const owners = await listOrgOwners(db, orgId);
    const reached = new Set<string>();

    let transport: EmailTransport | null = null;
    try {
      transport = resolveEmailTransport(env);
    } catch {
      // No usable mail transport here (production without one set up): nobody is reached by e-mail.
    }
    if (transport) {
      const mail = transport;
      const sent = await Promise.allSettled(
        owners.map(async (o) => {
          if (!o.email.trim()) throw new Error('no address');
          await mail.sendMessage({ to: o.email, subject, text: `${text}\n\nOpen the Scheduled tab:\n\n${link}`, link });
          return o.userId;
        }),
      );
      for (const s of sent) if (s.status === 'fulfilled') reached.add(s.value);
    }

    try {
      const [people, settings] = await Promise.all([listApprovers(orgId), readOrgSettings(orgId).catch(() => null)]);
      if (settings?.whatsappEnabled && whatsappConfigured()) {
        const ids = new Set(owners.map((o) => o.userId));
        const sent = await Promise.allSettled(
          people
            .filter((p) => ids.has(p.userId) && p.whatsappE164)
            .map(async (p) => {
              const result = await sendWhatsApp(p.whatsappE164 as string, `${text}\n\nOpen Splash, Transfer, Scheduled.`);
              return result.sent ? p.userId : null;
            }),
        );
        for (const s of sent) if (s.status === 'fulfilled' && s.value) reached.add(s.value);
      }
    } catch {
      /* the e-mail and the app carry it */
    }
    return reached.size;
  };
}
