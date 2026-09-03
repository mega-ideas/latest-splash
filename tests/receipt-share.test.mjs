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
  // lib/network-label.ts was reduced to a re-export; lib/network.ts is the
  // single source of truth for network facts and was kept by the restore.
  const helper = await readFile(new URL('../lib/network-label.ts', import.meta.url), 'utf8');
  assert.match(helper, /export \{ receiptNetworkLine \} from '@\/lib\/network'/);
  const source = await readFile(new URL('../lib/network.ts', import.meta.url), 'utf8');
  assert.match(source, /SUI_NETWORK/);
  assert.match(source, /Sui mainnet/);
  assert.match(source, /Sui · sandbox, no customer funds/);
});
