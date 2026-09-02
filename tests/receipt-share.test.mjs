import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('receipt share module: unguessable slug, idempotent mint, single-record scope', async () => {
  const source = await readFile(new URL('../lib/server/receipt-share.ts', import.meta.url), 'utf8');
  // Reuses the pay-link slug generator (unguessable token, same pattern).
  assert.match(source, /createPayLinkSlug\(\)/);
  // Minting twice for the same intent returns the same token.
  assert.match(source, /intentTokens\.get\(transferIntentId\)/);
  // A token that does not resolve returns null — nothing else is reachable.
  assert.match(source, /if \(!record\) return null/);
  // Minting refuses unknown intents.
  assert.match(source, /if \(!readTransferIntent\(transferIntentId\)\) return null/);

  const route = await readFile(new URL('../app/api/receipts/share/route.ts', import.meta.url), 'utf8');
  // Mint is auth-gated; the public page itself is not.
  assert.match(route, /requireCustomerRequest/);
  assert.match(route, /createReceiptShare/);

  const page = await readFile(new URL('../app/receipt/[token]/page.tsx', import.meta.url), 'utf8');
  // Public page renders the SAME Receipt component from the stored record.
  assert.match(page, /findReceiptShare/);
  assert.match(page, /<Receipt/);
  assert.match(page, /notFound\(\)/);
  assert.doesNotMatch(page, /getCustomerSession|requireCustomer/);
});

test('receipt business face keeps chain vocabulary inside the verify section only', async () => {
  const source = await readFile(new URL('../components/Receipt.tsx', import.meta.url), 'utf8');

  // Proof layer exists with the business-named sections.
  assert.match(source, /Verify independently/);
  assert.match(source, /Settlement record/);
  assert.match(source, /Tamper-evident archive/);
  // Network line is profile-driven with the sandbox default.
  assert.match(source, /Sui · sandbox, no customer funds/);
  // Raw chain terms stay out of the business face labels.
  assert.doesNotMatch(source, /Transaction digest/);
  assert.doesNotMatch(source, /On-chain proof/);
  // Verify section links to the money path.
  assert.match(source, /href="\/trust"/);
});

test('receipt step ships the accountant PDF and supplier share actions', async () => {
  const step = await readFile(new URL('../components/transfer/StepReceipt.tsx', import.meta.url), 'utf8');
  assert.match(step, /PDF for your accountant/);
  assert.match(step, /Share with supplier/);
  assert.match(step, /fetch\('\/api\/receipts\/share'/);
  assert.match(step, /size: A4/);
  assert.match(step, /receiptNetworkLine\(\)/);
});

test('network line flips to mainnet from the runtime profile', async () => {
  const helper = await readFile(new URL('../lib/network.ts', import.meta.url), 'utf8');
  assert.match(helper, /SUI_NETWORK === 'mainnet'/);
  assert.match(helper, /Sui mainnet/);
  assert.match(helper, /Sui · sandbox, no customer funds/);
  // The legacy import path stays a re-export of the single source of truth.
  const legacy = await readFile(new URL('../lib/network-label.ts', import.meta.url), 'utf8');
  assert.match(legacy, /export \{ receiptNetworkLine \} from '@\/lib\/network'/);
});

test('network profile: sandbox ribbon on testnet, live badge only on mainnet with a real package id', async () => {
  const { getNetworkProfile, explorerTxUrl } = await import('../lib/network.ts');
  const saved = { ...process.env };
  try {
    delete process.env.NEXT_PUBLIC_SUI_NETWORK;
    process.env.SUI_NETWORK = 'testnet';
    process.env.NEXT_PUBLIC_CORRIDOR_STATUS = 'PH=live,ID=planned';
    let profile = getNetworkProfile();
    assert.equal(profile.network, 'testnet');
    assert.equal(profile.badges.ribbon, 'Sandbox — Sui testnet — no customer funds');
    assert.equal(profile.badges.live, null);
    assert.equal(profile.corridors.find((c) => c.code === 'PH').status, 'sandbox', 'nothing is live on testnet');
    assert.equal(explorerTxUrl('abc', 'suiscan'), 'https://suiscan.xyz/testnet/tx/abc');

    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    process.env.NEXT_PUBLIC_SPLASH_CORE_PACKAGE_ID = '0x0';
    profile = getNetworkProfile();
    assert.equal(profile.badges.ribbon, null);
    assert.equal(profile.badges.live, null, 'a placeholder package id is not live');

    process.env.NEXT_PUBLIC_SPLASH_CORE_PACKAGE_ID = '0xec3b063e9f0b0c3a9c6d2f4b1a7e8d9c0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    profile = getNetworkProfile();
    assert.equal(profile.badges.live, 'Live on Sui mainnet');
    assert.equal(profile.corridors.find((c) => c.code === 'PH').status, 'live');
    assert.equal(explorerTxUrl('abc'), 'https://suivision.xyz/txblock/abc');
    assert.equal(profile.badges.receiptLine, 'Sui mainnet');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
