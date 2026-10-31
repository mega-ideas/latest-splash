/**
 * A saved recipient as the Recipients page receives it (v2 brief 5.9).
 *
 * The store's record carries the business it belongs to, the member who saved
 * it, the supplier's email and the whole of a bank account. The page needs
 * none of those: it needs to know whether the viewer saved it (an owner does
 * not approve what they saved themselves, `creator_cannot_approve`), whether an
 * email is on file for the proof link, and the last four digits of an account.
 * Pure and client-safe.
 */
import type { RecipientRecord } from '../server/operations.ts';

export type ClientRecipient = Omit<RecipientRecord, 'orgId' | 'createdBy' | 'orgEmail' | 'travelRule' | 'account' | 'sweepConfig'> & {
  /** The account number's last four digits, never the whole number. */
  account: string;
  hasEmail: boolean;
  /** Whether the person asking saved it. Never who did. */
  savedByYou: boolean;
  supplier?: { legalName?: string; registrationNumber?: string };
};

const lastFour = (account: string | undefined): string => {
  const digits = String(account ?? '').replace(/\s+/g, '');
  return digits.length === 0 ? '' : `••${digits.slice(-4)}`;
};

export function toClientRecipient(record: RecipientRecord, viewerUserId: string): ClientRecipient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- these fields are the ones that never leave the server
  const { orgId, createdBy, orgEmail, travelRule, account, sweepConfig, ...rest } = record;
  return {
    ...rest,
    account: lastFour(account),
    hasEmail: Boolean(orgEmail),
    savedByYou: Boolean(createdBy) && createdBy === viewerUserId,
    supplier: travelRule ? { legalName: travelRule.legalName, registrationNumber: travelRule.registrationNumber } : undefined,
  };
}
