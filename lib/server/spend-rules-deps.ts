/**
 * The live wiring for spending rules (v2 §4.2), for ONE org, on top of the
 * wallet's (lib/server/wallet-deps.ts): splash_spend's package and
 * PolicyRegistry from the environment, and a reader that indexes the rules
 * from the chain as BCS (lib/wallet/spend-rules-bcs.ts):
 *
 *   policy       getObjects(policy id), then every entry of its tables
 *                (listDynamicFields, getObjects) for spenders, recipients,
 *                beneficiaries and running totals;
 *   allowances   listOwnedObjects(wallet, AllowanceCap<Balance<USDC>>), then
 *                getObjects of the allowances they point to: an allowance
 *                whose cap the wallet no longer holds was revoked;
 *   spends       listEvents(RuleSpend), newest first, a few pages.
 *
 * Fails closed: without SPLASH_SPEND_PACKAGE_ID and
 * SPLASH_SPEND_POLICY_REGISTRY_ID nothing is built or read.
 */
import 'server-only';

import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import {
  parseAllowance,
  parseAllowanceCap,
  parseBeneficiaryField,
  parseRecipientField,
  parseRuleSpend,
  parseRunningField,
  parseSpenderField,
  parseSpendPolicy,
  type RuleSpendEvent,
} from '@/lib/wallet/spend-rules-bcs';
import { dbOwnershipGate } from '@/lib/server/ownership-proofs';
import type { SecondApprovalOpener } from '@/lib/server/payment-approval-asks';
import { balanceType } from '@/lib/server/spend-rules-builders';
import type { PolicyState } from '@/lib/server/spend-rules-index';
import { openSecondApproval, type SpendContext, type SpendReader } from '@/lib/server/spend-rules';
import { orgWalletMembers } from '@/lib/server/wallet-deps';
import type { WalletRoute } from '@/lib/server/wallet-route';

export { spendIdsFromEnv } from '@/lib/server/spend-rules-env';
import { spendIdsFromEnv } from '@/lib/server/spend-rules-env';

type Sui = (typeof import('@/lib/sui'))['suiClient'];

async function client(): Promise<Sui> {
  return (await import('@/lib/sui')).suiClient;
}

function sharedVersion(owner: unknown): string {
  const o = owner as { $kind?: string; Shared?: { initialSharedVersion: string } };
  if (o?.$kind !== 'Shared' || !o.Shared) throw new Error('not a shared object');
  return String(o.Shared.initialSharedVersion);
}

async function contents(sui: Sui, ids: string[]): Promise<Array<{ objectId: string; type: string; owner: unknown; content: Uint8Array } | null>> {
  const out: Array<{ objectId: string; type: string; owner: unknown; content: Uint8Array } | null> = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { objects } = await sui.core.getObjects({ objectIds: ids.slice(i, i + 50), include: { content: true } });
    for (const o of objects) out.push(o instanceof Error ? null : { objectId: o.objectId, type: o.type, owner: o.owner, content: o.content });
  }
  return out;
}

async function tableEntries(sui: Sui, tableId: string): Promise<Uint8Array[]> {
  const fieldIds: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const res = await sui.core.listDynamicFields({ parentId: tableId, cursor, limit: 50 });
    fieldIds.push(...res.dynamicFields.map((f) => f.fieldId));
    if (!res.hasNextPage || !res.cursor) break;
    cursor = res.cursor;
  }
  return (await contents(sui, fieldIds)).filter((x): x is NonNullable<typeof x> => x !== null).map((x) => x.content);
}

export function liveSpendReader(spendPackageId: string, usdcType: string): SpendReader {
  const pkg = normalizeSuiAddress(spendPackageId);
  return {
    async readPolicy(id) {
      const sui = await client();
      const [o] = await contents(sui, [normalizeSuiAddress(id)]);
      if (!o) return null;
      if (!o.type.endsWith('::spend_policy::SpendPolicy') || normalizeSuiAddress(o.type.split('::')[0]) !== pkg) throw new Error(`${id} is not a SpendPolicy of this package`);
      const head = parseSpendPolicy(o.content);
      const [spenders, recipients, beneficiaries, running] = await Promise.all([
        tableEntries(sui, head.tables.spenders),
        tableEntries(sui, head.tables.recipients),
        tableEntries(sui, head.tables.beneficiaries),
        tableEntries(sui, head.tables.runningTotals),
      ]);
      const policy: PolicyState = {
        ...head,
        initialSharedVersion: sharedVersion(o.owner),
        spenders: spenders.map(parseSpenderField).map((x) => ({ spender: x.spender, role: x.role, perPaymentMax: x.perPaymentMax })),
        recipients: recipients.map(parseRecipientField),
        beneficiaries: beneficiaries.map(parseBeneficiaryField),
        runningTotals: running.map(parseRunningField),
      };
      return policy;
    },
    async listAllowanceCaps(owner) {
      const sui = await client();
      const type = `0x2::allowance::AllowanceCap<${balanceType({ usdcType })}>`;
      const out: Array<{ objectId: string; version: string; digest: string; allowance: string }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res: { objects: Array<{ objectId: string; version: string; digest: string; type: string; content: Uint8Array }>; hasNextPage: boolean; cursor: string | null } =
          await sui.core.listOwnedObjects({ owner: normalizeSuiAddress(owner), type, cursor, limit: 50, include: { content: true } });
        for (const o of res.objects) {
          if (normalizeStructTag(o.type) !== normalizeStructTag(type)) continue;
          out.push({ objectId: o.objectId, version: o.version, digest: o.digest, allowance: parseAllowanceCap(o.content).allowance });
        }
        if (!res.hasNextPage || !res.cursor) break;
        cursor = res.cursor;
      }
      return out;
    },
    async readAllowances(ids) {
      const sui = await client();
      const objects = await contents(sui, ids.map((i) => normalizeSuiAddress(i)));
      return objects
        .filter((o): o is NonNullable<typeof o> => o !== null && /^0x0*2::allowance::Allowance</.test(o.type))
        .map((o) => ({ ...parseAllowance(o.content), initialSharedVersion: sharedVersion(o.owner) }));
    },
    async listRuleSpends(policyId, limit) {
      const sui = await client();
      const wanted = normalizeSuiAddress(policyId);
      const out: RuleSpendEvent[] = [];
      let before: string | null = null;
      for (let page = 0; page < 4 && out.length < limit; page++) {
        const res = await sui.core.listEvents({ filter: { eventType: `${pkg}::splash_spend::RuleSpend` }, order: 'descending', limit: 50, ...(before ? { before } : {}) });
        for (const e of res.events) {
          const parsed = parseRuleSpend(e.bcs);
          if (parsed.policyId === wanted) out.push(parsed);
        }
        if (!res.hasNextPage || !res.endCursor) break;
        before = res.endCursor;
      }
      return out.slice(0, limit);
    },
  };
}

/** The spending-rule context for the route's org, or why it cannot run. */
export async function liveSpendContext(route: Pick<WalletRoute, 'ctx' | 'db'>): Promise<{ ok: true; sc: SpendContext } | { ok: false; status: number; error: string }> {
  const ids = spendIdsFromEnv();
  if (!ids.ok) return { ok: false, status: 503, error: ids.reason };
  let policyRegistry: { objectId: string; initialSharedVersion: string };
  try {
    const sui = await client();
    const [o] = await contents(sui, [normalizeSuiAddress(ids.policyRegistryId)]);
    if (!o) throw new Error('missing');
    policyRegistry = { objectId: normalizeSuiAddress(ids.policyRegistryId), initialSharedVersion: sharedVersion(o.owner) };
  } catch {
    return { ok: false, status: 502, error: "splash_spend's policy registry could not be read from the chain" };
  }
  const { ctx, db } = route;
  return {
    ok: true,
    sc: {
      wallet: ctx,
      chain: { ...ctx.chain, spendPackageId: ids.spendPackageId, policyRegistry },
      read: liveSpendReader(ids.spendPackageId, ctx.chain.usdcType),
      ownership: dbOwnershipGate(db),
      db,
    },
  };
}

/** The approval-ask hook: an owner's second approval, with their own passkey here. */
export async function spendSecondApprovalOpener(route: WalletRoute): Promise<SecondApprovalOpener | undefined> {
  const live = await liveSpendContext(route);
  if (!live.ok) return undefined;
  return async (input) => {
    let account;
    try {
      account = await route.ctx.readAccount();
    } catch {
      return { ok: false, status: 502, code: 'account_unreadable', error: 'the business account could not be read from the chain' };
    }
    const { candidates } = await orgWalletMembers(route.db, input.orgId, account);
    const me = candidates.find((c) => c.userId === input.ownerUserId);
    if (!me) return { ok: false, status: 403, code: 'no_passkey', error: 'add a passkey on this site first: a second approval is signed with it' };
    return openSecondApproval(live.sc, { ...input, ownerPasskeyPublicKey: me.publicKey });
  };
}
