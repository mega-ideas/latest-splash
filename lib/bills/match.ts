/**
 * Matching a supplier's invoice to a recipient the business has verified.
 *
 * Only the business's own recipients are candidates (the caller passes the
 * org-scoped list), and only a verified one can be chosen: a recipient whose
 * screening came back clear, or that an admin attested, and, for a
 * self-custody wallet, whose owner signed the ownership proof (brief D5 and
 * 4.7: no payment to that address until verified). The payee name on the
 * invoice picks candidates; it never creates or changes a recipient, and an
 * address or account printed on the invoice is never used to pay.
 *
 * Only the same name, reduced, is a match that needs no reason. Words every
 * other company uses (Global, Trading, Holdings, ...) do not count towards
 * two names being alike.
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
  /** When the owner of a self-custody wallet proved it (brief 4.7); null until then. */
  ownershipProvenAt?: string | null;
};

/** Why a recipient cannot be paid yet: not screened clear, or a wallet whose owner has not proved it. */
export type RecipientBlock = 'unscreened' | 'ownership_unproven';

export function recipientBlock(r: Pick<RecipientLite, 'screeningVerdict' | 'payoutMethod' | 'ownershipProvenAt'>): RecipientBlock | null {
  if (r.screeningVerdict !== 'CLEAR' && r.screeningVerdict !== 'ATTESTED') return 'unscreened';
  if (r.payoutMethod === 'WALLET' && !r.ownershipProvenAt) return 'ownership_unproven';
  return null;
}

export function recipientVerified(r: Pick<RecipientLite, 'screeningVerdict' | 'payoutMethod' | 'ownershipProvenAt'>): boolean {
  return recipientBlock(r) === null;
}

/** Words that say what kind of company it is, not which one. */
const GENERIC = new Set([
  'global', 'international', 'intl', 'trading', 'traders', 'trade', 'services', 'service', 'solutions', 'group', 'holdings',
  'holding', 'enterprise', 'enterprises', 'industries', 'industrial', 'industry', 'electronics', 'electronic', 'logistics',
  'manufacturing', 'technology', 'technologies', 'tech', 'supply', 'supplies', 'import', 'export', 'imports', 'exports',
  'general', 'asia', 'pacific', 'resources', 'ventures', 'partners', 'and', 'of', 'sdn', 'bhd', 'pte',
]);

function tokens(s: string): Set<string> {
  return new Set(payeeKey(s).split(' ').filter((t) => t.length > 1));
}

/**
 * The share of words two names have in common, over the longer name. Zero
 * unless they share a word that names the company rather than its kind:
 * "Global Trading" and "Global Logistics" share only generic words.
 */
function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  let distinctive = 0;
  for (const t of ta) {
    if (!tb.has(t)) continue;
    shared += 1;
    if (!GENERIC.has(t)) distinctive += 1;
  }
  return distinctive === 0 ? 0 : shared / Math.max(ta.size, tb.size);
}

/** More than half of the longer name's words: one shared word in two-word names is not enough. */
const ALIKE = 0.5;

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
    .filter((m) => m.exact || m.score > ALIKE)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || Number(b.verified) - Number(a.verified));
}

/**
 * True when the invoice prints a payment detail that is not the recipient's
 * on file: the classic changed-bank-details fraud. One printed account that
 * matches does not excuse another that does not, so a forged invoice cannot
 * silence the warning by printing the real account beside its own. The
 * payment still goes to the recipient on file; this only says to check with
 * the supplier first.
 */
export function paymentDetailsDiffer(
  printed: { walletAddresses: string[]; accountNumbers: string[] },
  recipient: Pick<RecipientLite, 'walletAddress' | 'account'>,
): boolean {
  const wallet = recipient.walletAddress?.toLowerCase() ?? '';
  const stored = recipient.account ?? '';
  const account = stored.replace(/\D/g, '');
  // An account on file kept as a mask ("****3221") is known only by its
  // ending; any other is compared digit for digit, so a longer account that
  // merely ends with it is another account.
  const masked = /[*xX•]/.test(stored);
  const printedAny = printed.walletAddresses.length > 0 || printed.accountNumbers.length > 0;
  if (!printedAny) return false;
  const walletNotOnFile = printed.walletAddresses.some((w) => w.toLowerCase() !== wallet);
  const accountNotOnFile = printed.accountNumbers.some((a) => !(
    account.length >= 4 && (masked ? a.length >= 8 && a.endsWith(account) : a === account)
  ));
  return walletNotOnFile || accountNotOnFile;
}

/** The last four characters, for showing which account or wallet without showing it. */
export function maskDestination(r: Pick<RecipientLite, 'payoutMethod' | 'walletAddress' | 'account' | 'bank'>): string {
  if (r.payoutMethod === 'WALLET' && r.walletAddress) return `Sui wallet ending ${r.walletAddress.slice(-4)}`;
  const digits = (r.account ?? '').replace(/\s/g, '');
  return digits ? `${r.bank ? `${r.bank} ` : ''}account ending ${digits.slice(-4)}` : 'Bank account';
}
