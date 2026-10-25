/**
 * Matching a supplier's invoice to a recipient the business has verified.
 *
 * Only the business's own recipients are candidates (the caller passes the
 * org-scoped list), and only a verified one can be chosen: a recipient whose
 * screening came back clear, or that an admin attested. The payee name on the
 * invoice picks candidates; it never creates or changes a recipient, and an
 * address or account printed on the invoice is never used to pay.
 */
import { payeeKey } from './duplicates.ts';

export type RecipientLite = {
  id: string;
  name: string;
  legalName?: string | null;
  country: string;
  payoutMethod: 'BANK' | 'WALLET';
  screeningVerdict?: string | null;
  walletAddress?: string | null;
  account?: string | null;
  bank?: string | null;
};

export function recipientVerified(r: Pick<RecipientLite, 'screeningVerdict'>): boolean {
  return r.screeningVerdict === 'CLEAR' || r.screeningVerdict === 'ATTESTED';
}

function tokens(s: string): Set<string> {
  return new Set(payeeKey(s).split(' ').filter((t) => t.length > 1));
}

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

export type RecipientMatch = { recipient: RecipientLite; score: number; exact: boolean; verified: boolean };

/** Candidates for `payee`, best first. Exact when the reduced names are equal. */
export function matchRecipients(payee: string, recipients: RecipientLite[]): RecipientMatch[] {
  const key = payeeKey(payee);
  if (!key) return [];
  return recipients
    .map((recipient) => {
      const names = [recipient.name, recipient.legalName ?? ''].filter(Boolean);
      const exact = names.some((n) => payeeKey(n) === key);
      const score = exact ? 1 : Math.max(...names.map((n) => similarity(n, payee)));
      return { recipient, score, exact, verified: recipientVerified(recipient) };
    })
    .filter((m) => m.score >= 0.5)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || Number(b.verified) - Number(a.verified));
}

/**
 * True when the invoice prints payment details and none of them is the
 * recipient's on file: the classic changed-bank-details fraud. The payment
 * still goes to the recipient on file; this only says to check with the
 * supplier first.
 */
export function paymentDetailsDiffer(
  printed: { walletAddresses: string[]; accountNumbers: string[] },
  recipient: Pick<RecipientLite, 'walletAddress' | 'account'>,
): boolean {
  const wallet = recipient.walletAddress?.toLowerCase() ?? '';
  const account = (recipient.account ?? '').replace(/\D/g, '');
  const printedAny = printed.walletAddresses.length > 0 || printed.accountNumbers.length > 0;
  if (!printedAny) return false;
  const walletOnFile = wallet !== '' && printed.walletAddresses.includes(wallet);
  const accountOnFile = account.length >= 4 && printed.accountNumbers.some((a) => a === account || a.endsWith(account) || account.endsWith(a));
  return !(walletOnFile || accountOnFile);
}

/** The last four characters, for showing which account or wallet without showing it. */
export function maskDestination(r: Pick<RecipientLite, 'payoutMethod' | 'walletAddress' | 'account' | 'bank'>): string {
  if (r.payoutMethod === 'WALLET' && r.walletAddress) return `Sui wallet ending ${r.walletAddress.slice(-4)}`;
  const digits = (r.account ?? '').replace(/\s/g, '');
  return digits ? `${r.bank ? `${r.bank} ` : ''}account ending ${digits.slice(-4)}` : 'Bank account';
}
