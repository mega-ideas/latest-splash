/**
 * What the Get paid create route accepts (POST /api/invoices).
 *
 * The amount is read as text and must be a plain USDC amount: up to twelve
 * digits, up to two decimals, above zero. `z.coerce.number()` took 0.001
 * (stored as 0.00, a zero-dollar invoice with a live pay link), 1e21 and
 * Infinity (an error after the document was already sealed and stored), and
 * numbers past 2^53 that had already lost digits. A JSON number is read by the
 * digits it prints, so 5000 and 1250.5 still work.
 */
import { z } from 'zod';

import { isCreateKey } from './create-once.ts';

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

/** The amount as text with exactly two decimals ("1250.50"), or null when it is not a payable amount. */
export function readInvoiceAmount(raw: unknown): string | null {
  const text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : typeof raw === 'string' ? raw.trim() : '';
  if (!AMOUNT.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const fixed = `${whole.replace(/^0+(?=\d)/, '')}.${(frac + '00').slice(0, 2)}`;
  return /[1-9]/.test(fixed) ? fixed : null;
}

/** USDC has six decimals; the amount in its smallest unit. */
export function invoiceAmountOf(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

export const createInvoiceSchema = z.object({
  issuerOrg: z.string().trim().min(2),
  payerOrgName: z.string().trim().min(2).optional(),
  payerOrgEmail: z.string().email().optional().or(z.literal('')),
  amountUsd: z.unknown().transform((value, ctx) => {
    const amount = readInvoiceAmount(value);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount above zero with at most two decimals, like 1250.00.' });
      return z.NEVER;
    }
    return amount;
  }),
  targetCurrency: z.string().trim().length(3),
  dueDate: z.string().min(8),
  memo: z.string().trim().max(500).optional(),
  documentBase64: z.string().optional(),
  /** One per invoice the dialog is creating, kept across retries (lib/invoices/create-once.ts). */
  createKey: z.string().refine(isCreateKey, 'createKey must be a UUID'),
});
