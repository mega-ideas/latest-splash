/**
 * How a business's owners are told about a schedule (v2 Phase 3): by e-mail and,
 * where an owner has a verified WhatsApp number and the business turned it on, by
 * WhatsApp. The words are lib/schedule/notice.ts; the e-mail carries a link to the
 * signed-in Scheduled tab (it pays, skips and stops nothing by itself), and
 * WhatsApp carries none.
 *
 * Kept apart from the route wiring (scheduled-payments-deps.ts) so it can be read
 * and tested without Next.
 */
import 'server-only';

import { resolveEmailTransport } from '@/lib/auth/email-transport';
import { noticeText, type ScheduleNotice } from '@/lib/schedule/notice';
import { listApprovers } from '@/lib/server/approver-channels';
import { listOrgOwners } from '@/lib/server/near-threshold-store';
import { readOrgSettings } from '@/lib/server/org-settings';
import { sendWhatsApp, whatsappConfigured } from '@/lib/server/whatsapp';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

/** Tell this business's owners, by e-mail and by WhatsApp where they have it. */
export function ownersNotifier(db: DrizzleDb, orgId: string, env: NodeJS.ProcessEnv = process.env): (notice: ScheduleNotice) => Promise<void> {
  return async (notice: ScheduleNotice) => {
    const { subject, text } = noticeText(notice);
    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${appUrl}${notice.path}`;
    const owners = await listOrgOwners(db, orgId);
    const transport = resolveEmailTransport(env);
    await Promise.allSettled(owners.map((o) => transport.sendMessage({ to: o.email, subject, text: `${text}\n\nOpen the Scheduled tab:\n\n${link}`, link })));
    try {
      const [people, settings] = await Promise.all([listApprovers(orgId), readOrgSettings(orgId).catch(() => null)]);
      if (!settings?.whatsappEnabled || !whatsappConfigured()) return;
      const ids = new Set(owners.map((o) => o.userId));
      await Promise.allSettled(
        people
          .filter((p) => ids.has(p.userId) && p.whatsappE164)
          .map((p) => sendWhatsApp(p.whatsappE164 as string, `${text}\n\nOpen Splash, Transfer, Scheduled.`)),
      );
    } catch {
      /* the e-mail and the app carry it */
    }
  };
}
