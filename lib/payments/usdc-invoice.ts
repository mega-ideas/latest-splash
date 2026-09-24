import { createHash } from 'node:crypto';

/**
 * Paying an invoice in USDC on Sui, straight to the issuer's own wallet.
 *
 * A Sui transfer carries no memo, so a payment is matched by its amount. The
 * amount asked for is the invoice amount plus a suffix of 1–997 millionths of
 * a dollar, fixed per invoice: 1,250.00 becomes 1,250.000417. Two open
 * invoices for the same amount are then (almost always) asked for different
 * amounts, and a transfer of exactly one of them identifies it. The rare tie
 * is settled by the database: a transaction can pay one invoice only.
 *
 * Splash never holds the money — it goes to the issuer's Splash wallet, the
 * address of their passkey — so this is not collecting on anyone's behalf.
 * Splash only reads the chain to see that it arrived.
 */

/** Suffixes run 1..SUFFIX_RANGE micro-USDC: never zero, always under a tenth of a cent. */
export const SUFFIX_RANGE = 997n;

/** How far a payment may appear to precede the invoice (clock skew between us and the chain). */
export const PAYMENT_CLOCK_TOLERANCE_MS = 10 * 60 * 1000;

export function invoiceUsdcSuffix(invoiceId: string): bigint {
  const digest = createHash('sha256').update(`splash-invoice-usdc:${invoiceId}`).digest();
  return 1n + (BigInt(digest.readUInt32BE(0)) % SUFFIX_RANGE);
}

/** The exact USDC (6 dp minor units) this invoice asks for. `amountMinor` is USD at 6 dp. */
export function invoiceUsdcAmountMinor(invoiceId: string, amountMinor: bigint): bigint {
  if (amountMinor <= 0n) throw new RangeError('an invoice amount must be positive');
  return amountMinor + invoiceUsdcSuffix(invoiceId);
}

export type IncomingMovement = {
  digest: string;
  timestamp: string | null;
  success: boolean;
  direction: 'IN' | 'OUT';
  amountMinor: bigint;
  counterparty: string | null;
};

/**
 * The transfer that pays this invoice: money IN to the issuer's wallet, of
 * exactly the amount asked for, that succeeded, and not before the invoice
 * existed. Anything else — close amounts included — is not a match; the issuer
 * can still reconcile it by hand.
 */
export function findInvoicePayment(
  movements: IncomingMovement[],
  expectedMinor: bigint,
  invoiceCreatedAt: Date,
): IncomingMovement | null {
  const notBefore = invoiceCreatedAt.getTime() - PAYMENT_CLOCK_TOLERANCE_MS;
  const matches = movements.filter((m) => {
    if (m.direction !== 'IN' || !m.success || m.amountMinor !== expectedMinor) return false;
    const at = m.timestamp ? Date.parse(m.timestamp) : Number.NaN;
    return Number.isFinite(at) && at >= notBefore;
  });
  // Oldest first: if the exact amount arrived twice, the first one paid it.
  matches.sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
  return matches[0] ?? null;
}

/** The exact amount as the payer should type it: every digit, since the last ones matter. */
export function exactUsdc(minor: bigint): string {
  const whole = (minor / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;
}
