/**
 * Get paid (v2 brief 5.8): what an anonymous payer may say from the pay link.
 *
 * Anyone holding the link can post this, so every field is bounded and the
 * reference has a plain form: it is shown to the business in the Get paid
 * list and the Mark as paid sheet, and stored in its own columns
 * (payer_reported_*), never over the payer the business named.
 */
import { z } from 'zod';

import { MAX_REFERENCE_LENGTH, MIN_REFERENCE_LENGTH, REFERENCE_FORM } from './patch-rules.ts';

export const MAX_PAYER_NAME_LENGTH = 120;
/** RFC 5321's limit on a forward path. */
export const MAX_PAYER_EMAIL_LENGTH = 254;

const paymentReportSchema = z.object({
  payerOrgName: z.string().trim().min(2).max(MAX_PAYER_NAME_LENGTH),
  payerOrgEmail: z.string().trim().max(MAX_PAYER_EMAIL_LENGTH).email(),
  paymentReference: z.string().trim().min(MIN_REFERENCE_LENGTH).max(MAX_REFERENCE_LENGTH).regex(REFERENCE_FORM),
});

export type PaymentReportInput = z.infer<typeof paymentReportSchema>;

export function parsePaymentReport(body: unknown) {
  return paymentReportSchema.safeParse(body);
}
