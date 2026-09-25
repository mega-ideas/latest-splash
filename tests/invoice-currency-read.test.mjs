import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The invoice parser does not invent a currency, and the invoice loop's lane
 * question treats "not read" as "use the record".
 *
 * Red before green: `parseInvoice` defaulted to 'USD' on both paths whenever
 * it read no currency, and its pattern could not match "USDC". That invented
 * 'USD' was shown on the invoice loop, stored in the audit receipt and
 * remembered as the invoice's currency, and it fed the route's lane check.
 * On the tree before the fix `invoiceLocalCurrency` does not exist, and the
 * parser returns 'USD' for every case below that names no local currency.
 *
 * Scope, stated plainly: invoice records are three-letter currencies today
 * (/api/invoices validates `targetCurrency` as length 3), so a USDC record
 * cannot be created there yet. The USDC-record cases pin the lane rule for
 * when one can. A first version of this fix preferred "USDC" wherever it
 * appeared, which would have read a PHP invoice with "settle in USDC" in its
 * memo as USDC, and hidden a PHP document behind a USDC record: both are
 * pinned below as PHP.
 */

// The heuristic path, and nothing remembered: no model key, no MemWal.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.MEMWAL_PRIVATE_KEY;
delete process.env.MEMWAL_ACCOUNT_ID;

const copilot = () => import('../lib/server/copilot.ts');
const lane = () => import('../lib/payments/stablecoin-lane.ts');

/** parseInvoice takes the session's org (lib/server/copilot.ts); MemWal is off here, so nothing is remembered. */
const ORG = 'org-currency-read';
async function parse(text) {
  const { parseInvoice } = await copilot();
  return parseInvoice(text, ORG);
}

async function source(relative) {
  return (await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** What app/api/copilot/extract-invoice/route.ts hands the parser for a record (plus any document text). */
const routeText = ({ memo = '', payer = 'Acme PH', amountUsd = '1200.00', currency, document = '' }) =>
  `${memo} Vendor: ${payer} Amount due ${amountUsd} ${currency}${document ? `\n${document}` : ''}`;

/* ── The parser ────────────────────────────────────────────────────────── */

test('the parser reads the first local currency named, then USDC, then nothing, and never invents USD', async () => {
  const read = async (text) => (await parse(text)).currency;

  assert.equal(await read(routeText({ currency: 'PHP' })), 'PHP');
  assert.equal(await read('Invoice 1182. Total due: USD 250.00'), 'USD', 'a USD the document names is still USD');
  assert.equal(await read(routeText({ currency: 'USDC' })), 'USDC', 'was an invented USD');
  assert.equal(await read('Invoice 1182. Total 250.00, thank you'), '', 'none named: not a USD default');
  assert.equal(await read(''), '');
});

test('a USDC mention never hides a local currency', async () => {
  const read = async (text) => (await parse(text)).currency;

  assert.equal(await read(routeText({ memo: 'Please settle in USDC', currency: 'PHP' })), 'PHP', 'a memo mention does not re-label a PHP invoice');
  assert.equal(await read(routeText({ currency: 'USDC', document: 'Total due PHP 67,704.00' })), 'PHP', 'a PHP document behind a USDC record still reads PHP');
});

test('the parser claims no confidence it did not measure', async () => {
  for (const text of [routeText({ currency: 'PHP' }), 'Total 250.00', '']) {
    assert.equal((await parse(text)).confidence, null, `was 0.55 / 0.2 for ${JSON.stringify(text)}`);
  }
});

test('no invented currency, confidence or placeholder is left in the parser source', async () => {
  const text = await source('lib/server/copilot.ts');
  const parser = text.slice(text.indexOf('export async function parseInvoice('), text.indexOf('export async function optimizeBatch('));
  assert.ok(parser.length > 0);
  assert.doesNotMatch(parser, /\?\?\s*'USD'|\|\|\s*'USD'/, 'no USD default on either path');
  assert.doesNotMatch(parser, /confidence:\s*\d/, 'no fixed confidence on either path');
  assert.match(parser, /named\.find\(\(code\) => code !== 'USDC'\) \?\? \(named\.includes\('USDC'\) \? 'USDC' : ''\)/);
  // Model answers: only a code is a reading. 'XXX' is ISO 4217's "no currency"
  // and the prompt's own placeholder; "..." is the recipient placeholder.
  assert.match(parser, /\/\^\(USDC\|\[A-Z\]\{3\}\)\$\/\.test\(answered\) && answered !== 'XXX' \? answered : ''/);
  assert.match(parser, /named === '\.\.\.' \? '' : named/);

  // A vendor pattern is remembered (for the session's org) only when both
  // halves were read: never "settles in " with nothing, nor an invented USD.
  const remember = text.slice(text.indexOf('function rememberInvoiceVendor('), text.indexOf('export async function parseInvoice('));
  assert.match(remember, /if \(!vendor \|\| !currency\) return;/);
});

/* ── The lane question ─────────────────────────────────────────────────── */

test('the payout is local when the record or the reading names a local currency, and "not read" defers to the record', async () => {
  const { invoiceLocalCurrency } = await lane();
  assert.equal(invoiceLocalCurrency('PHP', ''), 'PHP', 'not read: the record decides');
  assert.equal(invoiceLocalCurrency('PHP', 'PHP'), 'PHP');
  assert.equal(invoiceLocalCurrency('PHP', undefined), 'PHP');
  assert.equal(invoiceLocalCurrency('USDC', ''), null);
  assert.equal(invoiceLocalCurrency('USDC', 'USDC'), null);
  assert.equal(invoiceLocalCurrency('usdc', ' usdc '), null);
  assert.equal(invoiceLocalCurrency('USDC', null), null);
  assert.equal(invoiceLocalCurrency('USDC', 'PHP'), 'PHP', 'a USDC record that says PHP on its face is still a PHP invoice');
  assert.equal(invoiceLocalCurrency('USDC', 'USD'), 'USD', 'a document that reads USD is a USD payout');
});

test('an unverified business: a USDC reading is not refused as fiat, and a PHP one still is', async () => {
  const { invoiceLocalCurrency, laneAccess, FIAT_LOCKED_REASON } = await lane();
  const unverified = 'REGISTERED';

  // What the route does, in order: read the document, ask which local
  // currency (if any) the payout is in, and only then consult the lane.
  const usdc = await parse(routeText({ currency: 'USDC' }));
  assert.equal(invoiceLocalCurrency('USDC', usdc.currency), null, 'no fiat lane to consult (the old invented USD made this USD)');

  const phpBehindUsdc = await parse(routeText({ currency: 'USDC', document: 'Total due PHP 67,704.00' }));
  assert.equal(invoiceLocalCurrency('USDC', phpBehindUsdc.currency), 'PHP', 'still refused: it is a PHP invoice');

  const php = await parse(routeText({ currency: 'PHP' }));
  assert.equal(invoiceLocalCurrency('PHP', php.currency), 'PHP');
  const access = laneAccess(unverified, 'FIAT_OUT_LOCAL');
  assert.equal(access.allowed, false, 'the PHP payout is still refused in verification');
  assert.equal(access.reason, FIAT_LOCKED_REASON);
  assert.equal(laneAccess('ACTIVE', 'FIAT_OUT_LOCAL').allowed, true, 'and allowed once verified');
});

test('the route asks the lane question through invoiceLocalCurrency, before recommending anything', async () => {
  const route = await source('app/api/copilot/extract-invoice/route.ts');
  const ask = route.indexOf('const localCurrency = invoiceLocalCurrency(invoice.targetCurrency, extraction.currency);');
  assert.ok(ask > 0, 'the record and the reading, in that order');
  assert.ok(ask < route.indexOf('if (localCurrency) {'));
  assert.ok(route.indexOf('if (localCurrency) {') < route.indexOf("laneAccess(state, 'FIAT_OUT_LOCAL')"));
  assert.ok(route.indexOf("laneAccess(state, 'FIAT_OUT_LOCAL')") < route.indexOf('const deliveryTier'));
  assert.doesNotMatch(route, /c !== 'USDC'/, 'the rule lives in one place now');
});

test('the invoice loop shows a currency that was not read as not read', async () => {
  const loop = await source('components/invoices/InvoiceLoop.tsx');
  assert.match(loop, /<ProofPill label="Currency" value=\{extraction\.currency \|\| 'Not read'\} \/>/);
});
