import type { KybLifecycleState } from '../compliance/kyb-state.ts';
import {
  anchorFeeEnabled,
  formatUsdc,
  gaslessEnabled,
  laneAccess,
  MIN_STABLECOIN_TRANSFER_MINOR,
  parseUsdcMinor,
  quoteStablecoinTransfer,
  StablecoinLaneError,
  stablecoinLimitsFor,
  type StablecoinDestination,
} from '../payments/stablecoin-lane.ts';
import type { RecipientLookup } from './recipient-tools.ts';

/**
 * "Send 500 USDC to Manila Parts" — prepared for a person to send.
 *
 * Deterministic and before the model, like the lane refusal: the message is
 * read by a fixed pattern, the recipient is resolved among SAVED wallet
 * recipients, and the fee and the 30-day allowance come from the lane's own
 * functions. The answer is a card that opens Send USDC with the recipient and
 * the amount filled in.
 *
 * What Zeke does NOT do, by construction: quote (a quote reserves allowance),
 * approve, or sign. The person checks the prepared transfer, it is approved
 * the workspace's way (WhatsApp code + passkey, or a click), and their own
 * wallet signs it — and the send screen re-checks everything this did. The
 * link carries a recipient id Splash issued and an amount re-printed from
 * integer minor units: nothing typed in the chat reaches it verbatim.
 */

export type UsdcHandoff = {
  title: string;
  lines: string[];
  href: string;
  cta: string;
};

export type HandoffAnswer = { text: string; handoff: UsdcHandoff | null };

export interface HandoffDeps {
  laneState(orgId: string): Promise<KybLifecycleState>;
  findRecipient(orgId: string, name: string): Promise<RecipientLookup>;
  /** Unused allowance in the rolling window, or null when it cannot be read. */
  remainingAllowance(orgId: string): Promise<bigint | null>;
  feeAddressConfigured(): boolean;
  /** 'SPLASH' when the saved recipient's wallet is a Splash user's. */
  destinationOf(orgId: string, recipientId: string): Promise<StablecoinDestination>;
  /** The audit-anchor fee on transfers out of Splash; off unless switched on. */
  anchorFeeOn(): boolean;
  /** Wallet transfers carry no network fee while this is on (STABLECOIN_GASLESS). */
  gaslessOn(): boolean;
}

// "send 500 USDC to Manila Parts", "pay 1,250.50 usdc to Cebu Traders",
// "transfer $75 USDC to Acme", "send 500 in USDC to Acme". USDC must be
// said: "pay Maria 500" is a payout request and belongs to the lane rules.
const AMOUNT_FIRST = /^\s*(?:please\s+)?(?:can you\s+)?(?:send|pay|transfer)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(?:in\s+)?usdc\s+to\s+(.+?)\s*$/i;
// "send USDC 500 to Manila Parts".
const COIN_FIRST = /^\s*(?:please\s+)?(?:can you\s+)?(?:send|pay|transfer)\s+usdc\s+\$?(\d[\d,]*(?:\.\d+)?)\s+to\s+(.+?)\s*$/i;
// "send Manila Parts 500 USDC", "pay Manila Parts 500 in USDC".
const NAME_FIRST = /^\s*(?:please\s+)?(?:can you\s+)?(?:send|pay)\s+(.+?)\s+\$?(\d[\d,]*(?:\.\d+)?)\s*(?:in\s+)?usdc\s*$/i;

function cleanName(raw: string): string {
  return raw
    .replace(/[.!?]+$/, '')
    .replace(/\s+(?:on|via)\s+sui(?:\s+mainnet)?$/i, '')
    // "Maria's Slush wallet" → "Maria"
    .replace(/(?:['’]s)?\s+(?:(?:slush|metamask|sui)\s+)?wallet$/i, '')
    .replace(/\s+please$/i, '')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

export function parseUsdcSendIntent(message: string): { amount: string; name: string } | null {
  const text = message.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (text.length > 200) return null;
  const a = AMOUNT_FIRST.exec(text) ?? COIN_FIRST.exec(text);
  if (a) {
    const name = cleanName(a[2]);
    return name ? { amount: a[1].replace(/,/g, ''), name } : null;
  }
  const b = NAME_FIRST.exec(text);
  if (b) {
    const name = cleanName(b[1]);
    return name ? { amount: b[2].replace(/,/g, ''), name } : null;
  }
  return null;
}

/** Minor units back to the plain decimal the send screen parses: 500000000n → "500". */
function plainAmount(minor: bigint): string {
  const whole = minor / 1_000_000n;
  const frac = (minor % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function usdcHandoffFor(orgId: string, message: string, deps: HandoffDeps): Promise<HandoffAnswer | null> {
  const intent = parseUsdcSendIntent(message);
  return intent ? prepareUsdcHandoff(orgId, intent, deps) : null;
}

/**
 * The same preparation for a recipient name and an amount already known —
 * what Zeke's `prepareUsdcTransfer` tool calls when the model, not the fixed
 * phrasing, understood the request. Same checks, same card, same limits:
 * nothing is quoted, reserved, approved or signed here.
 */
export async function prepareUsdcHandoff(
  orgId: string,
  intent: { name: string; amount: string },
  deps: HandoffDeps,
): Promise<HandoffAnswer> {
  let principal: bigint;
  try {
    principal = parseUsdcMinor(intent.amount.replace(/,/g, '').replace(/^\$/, '').trim());
  } catch (error) {
    const why = error instanceof StablecoinLaneError || error instanceof Error ? error.message : 'that amount is not valid';
    return { text: `I can't prepare that: ${why}.`, handoff: null };
  }
  if (principal < MIN_STABLECOIN_TRANSFER_MINOR) {
    return { text: `I can't prepare that: the smallest wallet transfer is ${formatUsdc(MIN_STABLECOIN_TRANSFER_MINOR)} USDC.`, handoff: null };
  }

  const state = await deps.laneState(orgId);
  const lane = laneAccess(state, 'STABLECOIN_WALLET');
  if (!lane.allowed) return { text: lane.reason, handoff: null };

  const lookup = await deps.findRecipient(orgId, intent.name);
  if (lookup.status === 'NOT_FOUND') {
    return {
      text: `No saved wallet recipient matches "${intent.name}". I only prepare USDC for recipients you have saved yourself — add their Slush or MetaMask Sui address under Recipients.`,
      handoff: null,
    };
  }
  if (lookup.status === 'AMBIGUOUS') {
    return { text: `${lookup.message} ${lookup.candidates.map((c) => c.name).join(', ')}.`, handoff: null };
  }
  const match = lookup.match;
  if (match.payoutMethod !== 'WALLET') {
    return {
      text: `${match.name} is saved as a bank recipient. USDC goes to a Sui wallet — save their Slush or MetaMask Sui address under Recipients to send them USDC.`,
      handoff: null,
    };
  }
  if (!match.payable) {
    return { text: `I can't prepare a transfer to ${match.name}: ${match.blockedBecause ?? 'this recipient cannot be paid yet.'}`, handoff: null };
  }

  // Free to a Splash user's wallet; out of Splash, the audit-anchor fee when
  // it is switched on (free until then). Same rule as the send screen.
  const quote = quoteStablecoinTransfer(principal, {
    destination: await deps.destinationOf(orgId, match.id),
    anchorFeeOn: deps.anchorFeeOn(),
  });
  if (quote.feeMinor > 0n && !deps.feeAddressConfigured()) {
    return { text: 'Transfers out of Splash are not open yet: Splash’s mainnet fee address is not configured, so nothing can be sent until it is.', handoff: null };
  }

  const limits = stablecoinLimitsFor(state);
  if (limits && principal > limits.perTransferMinor) {
    return { text: `That is more than one transfer can carry: the limit is ${formatUsdc(limits.perTransferMinor)} USDC per transfer.`, handoff: null };
  }
  const remaining = await deps.remainingAllowance(orgId);
  if (remaining !== null && principal > remaining) {
    return {
      text: `That is more than the ${formatUsdc(remaining)} USDC left in your 30-day allowance, so it would be refused. Send less, or wait for earlier transfers to roll out of the window.`,
      handoff: null,
    };
  }

  const params = new URLSearchParams({ to: match.id, amount: plainAmount(principal), from: 'zeke' });
  return {
    text:
      `I've prepared it — ${formatUsdc(principal)} USDC to ${match.name}. I can't send it: open it in Send USDC, ` +
      'check it, get it approved your workspace’s way, and sign it with your wallet.',
    handoff: {
      title: 'Prepared, not sent',
      lines: [
        `To ${match.name}${match.wallet ? ` · ${match.wallet}` : ''}`,
        `Amount ${formatUsdc(principal)} USDC`,
        quote.feeMinor === 0n
          ? `Splash fee: free${quote.destination === 'SPLASH' ? ' (to another Splash user)' : ''}`
          : `Audit-anchor fee ${formatUsdc(quote.feeMinor)} USDC, added on top`,
        deps.gaslessOn()
          ? `Leaves your wallet ${formatUsdc(quote.totalDebitMinor)} USDC, with no network fee`
          : `Leaves your wallet ${formatUsdc(quote.totalDebitMinor)} USDC, plus a little SUI for gas`,
        ...(remaining !== null ? [`${formatUsdc(remaining - principal)} USDC of your 30-day allowance left after`] : []),
      ],
      href: `/dashboard/send-usdc?${params.toString()}`,
      cta: 'Review in Send USDC',
    },
  };
}

/** The live dependencies: the same lookups and ledger the send screen uses. */
export function liveHandoffDeps(): HandoffDeps {
  return {
    async laneState(orgId) {
      const { zekeLaneState } = await import('./zeke-lane-guard.ts');
      return zekeLaneState(orgId);
    },
    async findRecipient(orgId, name) {
      const { findSavedRecipient } = await import('./recipient-tools.ts');
      return findSavedRecipient({ orgId, name });
    },
    async remainingAllowance(orgId) {
      if (!process.env.DATABASE_URL) return null;
      try {
        const [{ getDb }, { readAllowance }] = await Promise.all([
          import('../db/client.ts'),
          import('../server/stablecoin-outflows.ts'),
        ]);
        const { allowance } = await readAllowance(getDb(), orgId);
        return allowance.remainingMinor;
      } catch {
        return null;
      }
    },
    feeAddressConfigured() {
      return Boolean((process.env.SPLASH_FEE_ADDRESS_MAINNET ?? '').trim());
    },
    async destinationOf(orgId, recipientId) {
      // Without the database there is no saved address to look up: out of
      // Splash is the conservative answer (it is the one that may carry a fee).
      if (!process.env.DATABASE_URL) return 'EXTERNAL';
      const [{ getDb }, { readRecipient }, { isSplashWallet }] = await Promise.all([
        import('../db/client.ts'),
        import('../server/recipients-store.ts'),
        import('../server/stablecoin-deps.ts'),
      ]);
      const recipient = await readRecipient(orgId, recipientId);
      if (!recipient?.walletAddress) return 'EXTERNAL';
      return (await isSplashWallet(getDb(), recipient.walletAddress)) ? 'SPLASH' : 'EXTERNAL';
    },
    anchorFeeOn() {
      return anchorFeeEnabled();
    },
    gaslessOn() {
      return gaslessEnabled();
    },
  };
}
