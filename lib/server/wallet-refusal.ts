/**
 * What a customer is told when the business wallet cannot run for them (v2
 * brief 5.9). The wallet's own checks refuse in the operator's words: which
 * server setting is missing, which network it will not use. Those words are for
 * the server log. The browser gets a sentence a person can act on, with the
 * status unchanged (the Wallet and Home pages read 503 as "not open yet") and
 * the assurance that nothing was done.
 *
 * A refusal that is the customer's own (409: this business has no on-chain
 * account) is already written for them and passes through.
 */
export type WalletRefusal = { ok: false; status: number; error: string };

const UNAVAILABLE = 'Business wallets are not available for your workspace right now. Nothing was changed.';
const UPSTREAM = 'Splash could not reach the chain just now. Nothing was changed. Try again shortly.';

export function customerRefusal(refusal: WalletRefusal): { status: number; error: string } {
  if (refusal.status === 503) return { status: 503, error: UNAVAILABLE };
  if (refusal.status >= 500) return { status: refusal.status, error: UPSTREAM };
  return { status: refusal.status, error: refusal.error };
}

const LOG_EVERY_MS = 10 * 60_000;
const lastLogged = new Map<string, number>();

/**
 * The line for the server log when the wallet cannot run for a business, or
 * null when this business was logged a moment ago: one Settings load makes
 * several wallet calls, each of which would say the same thing. An address in
 * the reason (a chain endpoint, with its key) is left out of the line.
 */
export function refusalLogLine(orgId: string, reason: string, now: number = Date.now()): string | null {
  const before = lastLogged.get(orgId);
  if (before !== undefined && now - before < LOG_EVERY_MS) return null;
  if (lastLogged.size > 5000) lastLogged.clear();
  lastLogged.set(orgId, now);
  return `[wallet] refused for org ${orgId}: ${reason.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[address]')}`;
}
