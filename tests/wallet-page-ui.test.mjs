import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';

/**
 * v2 Phase 3, brief 5.5: what the Wallet page is made of. The behaviour behind
 * each section is tested where it lives (wallet-overview, wallet-page-*,
 * wallet-funding*, withdrawals, wallet-authority, business-wallet-*); this
 * checks the page is built from those routes and from nothing else, that it
 * binds what the person was shown to what is sent, and that it keeps the
 * brief's copy rules.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const files = readdirSync(new URL('../components/wallet/', import.meta.url)).filter((f) => /\.tsx?$/.test(f));
const all = files.map((f) => [`components/wallet/${f}`, read(`components/wallet/${f}`)]);
const joined = all.map(([, text]) => text).join('\n');

test('the page is the business wallet: balance, add funds, withdraw, funding sources, history, activity, signers, rules, migration and upgrade alerts', () => {
  const page = read('components/wallet/WalletPage.tsx');
  for (const part of ['BalanceCard', 'AddFunds', 'Withdraw', 'FundingHistory', 'FundingSources', 'WalletActivity', 'SignersCard', 'RulesCard', 'Migration', 'AlertsCard', 'SigningInbox', 'SetupWallet']) {
    assert.match(page, new RegExp(`<${part}\\b`), part);
  }
  assert.match(page, /title="Wallet"/);
  assert.match(read('app/dashboard/wallet/page.tsx'), /<WalletPage alerts=\{alerts\} \/>/);
});

test('sending moved to Transfer and USDY to Treasury: the Wallet page quotes and sends nothing itself', () => {
  assert.doesNotMatch(code(joined), /\/api\/stablecoin\/(quote|submit|allowance)|\/api\/x402|Sign & send|signWithPasskey|signWithWallet/);
  assert.doesNotMatch(code(joined), /Usdy|USDY/);
  assert.match(joined, /href="\/dashboard\/transfer"/, 'a link to Transfer, where a payment is made');
  for (const gone of ['SendUsdcDesk', 'UsdyPreview', 'FundingPlanner']) {
    assert.equal(existsSync(new URL(`../components/stablecoin/${gone}.tsx`, import.meta.url)), false, `${gone} is gone`);
  }
});

test('every call goes to a wallet route that takes the business from the session, and none names a business, a wallet or an address', () => {
  const urls = [...code(joined).matchAll(/(?:call|useLoad|fetch)(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 20, `found ${urls.length} calls`);
  for (const url of urls) assert.match(url, /^\/api\/wallet\/|^\/api\/stablecoin\/wallet$/, url);
  assert.doesNotMatch(code(joined), /body: \{[^}]*(orgId|accountId|walletAddress|businessWallet|address:)/, 'nothing about a business or a wallet is sent: the server knows which');
  assert.doesNotMatch(code(joined), /\?(org|orgId|account|wallet|address)=/);
});

test('a withdrawal binds what was shown to what is sent, and a retry is the same withdrawal', () => {
  const w = read('components/wallet/Withdraw.tsx');
  assert.match(w, /acceptedReceiveMinor: quote\.receiveMinor, maxFeeMinor: quote\.maxFeeMinor/, 'the fee shown is the fee signed and the least received is the amount shown');
  assert.match(w, /newKey\('wd'\)/);
  assert.match(w, /if \(!key\) setKey\(newKey/, 'the key is made once per attempt, not per click');
  assert.match(w, /\n\s+key,\n/, 'the key goes as the Idempotency-Key');
  assert.doesNotMatch(code(w), /contentHash|walrusBlobId/, 'the audit bundle is the server’s to make');
  assert.match(w, /Leaves your wallet at most/);
});

test('a top-up is made only at a quote the person was shown, with one key per attempt', () => {
  const a = read('components/wallet/AddFunds.tsx');
  assert.match(a, /acceptedArrivesMinMinor: quote\.arrivesMinMinor/);
  assert.match(a, /if \(!quote \|\| !key\.current\) return;/);
  assert.match(a, /if \(!key\.current\) key\.current = newKey\('top'\)/);
  assert.match(a, /Splash adds none to a top-up/, 'a partner’s or network’s fee is theirs and is never marked up');
  // A link a partner gives is followed only if it is https or a path on this site.
  assert.match(a, /protocol === 'https:'/);
  assert.match(a, /startsWith\('\/'\) && !url\.startsWith\('\/\/'\)/);
});

test('a bank is added by an owner and checked against the company’s own name; a card is never typed in', () => {
  const s = read('components/wallet/FundingSources.tsx');
  assert.match(s, /Name on the account/);
  assert.match(s, /Only the last four digits are kept/);
  assert.doesNotMatch(code(s), /cardNumber|\bcvv\b|\bcvc\b/i);
  const route = read('components/wallet/RouteSetup.tsx');
  assert.match(route, /1 USDC test deposit/);
  assert.match(route, /status === 'verified'/);
});

test('staff migration: owners and the person in charge sign off with their own passkey, and nobody is offered a move the server would refuse', () => {
  const m = read('components/wallet/Migration.tsx');
  assert.match(m, /signApprovalWithPasskey\(passkey, made\.body\.signOff\.message\)/);
  assert.match(m, /migrationRows\(members, viewer\)/);
  assert.match(m, /Sign off their move/);
  assert.match(m, /PersonInCharge/);
  assert.match(m, /you\.authority === 'owner' \? <PersonInCharge/, 'only an owner appoints');
});

test('the signing screens decode on the device, and a wallet change reads in plain words', () => {
  const inbox = read('components/wallet/SigningInbox.tsx');
  assert.match(inbox, /<SignPanel/);
  assert.match(inbox, /r\.you\.mustSign && !r\.you\.signed/);
  const panel = read('components/transfer/SignPanel.tsx');
  assert.match(panel, /reviewOnDevice\(/);
  assert.match(panel, /plainActions\(/);
  assert.match(panel, /Transaction code/);
});

test('every control has a visible label, one height, and a name for assistive technology', () => {
  for (const [name, text] of all) {
    assert.doesNotMatch(code(text), /<input\b(?![^>]*type="checkbox")|<select\b|<textarea\b/, `${name}: a control made by hand`);
  }
  assert.match(read('components/wallet/parts.tsx'), /aria-label=\{label\}/);
  assert.match(read('components/wallet/SetupWallet.tsx'), /<fieldset/);
  assert.doesNotMatch(joined, /placeholder-only|aria-hidden="false"/);
});

test('no coral, Demo, Coming soon, testnet, licence claim, grid or unsigned partner name on the page, and the copy rules hold', () => {
  for (const [name, text] of all) {
    const body = code(text);
    assert.doesNotMatch(body, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|bg-grid|grid-background/i, name);
    assert.doesNotMatch(body, /\b(Hata|Fiuu|PDAX|DurianPay|Halliday|Stripe|TransFi|Bridge|Elliptic|Chainalysis|Sumsub)\b/, `${name} names a partner that is not signed`);
    assert.deepEqual(copyViolations(name, text), [], name);
  }
  // The only mainnet word is the rail label the brief asks for.
  assert.match(read('components/wallet/WalletPage.tsx'), /USDC on Sui · mainnet/);
});

test('an unavailable chain and a switched-off wallet each say so, and nothing is shown that was not read', () => {
  const page = read('components/wallet/WalletPage.tsx');
  assert.match(page, /walletState === 'off'/);
  assert.match(page, /walletState === 'unavailable'/);
  assert.match(page, /Splash could not reach the chain to read your wallet\. Nothing was changed\./);
  const balance = read('components/wallet/BalanceCard.tsx');
  assert.match(balance, /overview\.balanceError/);
  assert.match(balance, /b \? formatUsdc\(BigInt\(b\.availableMinor\)\) : 'Not available'/, 'an unreadable balance is "Not available", never zero');
});

test('the old Settings link for upgrade alerts lands on the wallet’s own rules section', () => {
  const redirect = read('app/dashboard/settings/spending-rules/page.tsx');
  assert.match(redirect, /redirect\('\/dashboard\/wallet#spending-rules'\)/);
  assert.match(read('components/wallet/RulesCard.tsx'), /id="spending-rules"/);
});
