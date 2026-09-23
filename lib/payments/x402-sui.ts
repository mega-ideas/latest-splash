import { normalizeStructTag } from '@mysten/sui/utils';

import { normaliseSuiAddress, SUI_USDC_COIN_TYPE, StablecoinLaneError } from './stablecoin-lane.ts';

/**
 * x402 on Sui mainnet — the protocol half, with no I/O.
 *
 * x402 v2 over HTTP (coinbase/x402 specs/transports-v2/http.md): a seller
 * answers 402 with a base64-JSON PaymentRequired in the PAYMENT-REQUIRED
 * header; the buyer retries with a base64-JSON PaymentPayload in
 * PAYMENT-SIGNATURE; the seller's facilitator settles and answers 200 with a
 * base64-JSON SettlementResponse in PAYMENT-RESPONSE. v1 sellers put the
 * challenge in the body and read X-PAYMENT; both are accepted here.
 *
 * The Sui "exact" scheme (specs/schemes/exact/scheme_exact_sui.md): the
 * payload is the buyer's signed Sui transaction; the facilitator simulates
 * it, checks the payTo address sees a balance change EQUAL to `amount`, and
 * broadcasts it. The buyer pays gas unless the seller offers a gas station.
 *
 * Splash accepts exactly one kind of requirement: exact, sui:mainnet, native
 * USDC. Anything else is described and refused — an EVM seller is not
 * payable from a Sui wallet, and a different asset is not USDC.
 */

export interface X402Resource {
  url: string;
  description: string;
  mimeType: string;
}

/** One entry of `accepts`, kept verbatim so it can be echoed as `accepted`. */
export interface X402Accept {
  raw: Record<string, unknown>;
  scheme: string;
  network: string;
  amountMinor: bigint;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402PaymentRequired {
  x402Version: number;
  resource: X402Resource;
  accepts: X402Accept[];
  error: string | null;
}

export class X402Error extends Error {}

const MAINNET_USDC = normalizeStructTag(SUI_USDC_COIN_TYPE.mainnet);

function b64decodeJson(value: string): unknown {
  const text = typeof Buffer !== 'undefined'
    ? Buffer.from(value, 'base64').toString('utf8')
    : new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
  return JSON.parse(text);
}

export function encodeHeader(value: unknown): string {
  const text = JSON.stringify(value);
  return typeof Buffer !== 'undefined'
    ? Buffer.from(text, 'utf8').toString('base64')
    : btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/**
 * Parse a seller's challenge: the PAYMENT-REQUIRED header (v2), or a JSON
 * body (v1, or a v2 seller that also puts it in the body). Amounts must be
 * integer base units; anything else is refused, never rounded.
 */
export function parsePaymentRequired(input: { header?: string | null; body?: unknown }, requestedUrl: string): X402PaymentRequired {
  let doc: unknown = null;
  if (input.header) {
    try {
      doc = b64decodeJson(input.header);
    } catch {
      throw new X402Error('The seller’s PAYMENT-REQUIRED header is not valid base64 JSON.');
    }
  } else if (input.body && typeof input.body === 'object') {
    doc = input.body;
  }
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.x402Version !== 'number' || !Array.isArray(d.accepts) || d.accepts.length === 0) {
    throw new X402Error('This 402 response is not an x402 payment request (no x402Version / accepts).');
  }

  const resourceObj = (d.resource && typeof d.resource === 'object' ? d.resource : {}) as Record<string, unknown>;
  const accepts = d.accepts.map((entry, i) => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const amountRaw = String(r.amount ?? r.maxAmountRequired ?? '');
    if (!/^\d+$/.test(amountRaw)) throw new X402Error(`accepts[${i}] amount is not integer base units: "${amountRaw}"`);
    return {
      raw: r,
      scheme: String(r.scheme ?? ''),
      network: String(r.network ?? ''),
      amountMinor: BigInt(amountRaw),
      asset: String(r.asset ?? ''),
      payTo: String(r.payTo ?? ''),
      maxTimeoutSeconds: typeof r.maxTimeoutSeconds === 'number' ? r.maxTimeoutSeconds : 60,
      extra: (r.extra && typeof r.extra === 'object' ? r.extra : {}) as Record<string, unknown>,
    };
  });
  const v1Resource = typeof accepts[0].raw.resource === 'string' ? (accepts[0].raw.resource as string) : null;
  return {
    x402Version: d.x402Version,
    resource: {
      url: typeof resourceObj.url === 'string' ? resourceObj.url : v1Resource ?? requestedUrl,
      description: String(resourceObj.description ?? accepts[0].raw.description ?? ''),
      mimeType: String(resourceObj.mimeType ?? accepts[0].raw.mimeType ?? ''),
    },
    accepts,
    error: typeof d.error === 'string' ? d.error : null,
  };
}

/** The one requirement Splash can pay, or why none qualifies. */
export function selectSuiRequirement(pr: X402PaymentRequired):
  | { ok: true; accept: X402Accept; payTo: string }
  | { ok: false; reason: string } {
  const offered = pr.accepts.map((a) => `${a.network || '?'} (${a.scheme || '?'})`).join(', ');
  for (const a of pr.accepts) {
    if (a.scheme !== 'exact' || a.network !== 'sui:mainnet') continue;
    let asset: string;
    try {
      asset = normalizeStructTag(a.asset);
    } catch {
      continue;
    }
    if (asset !== MAINNET_USDC) continue;
    if (a.amountMinor <= 0n) return { ok: false, reason: 'The seller asked for a zero amount.' };
    let payTo: string;
    try {
      payTo = normaliseSuiAddress(a.payTo);
    } catch (error) {
      return { ok: false, reason: `The seller’s payTo is not a Sui address: ${error instanceof StablecoinLaneError ? error.message : a.payTo}` };
    }
    return { ok: true, accept: a, payTo };
  }
  return {
    ok: false,
    reason: `This seller does not accept USDC on Sui mainnet (it offers: ${offered}). Splash pays x402 only in native USDC on Sui mainnet; EVM-only sellers are not payable from a Sui wallet.`,
  };
}

/** The PAYMENT-SIGNATURE (v2) / X-PAYMENT (v1) value for a signed transaction. */
export function paymentHeader(
  pr: X402PaymentRequired,
  accept: X402Accept,
  signed: { transaction: string; signature: string },
): { name: 'PAYMENT-SIGNATURE' | 'X-PAYMENT'; value: string } {
  const payload = { signature: signed.signature, transaction: signed.transaction };
  if (pr.x402Version >= 2) {
    return {
      name: 'PAYMENT-SIGNATURE',
      value: encodeHeader({ x402Version: pr.x402Version, resource: pr.resource, accepted: accept.raw, payload }),
    };
  }
  return {
    name: 'X-PAYMENT',
    value: encodeHeader({ x402Version: pr.x402Version, scheme: accept.scheme, network: accept.network, payload }),
  };
}

export interface X402Settlement {
  success: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
  errorReason: string | null;
}

/** The seller's PAYMENT-RESPONSE (v2) / X-PAYMENT-RESPONSE (v1), if it sent one. */
export function parseSettlement(header: string | null | undefined): X402Settlement | null {
  if (!header) return null;
  try {
    const s = b64decodeJson(header) as Record<string, unknown>;
    return {
      success: s.success === true,
      transaction: typeof s.transaction === 'string' ? s.transaction : null,
      network: typeof s.network === 'string' ? s.network : null,
      payer: typeof s.payer === 'string' ? s.payer : null,
      errorReason: typeof s.errorReason === 'string' ? s.errorReason : null,
    };
  } catch {
    return null;
  }
}

/** The seller's price, fixed at quote time, must still be the price at payment time. */
export function sameRequirement(a: X402Accept, b: X402Accept): boolean {
  return a.amountMinor === b.amountMinor
    && a.network === b.network
    && a.scheme === b.scheme
    && normaliseSuiAddress(a.payTo) === normaliseSuiAddress(b.payTo)
    && normalizeStructTag(a.asset) === normalizeStructTag(b.asset);
}
