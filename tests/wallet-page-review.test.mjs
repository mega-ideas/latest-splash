import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildWalletOverview } from '../lib/server/wallet-overview.ts';
import { RATE_LIMITS } from '../lib/server/rate-limit.ts';

/**
 * v2 Phase 3, the p3-5.5 review: small gaps on the Wallet page. Holds that
 * cannot be read are said to be unchecked, not shown as a hold on the whole
 * balance; an old link forwards only the keys a payment link carries; the two
 * chain-reading GETs are limited.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const WALLET = `0x${'ab'.repeat(32)}`;

const deps = (over = {}) => ({
  userId: 'u_1',
  role: 'OWNER',
  readAccount: async () => ({ wallet: WALLET, pendingWallet: null, nominatedWallet: null }),
  readUsdc: async () => ({ coinMinor: 2_000_000n, addressBalanceMinor: 10_500_000n }),
  heldUsdc: async () => 1_500_000n,
  signers: async () => null,
  namesOf: async () => new Map(),
  ...over,
});

test('holds that cannot be read are marked unchecked, and nothing is offered as available', async () => {
  const known = await buildWalletOverview(deps());
  assert.equal(known.balance.holdsUnknown, false);
  const unknown = await buildWalletOverview(deps({ heldUsdc: async () => { throw new Error('holds'); } }));
  assert.equal(unknown.balance.holdsUnknown, true);
  assert.equal(unknown.balance.availableMinor, '0', 'fail closed');
});

test('the balance card says holds could not be checked instead of calling the whole balance held', () => {
  const card = read('components/wallet/BalanceCard.tsx');
  assert.match(card, /holdsUnknown/);
  assert.match(card, /could not be checked/);
});

test('an old Wallet link forwards only the keys a payment link carries', () => {
  const page = code(read('app/dashboard/wallet/page.tsx'));
  assert.match(page, /FORWARDED\s*=\s*new Set\(\['to', 'amount', 'from'\]\)|FORWARDED\s*=\s*\['to', 'amount', 'from'\]/);
  assert.match(page, /FORWARDED\.(has|includes)\(key\)/);
});

test('the overview and migration reads are rate limited before they read the chain', () => {
  assert.ok(RATE_LIMITS.walletReadUser, 'a rule for wallet reads');
  assert.ok(RATE_LIMITS.walletReadUser.limit >= 120, 'a page load and a few reloads are never refused');
  const overview = code(read('app/api/wallet/overview/route.ts'));
  assert.ok(overview.indexOf('limitWalletReads') > 0 && overview.indexOf('limitWalletReads') < overview.indexOf('liveWalletContext('), 'overview is limited before the chain is read');
  const migration = code(read('app/api/wallet/migration/route.ts'));
  const get = migration.slice(migration.indexOf('export async function GET'), migration.indexOf('export async function POST'));
  assert.ok(get.indexOf('limitWalletReads') > 0 && get.indexOf('limitWalletReads') < get.indexOf('readUsdc'), 'migration GET is limited before the chain is read');
});
