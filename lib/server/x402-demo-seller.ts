import { fromBase64 } from '@mysten/sui/utils';

import { ACTIVE_USD_CORRIDORS } from '@/lib/fx/corridors';
import { normaliseSuiAddress, SUI_USDC_COIN_TYPE } from '@/lib/payments/stablecoin-lane';
import { verifyStablecoinTransfer } from '@/lib/payments/stablecoin-verify';
import { encodeHeader } from '@/lib/payments/x402-sui';
import { digestOf, executeTransfer, laneClient, readTransfer, senderOf, simulateTransfer } from '@/lib/server/stablecoin-chain';

/**
 * The Splash demo x402 SELLER — so the buyer lane can be exercised end to end
 * with real USDC on Sui mainnet, against a seller whose code is in this repo.
 *
 * It sells Splash's active corridor fee schedule for 0.01 USDC, paid to
 * X402_DEMO_PAY_TO. It is its own facilitator: it checks the buyer-signed
 * transaction pays exactly the price to that address and nothing else, then
 * broadcasts it. It holds no key and pays no gas — the buyer signed and pays
 * for everything. Public by design: x402 buyers are not Splash users.
 */

const PRICE_MINOR = 10_000n; // 0.01 USDC
const USDC = SUI_USDC_COIN_TYPE.mainnet;

function paymentRequired(resourceUrl: string, payTo: string) {
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: 'Splash corridor fee schedule (JSON), sold by the Splash demo seller over x402.',
      mimeType: 'application/json',
    },
    accepts: [{
      scheme: 'exact',
      network: 'sui:mainnet',
      amount: PRICE_MINOR.toString(),
      asset: USDC,
      payTo,
      maxTimeoutSeconds: 120,
      extra: {},
    }],
  };
}

function product() {
  return {
    product: 'Splash corridor fee schedule',
    corridors: ACTIVE_USD_CORRIDORS.map((c) => ({ corridor: c.pair, currency: c.currency, feeBps: c.feeBps })),
    note: 'Fees in basis points on the USD amount. Rates are quoted live at transfer time and are not part of this product.',
    asOf: new Date().toISOString(),
  };
}

function refuse(required: ReturnType<typeof paymentRequired>, reason: string, payer: string | null = null) {
  return Response.json({ ...required, error: reason }, {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': encodeHeader({ ...required, error: reason }),
      'PAYMENT-RESPONSE': encodeHeader({ success: false, errorReason: reason, transaction: '', network: 'sui:mainnet', payer }),
      'Cache-Control': 'no-store',
    },
  });
}

/** The whole seller, as a web-standard handler (the route adds a rate limit). */
export async function handleDemoSeller(request: Request): Promise<Response> {
  let payTo: string;
  try {
    payTo = normaliseSuiAddress(process.env.X402_DEMO_PAY_TO ?? '');
  } catch {
    return Response.json(
      { error: 'The Splash demo x402 seller is off: X402_DEMO_PAY_TO is not a configured Sui address.' },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const required = paymentRequired(`${url.origin}${url.pathname}`, payTo);

  const header = request.headers.get('payment-signature') ?? request.headers.get('x-payment');
  if (!header) {
    return Response.json({ ...required, error: 'Payment required' }, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encodeHeader(required), 'Cache-Control': 'no-store' },
    });
  }

  let transaction: string;
  let signature: string;
  let accepted: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      accepted?: Record<string, unknown>;
      payload?: { transaction?: string; signature?: string };
    };
    transaction = String(decoded.payload?.transaction ?? '');
    signature = String(decoded.payload?.signature ?? '');
    accepted = decoded.accepted ?? {};
  } catch {
    return refuse(required, 'PAYMENT-SIGNATURE is not valid base64 JSON.');
  }
  const offer = required.accepts[0];
  if (String(accepted.amount ?? '') !== offer.amount || String(accepted.network ?? '') !== offer.network
    || String(accepted.scheme ?? '') !== offer.scheme || String(accepted.payTo ?? '').toLowerCase() !== payTo) {
    return refuse(required, 'The payment is not for this price, payee or network.');
  }

  let bytes: Uint8Array;
  let payer: string;
  try {
    bytes = fromBase64(transaction);
    payer = normaliseSuiAddress(senderOf(bytes) ?? '');
  } catch {
    return refuse(required, 'The payment transaction could not be read.');
  }
  const client = laneClient();
  const expected = { sender: payer, coinType: USDC, legs: [{ address: payTo, amountMinor: PRICE_MINOR }] };
  const deliver = (digest: string) => Response.json(product(), {
    headers: {
      'PAYMENT-RESPONSE': encodeHeader({ success: true, transaction: digest, network: 'sui:mainnet', payer, amount: PRICE_MINOR.toString() }),
      'Cache-Control': 'no-store',
    },
  });

  // Paid already (a buyer resending the same payment): deliver again, once
  // the chain agrees it paid this price to this payee.
  const digest = digestOf(bytes);
  const already = await readTransfer(client, digest).catch(() => null);
  if (already) {
    return verifyStablecoinTransfer(expected, already).ok ? deliver(digest) : refuse(required, 'That transaction did not pay this price.', payer);
  }

  const dry = await simulateTransfer(client, bytes);
  const check = verifyStablecoinTransfer(expected, dry);
  if (!check.ok) return refuse(required, check.reason, payer);

  const executed = await executeTransfer(client, bytes, signature).catch((error: unknown) => ({
    digest,
    success: false,
    error: error instanceof Error ? error.message : 'broadcast failed',
    sender: payer,
    balanceChanges: [],
  }));
  if (!executed.success || !verifyStablecoinTransfer(expected, executed).ok) {
    return refuse(required, `The payment did not settle: ${executed.error ?? 'balance changes did not match'}`, payer);
  }
  return deliver(executed.digest);
}
