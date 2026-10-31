/**
 * The live wiring for scheduled batches (v2 Phase 3), for ONE business: the
 * batch wiring (the chain, Splash's fee, screening, the audit bundle, the
 * wallet's balance), the scheduled payer (a KMS key apart from the gas
 * sponsor's), and how the owners are told.
 *
 *   route    the session's business, from the SESSION (walletRoute); the actor
 *            is the signed-in person with their role and whether they are the
 *            Finance lead. Nothing here reads a business or a role from a request.
 *   cron     a business's own context, built from its id alone, for the runner.
 *
 * Notices go to the owners by e-mail and, where an owner has a verified
 * WhatsApp number and the business turned it on, by WhatsApp. The words are
 * lib/schedule/notice.ts; the e-mail carries a link to the signed-in Scheduled
 * tab (it pays, skips and stops nothing by itself), and WhatsApp carries none.
 * A notice that fails to send never undoes what happened.
 */
import 'server-only';

import { resolveEmailTransport } from '@/lib/auth/email-transport';
import { noticeText, type ScheduleNotice } from '@/lib/schedule/notice';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { listApprovers } from '@/lib/server/approver-channels';
import { listOrgOwners } from '@/lib/server/near-threshold-store';
import { readOrgSettings } from '@/lib/server/org-settings';
import { getScheduledPayer } from '@/lib/server/scheduled-payer-signer';
import type { Actor, ScheduleDeps } from '@/lib/server/scheduled-payments';
import { teamManager } from '@/lib/server/team-admin';
import { batchDepsFor, type WalletRouteLike } from '@/lib/server/wallet-transfers-deps';
import { liveWalletContext } from '@/lib/server/wallet-deps';
import { walletRoute, type WalletRoute } from '@/lib/server/wallet-route';
import { sendWhatsApp, whatsappConfigured } from '@/lib/server/whatsapp';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

/** Tell this business's owners, by e-mail and by WhatsApp where they have it. */
export function ownersNotifier(db: DrizzleDb, orgId: string, env: NodeJS.ProcessEnv = process.env): ScheduleDeps['notify'] {
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

/** One business's dependencies for the schedule service and the runner. */
export function scheduleDepsFor(route: WalletRouteLike, env: NodeJS.ProcessEnv = process.env): ScheduleDeps {
  const sponsor = route.ctx.signing.sponsor?.address ?? null;
  return {
    ...batchDepsFor(route, env),
    payer: async () => {
      const payer = await getScheduledPayer();
      // The key that sponsors gas must never be the key that pays.
      if (payer.ok && sponsor && normalizeSuiAddress(payer.payer.address) === normalizeSuiAddress(sponsor)) {
        return { ok: false, code: 'same_as_sponsor', reason: 'The scheduled payer is the gas sponsor. They must be different keys.' };
      }
      return payer;
    },
    notify: ownersNotifier(route.db, route.orgId, env),
  };
}

/** The signed-in person, as the schedule service sees them. */
export async function scheduleActor(route: WalletRoute): Promise<Actor> {
  const { userId, role } = route.authority;
  const financeLead = role === 'APPROVER' ? (await teamManager(route.db, route.orgId, userId)) === 'finance_lead' : false;
  return { userId, role, financeLead };
}

export async function scheduleRoute(request: Request): Promise<{ route: WalletRoute; deps: ScheduleDeps; actor: Actor; response: null } | { route: null; deps: null; actor: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return { route: null, deps: null, actor: null, response: gate.response };
  return { route: gate.route, deps: scheduleDepsFor(gate.route), actor: await scheduleActor(gate.route), response: null };
}

/**
 * A business's own dependencies, for the runner. Null when the business cannot
 * be worked on yet (no on-chain account); an outage throws, so the cron answers
 * 502 and the scheduler's failure alerting sees it.
 */
export async function scheduleDepsForOrg(orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<ScheduleDeps | null> {
  const live = await liveWalletContext(orgId);
  if (!live.ok) {
    if (live.status === 409) return null;
    throw new Error(live.error);
  }
  return scheduleDepsFor({ orgId, ctx: live.ctx, db: live.db }, env);
}
