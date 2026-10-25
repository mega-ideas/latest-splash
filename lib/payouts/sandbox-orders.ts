/**
 * The sandbox payout partners' order book (outside production only), so a
 * sandbox behaves as a partner keyed by the intent id and the expected
 * amount does (v2 §4.5, Sky's decision of 24 Oct 2026):
 *
 *   - the same instruction again names the same order;
 *   - the same intent id for another payout (another amount, deposit
 *     address, account commitment, currency or destination) is refused
 *     (`instruction_conflict`), never answered with the first order;
 *   - `status` answers only for an order it took, under its own reference
 *     (`payout_not_found` otherwise): no status is made up.
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

type Order = { fingerprint: string; partnerRef: string; status: PartnerPayoutStatus };

const BOOK = new Map<string, Order>();

/** The key sandbox references are made with: derived from the sandbox webhook secret when set. */
export function sandboxRefKey(env: NodeJS.ProcessEnv): Buffer {
  const secret = payoutSandboxWebhookSecret(env);
  if (!secret) return PROCESS_KEY;
  return createHmac('sha256', secret).update('splash:payout-sandbox-refs:v1').digest();
}

/** What makes two instructions for one intent id the same payout. */
function fingerprintOf(input: PayoutInstruction): string {
  const parts: string[] = [input.route, input.intentId.toLowerCase(), input.expectedUsdcMinor.toString(), input.currency, input.minReceiveMinor.toString(), input.settleByMs.toString(), input.sourceWallet.toLowerCase(), input.returnAddress.toLowerCase(), input.purposeCode];
  if (input.route === 'bank') {
    parts.push(input.depositAddress.toLowerCase(), input.beneficiaryRef.toLowerCase(), input.rateMicro.toString(), input.receiveMinor.toString());
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
    if (existing.fingerprint !== fingerprint) {
      throw new PayoutPartnerUnavailable('The partner already holds an instruction for this intent id with another amount or destination. Nothing was sent.', 'instruction_conflict');
    }
    return { partnerRef: existing.partnerRef, sandbox: true };
  }
  const partnerRef = `sb_${tag}_${createHmac('sha256', sandboxRefKey(env)).update(`${tag}:${input.intentId.toLowerCase()}`).digest('hex').slice(0, 24)}`;
  BOOK.set(key, { fingerprint, partnerRef, status: 'instructed' });
  return { partnerRef, sandbox: true };
}

/** An order's status, only for one this sandbox took, under its own reference. */
export function sandboxOrderStatus(route: PayoutPartnerId, intentId: string, partnerRef: string): { status: PartnerPayoutStatus; sandbox: true } {
  const order = BOOK.get(`${route}:${String(intentId ?? '').toLowerCase()}`);
  if (!order || order.partnerRef !== partnerRef) throw new PayoutPartnerUnavailable('The sandbox partner holds no such payout.', 'payout_not_found');
  return { status: order.status, sandbox: true };
}
