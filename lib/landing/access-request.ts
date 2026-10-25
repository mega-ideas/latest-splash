/**
 * A request for pilot access to a route that is not live yet (v2 brief D16).
 *
 * Pure, so the form and the route check the same rules. A request names one
 * pilot route, a work email and a company. `website` is a honeypot: a person
 * never sees it, a bot fills it, and a filled one is answered like success
 * and stored nowhere.
 */
import { z } from 'zod';

import { PILOT_ROUTES, type PilotCurrency } from './routes.ts';

export const COMPANY_MAX = 160;

const schema = z.object({
  email: z.string().trim().max(254).email(),
  company: z.string().trim().min(2).max(COMPANY_MAX),
  currency: z.enum(PILOT_ROUTES.map((r) => r.currency) as [PilotCurrency, ...PilotCurrency[]]),
  website: z.string().optional(),
});

export type AccessRequest = { email: string; company: string; currency: PilotCurrency };

export type ParsedAccessRequest =
  | { ok: true; value: AccessRequest; spam?: boolean }
  | { ok: false; field: 'email' | 'company' | 'currency'; error: string };

const MESSAGES = {
  email: 'Enter a work email, like name@company.com.',
  company: 'Enter your company name.',
  currency: 'Choose one of the pilot routes.',
} as const;

export function parseAccessRequest(body: unknown): ParsedAccessRequest {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.path[0];
    const field = first === 'company' || first === 'currency' ? first : 'email';
    return { ok: false, field, error: MESSAGES[field] };
  }
  const { email, company, currency, website } = parsed.data;
  const value = { email: email.toLowerCase(), company, currency };
  return website?.trim() ? { ok: true, value, spam: true } : { ok: true, value };
}
