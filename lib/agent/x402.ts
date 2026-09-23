/**
 * x402 — the agentic-payment lane, parsed and explained, not yet spent.
 *
 * x402 is the HTTP 402 payment protocol (Coinbase spec; the Arbitrum
 * workshop facilitator at github.com/hummusonrails/x402-facilitator speaks
 * the same wire format): a server answers 402 with `accepts[]` payment
 * requirements; a client signs an EIP-3009 `transferWithAuthorization` for
 * USDC and retries with an X-PAYMENT header; a facilitator verifies and
 * settles on an EVM chain.
 *
 * What this module deliberately IS: the parse-and-explain half. Zeke can take
 * a 402 challenge, validate it, and put a human-readable, minor-units-exact
 * summary in front of the operator.
 *
 * What it deliberately is NOT — recorded here so nobody "finishes" it by
 * accident (docs/X402-ASSESSMENT.md carries the full argument):
 *
 *   1. Splash settles on Sui; x402 'exact' settles USDC on EVM chains. There
 *      is no shared rail today, so "integration" can only mean Splash
 *      operating an EVM spend wallet — new custody surface, new key, and a
 *      capability the Move invariants never reviewed.
 *   2. The product's first law is that the agent proposes and a HUMAN
 *      approves each release. Autonomous per-request micro-payments are the
 *      point of x402 — and the exact thing the pipeline exists to prevent.
 *      The honest bridge is the SESSION-PAYMENT MANDATE (Build Prompt v3.1
 *      §3.2): a capped, revocable, human-signed budget. That primitive is
 *      Move work awaiting Sebastian; until it exists, x402 spend has no home
 *      that respects the invariants.
 *
 * So `x402SettlementAvailability()` refuses, with the reason, always.
 */

/** Networks the reference facilitators actually serve. */
export const X402_KNOWN_NETWORKS = [
  // x402 v2 exact scheme on Sui (native USDC) — payable by a person, from
  // the Send USDC page; never by Zeke.
  'sui:mainnet',
  'arbitrum-one',
  'arbitrum-sepolia',
  'base',
  'base-sepolia',
] as const;

export interface X402Requirement {
  scheme: 'exact';
  network: string;
  /** Base units of the asset (USDC: 6dp), as a bigint — never float money. */
  maxAmountRequiredMinor: bigint;
  /** The payment asset: an ERC-20 contract on EVM, a full coin type on Sui. */
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
}

export interface X402Challenge {
  x402Version: number;
  requirements: X402Requirement[];
}

export class X402ParseError extends Error {}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new X402ParseError(`${field} must be a non-empty string`);
  return v;
}

/**
 * Parse a 402 response body. Amounts arrive as decimal strings of base units
 * per the spec; anything that does not survive BigInt is refused rather than
 * rounded.
 */
export function parseX402Challenge(input: unknown): X402Challenge {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new X402ParseError('not JSON');
    }
  }
  const body = input as Record<string, unknown>;
  if (!body || typeof body !== 'object') throw new X402ParseError('not an object');
  const version = body.x402Version;
  if (typeof version !== 'number') throw new X402ParseError('x402Version missing');
  const accepts = body.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) throw new X402ParseError('accepts[] missing or empty');

  const requirements = accepts.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const scheme = str(r.scheme, `accepts[${i}].scheme`);
    if (scheme !== 'exact') throw new X402ParseError(`unsupported scheme: ${scheme}`);
    // v2 names it `amount`; v1 called it `maxAmountRequired`.
    const amountRaw = str(r.amount ?? r.maxAmountRequired, `accepts[${i}].amount`);
    if (!/^\d+$/.test(amountRaw)) throw new X402ParseError(`maxAmountRequired is not integer base units: ${amountRaw}`);
    return {
      scheme: 'exact' as const,
      network: str(r.network, `accepts[${i}].network`),
      maxAmountRequiredMinor: BigInt(amountRaw),
      asset: str(r.asset, `accepts[${i}].asset`),
      payTo: str(r.payTo, `accepts[${i}].payTo`),
      // v2 moved the resource to the top level ({ url, description, mimeType }).
      resource: str(r.resource ?? (body.resource as { url?: unknown } | undefined)?.url, `accepts[${i}].resource`),
      description: typeof r.description === 'string' ? r.description : '',
      maxTimeoutSeconds: typeof r.maxTimeoutSeconds === 'number' ? r.maxTimeoutSeconds : 60,
    };
  });

  return { x402Version: version, requirements };
}

/** "0.010000 USDC-units" style, from 6dp base units, without ever touching float. */
export function formatX402Amount(minor: bigint, decimals = 6): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** The operator-facing summary Zeke reads out for one requirement. */
export function describeX402Requirement(req: X402Requirement): string {
  const known = (X402_KNOWN_NETWORKS as readonly string[]).includes(req.network);
  return [
    `The resource ${req.resource} asks for an x402 payment of ${formatX402Amount(req.maxAmountRequiredMinor)} in asset ${req.asset}`,
    `on ${req.network}${known ? '' : ' (a network no facilitator we know serves)'}, paid to ${req.payTo},`,
    `valid for ${req.maxTimeoutSeconds}s.`,
    req.description ? `The seller describes it as: ${req.description}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Whether Splash can settle an x402 payment. Today the answer is a refusal
 * with its reasons — and it must stay a refusal until the session-payment
 * mandate exists on-chain, because those reasons are invariants, not gaps.
 */
export function x402SettlementAvailability(): { available: false; reason: string } {
  return {
    available: false,
    reason:
      'Zeke can read this x402 request and price it, but Zeke never pays it: every release of value here is approved by a named human, and per-request agent spending waits for the capped, revocable, human-signed session mandate on-chain. If the seller accepts USDC on Sui mainnet, pay it yourself on the Send USDC page (x402): you approve it, sign it in your own wallet, and it counts against the same allowance as your transfers. Sellers that accept only EVM chains (Base, Arbitrum) are not payable from a Sui wallet.',
  };
}

/**
 * The Zeke read tool. Input is a pasted 402 response (text or object); the
 * result prices and explains it, and carries the settlement refusal so the
 * model cannot answer "paid" — there is nothing here that spends.
 * Minor units serialize as strings: the envelope layer must never meet a
 * bigint it did not ask for.
 */
export function quoteX402Payment(input: unknown): {
  status: 'QUOTED' | 'INVALID';
  requirements: Array<Omit<X402Requirement, 'maxAmountRequiredMinor'> & { maxAmountRequiredMinor: string; amount: string }>;
  summaries: string[];
  settlement: ReturnType<typeof x402SettlementAvailability>;
  message: string;
  observedAt: string;
} {
  const observedAt = new Date().toISOString();
  const settlement = x402SettlementAvailability();
  try {
    const challenge = parseX402Challenge((input as { challenge?: unknown } | null)?.challenge);
    const requirements = challenge.requirements.map((req) => ({
      ...req,
      maxAmountRequiredMinor: req.maxAmountRequiredMinor.toString(),
      amount: formatX402Amount(req.maxAmountRequiredMinor),
    }));
    return {
      status: 'QUOTED',
      requirements,
      summaries: challenge.requirements.map(describeX402Requirement),
      settlement,
      message:
        'This is a quote, not a payment. Splash cannot settle x402 today — read the settlement.reason to the user verbatim if they ask to pay it.',
      observedAt,
    };
  } catch (error) {
    return {
      status: 'INVALID',
      requirements: [],
      summaries: [],
      settlement,
      message: `That does not parse as an x402 challenge: ${error instanceof Error ? error.message : 'unknown error'}. Ask the user to paste the full 402 response body.`,
      observedAt,
    };
  }
}
