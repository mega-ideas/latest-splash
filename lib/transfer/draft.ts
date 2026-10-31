/**
 * The draft Transfer keeps while funds arrive (v2 brief 5.4 step 3: "the
 * draft is kept; the rate is quoted AFTER funds arrive").
 *
 * A top-up from a bank or another chain can take minutes or a day, so the
 * page remembers who is being paid and how much, and picks up where it was.
 * It remembers the least that does that:
 *
 *   - the payee by id. The account number, the address and the supplier's
 *     details were saved on the server (sealed, for a bank account) when step
 *     2 was done; the draft never holds them. A draft is not a place a bank
 *     account number or a wallet address can leak from.
 *   - the amount as typed, the purpose and source of funds, the invoice
 *     reference.
 *   - the intent id: one key, made once per draft, that every call for this
 *     payment carries. It is the payment's idempotency key (the same key with
 *     the same payment never pays twice), so a draft resumed tomorrow is the
 *     same payment, not a new one.
 *   - the top-up in flight, so the page can ask whether it has arrived.
 *
 * It is kept in the browser (a per-person convenience, wrapped in try/catch
 * by the caller) for a week, and dropped after that. No rate is kept: a rate
 * is quoted after the funds arrive, at the moment the owners are asked.
 *
 * Pure and client-safe; the caller does the storing.
 */

export const DRAFT_MAX_AGE_MS = 7 * 24 * 3_600_000;

export type DraftPayee =
  | { kind: 'bank'; beneficiaryId: string; name: string; country: string }
  | { kind: 'splash_business'; businessId: string; name: string }
  | { kind: 'recipient'; recipientId: string; name: string };

export type TransferDraft = {
  v: 1;
  intentKey: string;
  payee: DraftPayee;
  amountText: string;
  purposeCode?: string;
  sourceOfFunds?: string;
  reference?: string;
  topUp?: { fundingIntentId: string; startedAt: string };
  savedAt: string;
};

export function draftStorageKey(orgId: string): string {
  return `splash.transfer.draft.${orgId}`;
}

/** One key per draft, in the shape every route accepts (8 to 80 letters, digits, - or _). */
export function newIntentKey(random: (bytes: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return `tx_${Array.from(random(12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

function cleanPayee(value: unknown): DraftPayee | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const name = text(v.name, 140);
  if (!name) return null;
  if (v.kind === 'bank') {
    const beneficiaryId = text(v.beneficiaryId, 80);
    const country = text(v.country, 2);
    return beneficiaryId && country ? { kind: 'bank', beneficiaryId, name, country } : null;
  }
  if (v.kind === 'splash_business') {
    const businessId = text(v.businessId, 80);
    return businessId ? { kind: 'splash_business', businessId, name } : null;
  }
  if (v.kind === 'recipient') {
    const recipientId = text(v.recipientId, 80);
    return recipientId ? { kind: 'recipient', recipientId, name } : null;
  }
  return null;
}

/** A draft with only what a draft may hold. Anything else is dropped; a draft that is not one is null. */
function clean(value: unknown): TransferDraft | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  const intentKey = typeof v.intentKey === 'string' && KEY.test(v.intentKey) ? v.intentKey : null;
  const payee = cleanPayee(v.payee);
  const amountText = typeof v.amountText === 'string' && v.amountText.length <= 40 && /^[0-9.,\s]*$/.test(v.amountText) ? v.amountText : null;
  const savedAt = typeof v.savedAt === 'string' && Number.isFinite(Date.parse(v.savedAt)) ? new Date(v.savedAt).toISOString() : null;
  if (!intentKey || !payee || amountText === null || !savedAt) return null;
  const draft: TransferDraft = { v: 1, intentKey, payee, amountText, savedAt };
  const purposeCode = text(v.purposeCode, 8);
  if (purposeCode && /^[A-Z]{3,8}$/.test(purposeCode)) draft.purposeCode = purposeCode;
  const source = text(v.sourceOfFunds, 40);
  if (source && /^[a-z_]+$/.test(source)) draft.sourceOfFunds = source;
  const reference = text(v.reference, 60);
  if (reference) draft.reference = reference;
  const t = v.topUp as Record<string, unknown> | null | undefined;
  if (t && typeof t === 'object') {
    const fundingIntentId = text(t.fundingIntentId, 80);
    const startedAt = typeof t.startedAt === 'string' && Number.isFinite(Date.parse(t.startedAt)) ? new Date(t.startedAt).toISOString() : null;
    if (fundingIntentId && startedAt) draft.topUp = { fundingIntentId, startedAt };
  }
  return draft;
}

export function serializeDraft(draft: unknown): string {
  const cleaned = clean(draft);
  if (!cleaned) throw new RangeError('that is not a draft');
  return JSON.stringify(cleaned);
}

/** The draft in `stored`, or null when there is none, it is not one, it is more than a week old, or it is from the future. */
export function parseDraft(stored: string | null | undefined, now: Date): TransferDraft | null {
  if (typeof stored !== 'string' || stored === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  const draft = clean(value);
  if (!draft) return null;
  const age = now.getTime() - Date.parse(draft.savedAt);
  if (age > DRAFT_MAX_AGE_MS || age < -5 * 60_000) return null;
  return draft;
}
