/**
 * Reading one `SpendPolicy` with its tables (v2 §4.2), apart from the chain
 * client: the caller says how an object's contents and a table's entries are
 * fetched (lib/server/spend-rules-deps.ts wires the live client), and this
 * decides WHAT is read and how it is parsed, so a test can drive it with
 * the bytes a chain would return.
 *
 * Both `SpendPolicy` layouts are read (lib/wallet/spend-rules-bcs.ts): a
 * policy of a package published before pre-audit B1 has no policy-wide
 * totals table, so none is asked of the chain and its policy-wide totals
 * read as none, which is what that chain counts.
 *
 * Fails closed: an object that is not a `SpendPolicy` of the configured
 * package is refused, never read as one.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { parseBeneficiaryField, parseRecipientField, parseRunningField, parseSpenderField, parseSpendPolicy } from '../wallet/spend-rules-bcs.ts';
import type { PolicyState } from './spend-rules-index.ts';

/** How the caller reads the chain: one object's contents as BCS, and every entry of one table (its dynamic fields) as BCS. */
export type PolicySource = {
  object(id: string): Promise<{ type: string; owner: unknown; content: Uint8Array } | null>;
  tableEntries(tableId: string): Promise<Uint8Array[]>;
};

export function sharedVersion(owner: unknown): string {
  const o = owner as { $kind?: string; Shared?: { initialSharedVersion: string } };
  if (o?.$kind !== 'Shared' || !o.Shared) throw new Error('not a shared object');
  return String(o.Shared.initialSharedVersion);
}

/** The policy with this id and every entry of its tables, or null when there is no such object. */
export async function readPolicyState(source: PolicySource, id: string, spendPackageId: string): Promise<PolicyState | null> {
  const pkg = normalizeSuiAddress(spendPackageId);
  const o = await source.object(normalizeSuiAddress(id));
  if (!o) return null;
  if (!o.type.endsWith('::spend_policy::SpendPolicy') || normalizeSuiAddress(o.type.split('::')[0]) !== pkg) throw new Error(`${id} is not a SpendPolicy of this package`);
  const head = parseSpendPolicy(o.content);
  const [spenders, recipients, beneficiaries, running, policyWide] = await Promise.all([
    source.tableEntries(head.tables.spenders),
    source.tableEntries(head.tables.recipients),
    source.tableEntries(head.tables.beneficiaries),
    source.tableEntries(head.tables.runningTotals),
    // Pre-audit B1's table, where the policy's package has one.
    head.tables.policyTotals === null ? Promise.resolve([]) : source.tableEntries(head.tables.policyTotals),
  ]);
  return {
    ...head,
    initialSharedVersion: sharedVersion(o.owner),
    spenders: spenders.map(parseSpenderField).map((x) => ({ spender: x.spender, role: x.role, perPaymentMax: x.perPaymentMax })),
    recipients: recipients.map(parseRecipientField),
    beneficiaries: beneficiaries.map(parseBeneficiaryField),
    runningTotals: running.map(parseRunningField),
    // Pre-audit B1: the same key and value types as running_totals.
    policyTotals: policyWide.map(parseRunningField),
  };
}
