/**
 * The sandbox payout partners' order book (outside production only), so a
 * sandbox behaves as a partner keyed by the intent id and the expected
 * amount does (v2 §4.5, Sky's decision of 24 Oct 2026):
 *
 *   - the same instruction again names the same order;
 *   - the same intent id for another payout (another amount, deposit
 *     address, account commitment, currency, destination, quote reference
 *     or ISO 20022 message) is refused
 *     (`instruction_conflict`), never answered with the first order;
 *   - `status` answers only for an order it took, under its own reference
 *     (`payout_not_found` otherwise): no status is made up;
 *   - `returnOrReverse` (`sandboxReverse`) is taken only for an order it
 *     holds, under its own reference, and only back to the return address
 *     the instruction named (the business wallet); a reversal by the intent
 *     id alone (a lost answer, no reference) is taken whether or not the
 *     order is held. A reversed instruction is not taken again.
 *   - a reversal by the intent id alone for an order it does not hold (the
 *     instruction is still on its way) is kept against the intent id, with
 *     the return address it was asked for: the instruction that arrives
 *     after it is refused (`instruction_conflict`), never taken live, and
 *     the kept reversal answers no status and no reference. Live partners
 *     are held to the same (PayoutPartner.returnOrReverse).
 *
 * References are an HMAC of the route and intent id. With the sandbox
 * webhook secret set, the key is derived from it, so every server instance
 * names the same order for a retry (a webhook signed for the order then
 * matches whichever instance took it); without it, a random per-process key.
 * Either way a reference cannot be worked out from an intent id alone.
 *
 * The book itself is per process: an instance that did not take the order
 * does not know it, and says so.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { payoutSandboxWebhookSecret, PayoutPartnerUnavailable, type PartnerPayoutStatus, type PayoutInstruction, type PayoutPartnerId } from './partner.ts';

const PROCESS_KEY = randomBytes(32);

/** An order taken, or (`partnerRef` '') a reversal by intent id kept before any instruction arrived. */
type Order = { fingerprint: string; partnerRef: string; status: PartnerPayoutStatus; returnAddress: string; reversed: boolean };

const BOOK = new Map<string, Order>();

/** The key sandbox references are made with: derived from the sandbox webhook secret when set. */
export function sandboxRefKey(env: NodeJS.ProcessEnv): Buffer {
  const secret = payoutSandboxWebhookSecret(env);
  if (!secret) return PROCESS_KEY;
  return createHmac('sha256', secret).update('splash:payout-sandbox-refs:v1').digest();
}

/** JSON with sorted keys and bigints as strings: the same message always hashes the same. */
function canonical(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * What makes two instructions for one intent id the same payout: the
 * amounts, the destination, the quote and, on a bank route, the whole
 * ISO 20022 message, so a changed message is refused as a strict partner
 * would refuse it.
 */
function fingerprintOf(input: PayoutInstruction): string {
  const parts: string[] = [input.route, input.intentId.toLowerCase(), input.expectedUsdcMinor.toString(), input.currency, input.minReceiveMinor.toString(), input.settleByMs.toString(), input.sourceWallet.toLowerCase(), input.returnAddress.toLowerCase(), input.purposeCode, input.quoteRef];
  if (input.route === 'bank') {
    parts.push(input.depositAddress.toLowerCase(), input.beneficiaryRef.toLowerCase(), input.rateMicro.toString(), input.receiveMinor.toString(), createHash('sha256').update(canonical(input.iso20022)).digest('hex'));
  } else {
    parts.push(input.destination.chain, String(input.destination.domain), input.destination.mintRecipient.toLowerCase(), input.maxBridgeFeeMinor.toString());
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Take an instruction: the same one again names the same order; another payout under the intent id is refused. */
export function placeSandboxOrder(route: PayoutPartnerId, tag: string, input: PayoutInstruction, env: NodeJS.ProcessEnv): { partnerRef: string; sandbox: true } {
  const key = `${route}:${input.intentId.toLowerCase()}`;
  const fingerprint = fingerprintOf(input);
  const existing = BOOK.get(key);
  if (existing) {
    if (existing.reversed) {
      throw new PayoutPartnerUnavailable('The partner reversed the instruction for this intent id; it is not taken again. Nothing was sent.', 'instruction_conflict');
    }
    if (existing.fingerprint !== fingerprint) {
      throw new PayoutPartnerUnavailable('The partner already holds an instruction for this intent id with another amount or destination. Nothing was sent.', 'instruction_conflict');
    }
    return { partnerRef: existing.partnerRef, sandbox: true };
  }
  const partnerRef = `sb_${tag}_${createHmac('sha256', sandboxRefKey(env)).update(`${tag}:${input.intentId.toLowerCase()}`).digest('hex').slice(0, 24)}`;
  BOOK.set(key, { fingerprint, partnerRef, status: 'instructed', returnAddress: input.returnAddress.toLowerCase(), reversed: false });
  return { partnerRef, sandbox: true };
}

/** An order's status, only for one this sandbox took, under its own reference. */
export function sandboxOrderStatus(route: PayoutPartnerId, intentId: string, partnerRef: string): { status: PartnerPayoutStatus; sandbox: true } {
  const order = BOOK.get(`${route}:${String(intentId ?? '').toLowerCase()}`);
  if (!order || !order.partnerRef || order.partnerRef !== partnerRef) throw new PayoutPartnerUnavailable('The sandbox partner holds no such payout.', 'payout_not_found');
  return { status: order.status, sandbox: true };
}

/**
 * A reversal (no deposit followed) or a return (funds received): only for an
 * order this sandbox took, under its own reference, and only back to the
 * address the instruction named. `partnerRef` '' is a reversal by the intent
 * id alone, for an instruction whose answer was lost: taken when the order is
 * held (to its own return address) and when nothing is held, and then kept
 * against the intent id with the address asked for, so the instruction that
 * arrives later is refused. `final` false checks the order without reversing
 * it (a route that may refuse the reason).
 */
export function sandboxReverse(
  route: PayoutPartnerId,
  input: { intentId: string; partnerRef: string; returnAddress: string },
  final = true,
): { accepted: true; sandbox: true } {
  const key = `${route}:${String(input.intentId ?? '').toLowerCase()}`;
  const order = BOOK.get(key);
  const byIntentOnly = input.partnerRef === '';
  if (!order) {
    if (!byIntentOnly) throw new PayoutPartnerUnavailable('The sandbox partner holds no such payout.', 'payout_not_found');
    // Nothing held yet: the instruction may still be on its way. The reversal
    // is kept against the intent id so that instruction is refused when it arrives.
    if (final) BOOK.set(key, { fingerprint: '', partnerRef: '', status: 'instructed', returnAddress: String(input.returnAddress ?? '').toLowerCase(), reversed: true });
    return { accepted: true, sandbox: true };
  }
  if (!byIntentOnly && (!order.partnerRef || order.partnerRef !== input.partnerRef)) throw new PayoutPartnerUnavailable('The sandbox partner holds no such payout.', 'payout_not_found');
  if (String(input.returnAddress ?? '').toLowerCase() !== order.returnAddress) {
    throw new PayoutPartnerUnavailable('A return goes only to the address the instruction named. Nothing was returned.', 'bad_instruction');
  }
  if (final) order.reversed = true;
  return { accepted: true, sandbox: true };
}
