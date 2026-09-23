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
  // Same property, new store: a share token cannot be minted for a transfer
  // that does not exist. The read moved to transfers-store when transfers moved
  // to Postgres; `ForStaff` because minting a share is a system action on a
  // transfer whose owner has already been established.
  assert.match(source, /if \(!await readTransferForStaff\(transferIntentId\)\) return null/);

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
  const helper = await readFile(new URL('../lib/network-label.ts', import.meta.url), 'utf8');
  assert.match(helper, /SUI_NETWORK === 'mainnet'/);
  assert.match(helper, /Sui mainnet/);
  assert.match(helper, /Sui · sandbox, no customer funds/);
});

test('the customer never reads a digest, a blob id or a URL', async () => {
  const source = await readFile(new URL('../components/Receipt.tsx', import.meta.url), 'utf8');

  // What this section used to render: a 64-character hex string, and beneath it
  // the full https explorer address as its own link label. Neither is something
  // a person reads — a customer cannot check a digest by looking at one, and an
  // address rendered as prose is a URL bar that wandered onto a receipt.
  const proof = source.slice(source.indexOf('Verify independently'), source.indexOf('function ProofRow'));
  assert.doesNotMatch(proof, /\{txDigest\}/, 'the digest must not be rendered on screen');
  assert.doesNotMatch(proof, /\{explorerUrl\}/, 'the URL must not be its own link text');
  // The old shape: the id itself as the visible text, with a fallback string.
  // `reference={walrusBlobId ?? null}` is fine — that one is print-only.
  assert.doesNotMatch(
    proof,
    /\{walrusBlobId \?\? 'Archived/,
    'the blob id must not be rendered as the visible text',
  );

  // What replaces it: a state sentence and somewhere to go.
  assert.match(proof, /action="Check here"/);
  assert.match(proof, /action="Verify here"/);
  assert.match(proof, /Recorded on the network/);
});

test('the printed sheet keeps the reference, because a button is not clickable on paper', async () => {
  const source = await readFile(new URL('../components/Receipt.tsx', import.meta.url), 'utf8');

  // An accountant files the PDF. Strip the reference from it as well and the
  // artefact that exists to be verified carries no way to verify it.
  assert.match(source, /hidden break-all font-mono text-\[11px\] print:block/);
  assert.match(source, /print:hidden/, 'and the button, which paper cannot use, is hidden');
  assert.match(source, /reference=\{isPendingDigest \? null : txDigest\}/);
  assert.match(source, /reference=\{walrusBlobId \?\? null\}/);
});

test('an action that leads nowhere is not rendered', async () => {
  const source = await readFile(new URL('../components/Receipt.tsx', import.meta.url), 'utf8');
  // A button that goes nowhere reads as proof that failed.
  assert.match(source, /\{href \? \(/);
  assert.match(source, /href=\{isPendingDigest \? null : explorerUrl \?\? null\}/);
});
