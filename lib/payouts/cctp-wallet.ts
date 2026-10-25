/**
 * `cctp_wallet`: USDC to a recipient on another chain, over Circle's CCTP V2
 * only (D5(c), D13). USDC only; the legacy protocol is never used.
 *
 * There is no partner deposit address and no payer of record in between: the
 * owners' transaction opens a cross-chain intent, pays it from the business
 * wallet (`confirm_cross_chain_from_business_wallet`, which takes Splash's
 * kind-3 fee on Sui and hands back exactly the principal beside a
 * BridgeObligation), and a registered bridge adapter burns that coin through
 * Circle's TokenMessenger to the intent's domain and mint recipient in the
 * same PTB. Circle attests; anyone relays the mint (destination caller zero).
 * Circle's fee is its own line, taken at mint, bounded by the intent's
 * bridge_max_fee, and never Splash's.
 *
 * The interface's verbs on this route:
 *   quote            Circle's fee from Sui (standard transfer) and what
 *                    arrives. The sandbox uses Circle's published table
 *                    (lib/payments/cctp.ts); live must read Circle's fee API.
 *   createPayout     checks the destination (chain, domain, the mint
 *                    recipient re-derived from the address) and keys the
 *                    payout by the intent id. Circle takes no instruction
 *                    before a burn; the burn itself is the instruction.
 *   postSettlement   the burn's Sui digest, for the attestation to be polled.
 *   status           the attestation and mint, polled from Circle.
 *   handleWebhook    Circle sends none: live refuses every webhook. The
 *                    sandbox takes the sandbox-signed ones, for tests.
 *   returnOrReverse  before the burn nothing is at Circle, so a reversal is
 *                    accepted; after it, a burn cannot be undone (recovery is
 *                    relaying the mint again), so it is refused.
 *
 * Live (production): refuses without CCTP_IRIS_API_URL and
 * CCTP_BRIDGE_ADAPTER_TYPE (`partner_not_configured`), and with them
 * (`partner_not_connected`): no bridge adapter is registered in splash_core
 * (docs/v2/phase1-move-design.md), so no cross-chain intent can settle, and
 * the PTB builder refuses kind 3 (`cross_chain_not_built`).
 */

import { createHmac, randomBytes } from 'node:crypto';

import {
  aptosMintRecipient,
  evmMintRecipient,
  FUNDING_CHAINS,
  FundingPlanError,
  solanaTokenAccountMintRecipient,
  STANDARD_FINALITY_THRESHOLD,
  type CctpPeerChain,
} from '../payments/cctp.ts';
import { PAYOUT_QUOTE_TTL_MS } from './bank-adapter.ts';
import {
  sandboxWebhookSecretFor,
  PayoutPartnerUnavailable,
  verifyPayoutWebhook,
  WebhookRejected,
  type CrossChainPayoutInstruction,
  type PayoutInstruction,
  type PayoutPartner,
  type PayoutQuote,
} from './partner.ts';
import { placeSandboxOrder, sandboxOrderStatus, sandboxReverse } from './sandbox-orders.ts';

export const CCTP_WALLET_CREDENTIALS = ['CCTP_IRIS_API_URL', 'CCTP_BRIDGE_ADAPTER_TYPE'] as const;

const FACTS = { id: 'cctp_wallet', partners: [], countries: [], currencies: ['USDC'] } as const;

/** Circle's listed standard-transfer fee from Sui (lib/payments/cctp.ts, read 24 Oct 2026): 0 bps. */
const SUI_STANDARD_FEE_BPS = 0n;

const SANDBOX_KEY = randomBytes(32);

/** A chain this route pays, or why not. */
function destinationChain(chain: string | undefined): CctpPeerChain {
  const c = String(chain ?? '').trim().toUpperCase() as CctpPeerChain;
  const facts = FUNDING_CHAINS[c];
  if (!facts) throw new PayoutPartnerUnavailable('Circle does not list that chain for CCTP V2 with USDC.', 'currency_not_offered');
  if (facts.addressFormat === 'STELLAR' || facts.addressFormat === 'STARKNET') {
    throw new PayoutPartnerUnavailable(`Splash does not pay ${facts.label} over CCTP: Circle does not say how its mint recipient is written safely.`, 'currency_not_offered');
  }
  return c;
}

/** The mint recipient the address gives on its chain. A Solana recipient is its USDC token account. */
function mintRecipientFor(chain: CctpPeerChain, recipient: string): string {
  const format = FUNDING_CHAINS[chain].addressFormat;
  try {
    if (format === 'EVM') return evmMintRecipient(recipient);
    if (format === 'APTOS') return aptosMintRecipient(recipient);
    return solanaTokenAccountMintRecipient(recipient);
  } catch (error) {
    if (error instanceof FundingPlanError) throw new PayoutPartnerUnavailable(error.message, 'bad_instruction');
    throw error;
  }
}

/** The checks every cross-chain instruction passes before it is keyed. */
export function checkCrossChainInstruction(input: PayoutInstruction): CrossChainPayoutInstruction {
  if (input.route !== 'cctp') throw new PayoutPartnerUnavailable('This route pays USDC to another chain only.', 'not_on_this_route');
  if (input.currency !== 'USDC') throw new PayoutPartnerUnavailable('CCTP carries USDC only.', 'currency_not_offered');
  const chain = destinationChain(input.destination.chain);
  if (FUNDING_CHAINS[chain].cctpDomain !== input.destination.domain) throw new PayoutPartnerUnavailable('The CCTP domain is not the chain named.', 'bad_instruction');
  if (mintRecipientFor(chain, input.destination.recipient) !== input.destination.mintRecipient.toLowerCase()) {
    throw new PayoutPartnerUnavailable('The mint recipient is not the address named. Nothing was burned.', 'bad_instruction');
  }
  if (/^0x0{64}$/.test(input.destination.mintRecipient)) throw new PayoutPartnerUnavailable('The zero address cannot receive USDC.', 'bad_instruction');
  if (input.expectedUsdcMinor <= 0n) throw new PayoutPartnerUnavailable('A payout carries an amount.', 'bad_instruction');
  if (input.minFinalityThreshold !== STANDARD_FINALITY_THRESHOLD) throw new PayoutPartnerUnavailable('From Sui, CCTP is a standard transfer only.', 'bad_instruction');
  if (input.maxBridgeFeeMinor < 0n || input.maxBridgeFeeMinor > input.expectedUsdcMinor) throw new PayoutPartnerUnavailable("Circle's fee bound is not valid.", 'bad_instruction');
  if (input.minReceiveMinor > input.expectedUsdcMinor - input.maxBridgeFeeMinor) throw new PayoutPartnerUnavailable("The least received is above what arrives after Circle's fee bound.", 'bad_instruction');
  return input;
}

/** What the burn's reversal reasons mean: only these come before any burn. */
const BEFORE_BURN = new Set(['not_sent', 'instruction_unconfirmed', 'destination_revoked', 'legal_name_changed']);

function sandboxAdapter(env: NodeJS.ProcessEnv): PayoutPartner {
  return {
    ...FACTS,
    rail: 'cctp',
    mode: 'sandbox',
    async depositAddress() {
      throw new PayoutPartnerUnavailable('A cross-chain payout has no partner deposit address: the USDC is burned through CCTP in the owners’ transaction.', 'not_on_this_route');
    },
    async checkAccount() {
      throw new PayoutPartnerUnavailable('A cross-chain payout pays an address, not a bank account.', 'not_on_this_route');
    },
    async quote({ currency, sendMinor, now, destinationChain: chain }): Promise<PayoutQuote> {
      if (currency !== 'USDC') throw new PayoutPartnerUnavailable('CCTP carries USDC only.', 'currency_not_offered');
      const c = destinationChain(chain);
      const fee = (sendMinor * SUI_STANDARD_FEE_BPS + 9_999n) / 10_000n;
      const window = Math.floor(now.getTime() / PAYOUT_QUOTE_TTL_MS);
      return {
        partner: 'cctp_wallet',
        currency: 'USDC',
        sendMinor,
        rateMicro: 1_000_000n,
        receiveMinor: sendMinor - fee,
        lines: [{ partner: 'circle', label: `Circle CCTP fee to ${FUNDING_CHAINS[c].label} (sandbox, from Circle's published table)`, currency: 'USDC', amountMinor: fee }],
        quoteRef: `sbq_cctp_${createHmac('sha256', SANDBOX_KEY).update(`${c}:${sendMinor}:${window}`).digest('hex').slice(0, 24)}`,
        expiresAt: new Date(now.getTime() + PAYOUT_QUOTE_TTL_MS),
        sandbox: true,
      };
    },
    async createPayout(input) {
      checkCrossChainInstruction(input);
      return placeSandboxOrder('cctp_wallet', 'cctp', input, env);
    },
    async postSettlement() {
      // The sandbox polls no attestation.
    },
    async status({ intentId, partnerRef }) {
      return sandboxOrderStatus('cctp_wallet', intentId, partnerRef);
    },
    handleWebhook({ rawBody, signature, now }) {
      return verifyPayoutWebhook(rawBody, signature, sandboxWebhookSecretFor(env, 'cctp_wallet'), now);
    },
    async returnOrReverse(input) {
      // Only an order this sandbox took, back to the wallet it named; a burn is never reversed.
      if (!BEFORE_BURN.has(input.reason)) {
        sandboxReverse('cctp_wallet', input, false);
        return { accepted: false, sandbox: true };
      }
      return sandboxReverse('cctp_wallet', input);
    },
  };
}

function liveAdapter(env: NodeJS.ProcessEnv): PayoutPartner {
  const missing = CCTP_WALLET_CREDENTIALS.filter((k) => !(env[k] ?? '').trim());
  const refuse = (): never => {
    if (missing.length > 0) {
      throw new PayoutPartnerUnavailable(`Cross-chain payouts are not set up on this server (${missing.join(', ')} not set). Nothing was burned.`, 'partner_not_configured');
    }
    throw new PayoutPartnerUnavailable('Cross-chain payouts are not connected yet: no bridge adapter is registered on chain. Nothing was burned.', 'partner_not_connected');
  };
  return {
    ...FACTS,
    rail: 'cctp',
    mode: 'live',
    depositAddress: async () => refuse(),
    checkAccount: async () => refuse(),
    quote: async () => refuse(),
    createPayout: async (input) => {
      if (missing.length === 0) checkCrossChainInstruction(input);
      return refuse();
    },
    postSettlement: async () => refuse(),
    status: async () => refuse(),
    handleWebhook() {
      // Circle sends no payout webhooks; the attestation is polled.
      try {
        return refuse();
      } catch (error) {
        throw new WebhookRejected((error as Error).message, (error as PayoutPartnerUnavailable).code);
      }
    },
    returnOrReverse: async () => refuse(),
  };
}

export function cctpWalletAdapter(production: boolean, env: NodeJS.ProcessEnv): PayoutPartner {
  return production ? liveAdapter(env) : sandboxAdapter(env);
}
