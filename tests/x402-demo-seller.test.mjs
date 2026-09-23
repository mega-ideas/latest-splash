import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeHeader, parsePaymentRequired, selectSuiRequirement } from '../lib/payments/x402-sui.ts';

/**
 * The Splash demo x402 seller, up to the point where it would touch the
 * chain: it is off without a payee, it answers a proper v2 402 that Splash's
 * own buyer can pay, and it refuses a payment for anything but its price.
 */

const PAYTO = `0x${'5e'.repeat(32)}`;
const URL_ = 'http://localhost:3000/api/x402/demo/corridor-fees';

async function route() {
  const { handleDemoSeller } = await import('../lib/server/x402-demo-seller.ts');
  return { GET: handleDemoSeller };
}

async function withPayTo(value, fn) {
  const prev = process.env.X402_DEMO_PAY_TO;
  if (value === undefined) delete process.env.X402_DEMO_PAY_TO;
  else process.env.X402_DEMO_PAY_TO = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.X402_DEMO_PAY_TO;
    else process.env.X402_DEMO_PAY_TO = prev;
  }
}

test('without X402_DEMO_PAY_TO the demo seller is off', async () => {
  const { GET } = await route();
  await withPayTo(undefined, async () => {
    const res = await GET(new Request(URL_));
    assert.equal(res.status, 503);
  });
});

test('it answers a v2 402 that the Splash buyer accepts: exact, sui:mainnet, 0.01 USDC to the payee', async () => {
  const { GET } = await route();
  await withPayTo(PAYTO, async () => {
    const res = await GET(new Request(URL_));
    assert.equal(res.status, 402);
    const pr = parsePaymentRequired({ header: res.headers.get('payment-required') }, URL_);
    assert.equal(pr.x402Version, 2);
    const pick = selectSuiRequirement(pr);
    assert.equal(pick.ok, true);
    assert.equal(pick.accept.amountMinor, 10_000n);
    assert.equal(pick.payTo, PAYTO);
  });
});

test('a payment for the wrong price, or not a payment at all, is refused with a 402', async () => {
  const { GET } = await route();
  await withPayTo(PAYTO, async () => {
    const garbage = await GET(new Request(URL_, { headers: { 'PAYMENT-SIGNATURE': '%%%' } }));
    assert.equal(garbage.status, 402);

    const cheap = encodeHeader({
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'sui:mainnet', amount: '1', payTo: PAYTO },
      payload: { transaction: 'AA==', signature: 'AA==' },
    });
    const res = await GET(new Request(URL_, { headers: { 'PAYMENT-SIGNATURE': cheap } }));
    assert.equal(res.status, 402);
    const settlement = JSON.parse(Buffer.from(res.headers.get('payment-response'), 'base64').toString());
    assert.equal(settlement.success, false);
    assert.match(settlement.errorReason, /not for this price/);
  });
});
