/**
 * The shared front of every /api/wallet/spending-rules route (v2 §4.2): the
 * wallet route (a signed-in customer, the org from the SESSION, their own
 * membership, the org's own account), plus splash_spend's context for that
 * org only, and the request-body readers. A route never reads an org, an
 * account, a policy or an address from the request: a staff member is named
 * by their user id, and their address is their own active passkey here.
 */
import 'server-only';

import { normalizeSuiAddress } from '@mysten/sui/utils';

import { memberRole } from '@/lib/server/wallet-authority';
import { currentWalletMembers, type WalletMembers } from '@/lib/server/business-wallet';
import { liveSpendContext } from '@/lib/server/spend-rules-deps';
import type { RecipientChange, RuleInput, SpendContext } from '@/lib/server/spend-rules';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { asResponse, bigintField, refusal, walletRoute, type WalletRoute } from '@/lib/server/wallet-route';

export type SpendRoute = WalletRoute & { sc: SpendContext };

export async function spendRoute(request: Request): Promise<{ route: SpendRoute; response: null } | { route: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return gate;
  const live = await liveSpendContext(gate.route);
  if (!live.ok) return { route: null, response: refusal(live.status, live.error) };
  return { route: { ...gate.route, sc: live.sc }, response: null };
}

/** The current wallet's members, for a request the wallet signs. */
export async function walletMembersOr(route: SpendRoute): Promise<{ wallet: WalletMembers; response: null } | { wallet: null; response: Response }> {
  const current = await currentWalletMembers(route.ctx, route.db, route.orgId);
  if (!current.ok) return { wallet: null, response: asResponse(current) };
  return { wallet: current.members, response: null };
}

/**
 * The address a staff member's rule is for: their own active passkey on this
 * site. Not a viewer, and not someone of another business (404).
 */
export async function staffSpender(route: Pick<WalletRoute, 'db' | 'orgId'>, userId: string): Promise<{ address: string; response: null } | { address: null; response: Response }> {
  const role = await memberRole(route.db, route.orgId, userId);
  if (role === null) return { address: null, response: refusal(404, 'No such member of this business.') };
  if (role === 'viewer') return { address: null, response: refusal(400, 'A viewer cannot have a spending rule; change their role first.') };
  const key = (await orgMemberWalletAddresses(route.db, route.orgId)).find((a) => a.userId === userId && a.canSign);
  if (!key) return { address: null, response: refusal(409, 'This member has no passkey on this site yet, so there is no address to give a rule to.') };
  return { address: normalizeSuiAddress(key.address), response: null };
}

/** A rule from a request body, or the reason it cannot be read. */
export function ruleFromBody(body: Record<string, unknown>, spender: string): RuleInput | string {
  const perPaymentMaxMinor = bigintField(body.perPaymentMaxMinor);
  const cap = (body.cap ?? {}) as Record<string, unknown>;
  const limitMinor = bigintField(cap.limitMinor);
  const period = cap.period === 'day' || cap.period === 'month' ? cap.period : null;
  const expiresAtMs = bigintField(body.expiresAtMs);
  if (perPaymentMaxMinor === null) return 'Give the most this person may pay at once.';
  if (limitMinor === null || !period) return 'Give a daily or monthly cap.';
  if (expiresAtMs === null) return 'Give the date the rule ends.';
  const startsAtMs = body.startsAtMs == null ? null : bigintField(body.startsAtMs);
  const lifetimeCapMinor = body.lifetimeCapMinor == null ? null : bigintField(body.lifetimeCapMinor);
  if (body.startsAtMs != null && startsAtMs === null) return 'The start could not be read.';
  if (body.lifetimeCapMinor != null && lifetimeCapMinor === null) return 'The lifetime cap could not be read.';
  return { spender, perPaymentMaxMinor, cap: { period, limitMinor }, expiresAtMs, startsAtMs, lifetimeCapMinor };
}

/** A recipient change from a request body. */
export function recipientsFromBody(body: Record<string, unknown>): RecipientChange {
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    add: list(body.add).map((r) => ({ address: String((r as Record<string, unknown>).address ?? ''), tag: String((r as Record<string, unknown>).tag ?? '') as 'wallet' | 'exchange' })),
    remove: list(body.remove).map(String),
    addBeneficiaries: list(body.addBeneficiaries).map((b) => ({ commitment: String((b as Record<string, unknown>).commitment ?? ''), partnerDeposit: String((b as Record<string, unknown>).partnerDeposit ?? '') })),
    removeBeneficiaries: list(body.removeBeneficiaries).map(String),
  };
}
