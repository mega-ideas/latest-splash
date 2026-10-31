import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildWalletOverview } from '../lib/server/wallet-overview.ts';

/**
 * v2 Phase 3, brief 5.5: what the Wallet page reads first. The business is
 * the session's, the wallet is the one the BusinessAccount names on chain,
 * and whatever cannot be read is said so, never guessed.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const WALLET = `0x${'ab'.repeat(32)}`;

function deps(over = {}) {
  return {
    userId: 'u_1',
    role: 'OWNER',
    readAccount: async () => ({ wallet: WALLET, pendingWallet: null, nominatedWallet: null }),
    readUsdc: async () => ({ coinMinor: 2_000_000n, addressBalanceMinor: 10_500_000n }),
    heldUsdc: async (_wallet, balance) => (balance > 0n ? 1_500_000n : 0n),
    signers: async () => ({ threshold: 2, singleSigner: false, members: [{ userId: 'u_1', weight: 1 }, { userId: 'u_2', weight: 1 }, { userId: 'u_3', weight: 1 }] }),
    namesOf: async (ids) => new Map(ids.filter((i) => i !== 'u_3').map((i) => [i, `Name ${i}`])),
    ...over,
  };
}

test('a business with a wallet: its balance in coins and address balance, what is held, and what can be paid', async () => {
  const o = await buildWalletOverview(deps());
  assert.equal(o.walletState, 'ready');
  assert.equal(o.wallet, WALLET);
  assert.deepEqual(o.balance, { usdcMinor: '12500000', heldMinor: '1500000', availableMinor: '11000000' });
  assert.equal(o.balanceError, null);
});

test('no wallet yet, and a wallet being set up, are said as such with no balance read', async () => {
  let balanceReads = 0;
  const none = await buildWalletOverview(deps({ readAccount: async () => ({ wallet: null, pendingWallet: null, nominatedWallet: null }), readUsdc: async () => { balanceReads += 1; return { coinMinor: 0n, addressBalanceMinor: 0n }; } }));
  assert.equal(none.walletState, 'none');
  assert.equal(none.balance, null);
  const nominated = await buildWalletOverview(deps({ readAccount: async () => ({ wallet: null, pendingWallet: null, nominatedWallet: WALLET }) }));
  assert.equal(nominated.walletState, 'pending');
  assert.equal(nominated.wallet, null);
  assert.equal(balanceReads, 0);
});

test('a chain that does not answer is "unavailable", and a balance that cannot be read leaves the wallet shown without one', async () => {
  const down = await buildWalletOverview(deps({ readAccount: async () => { throw new Error('rpc 502 at https://internal.example'); } }));
  assert.equal(down.walletState, 'unavailable');
  assert.doesNotMatch(JSON.stringify(down), /internal\.example|rpc 502/, 'no internal detail leaves the server');
  const noBalance = await buildWalletOverview(deps({ readUsdc: async () => { throw new Error('boom'); } }));
  assert.equal(noBalance.walletState, 'ready');
  assert.equal(noBalance.balance, null);
  assert.match(noBalance.balanceError, /could not be read/);
  assert.doesNotMatch(JSON.stringify(noBalance), /boom/);
});

test('funds on hold are never counted as available, and available is never negative', async () => {
  const over = await buildWalletOverview(deps({ heldUsdc: async () => 99_000_000n }));
  assert.equal(over.balance.availableMinor, '0');
  const unreadableHolds = await buildWalletOverview(deps({ heldUsdc: async () => { throw new Error('holds'); } }));
  assert.equal(unreadableHolds.balance.availableMinor, '0', 'when holds cannot be read, nothing is offered as available');
  assert.equal(unreadableHolds.balance.heldMinor, '12500000');
});

test('the signers are named from the business, the viewer is marked, and an unknown person is not given a name', async () => {
  const o = await buildWalletOverview(deps());
  assert.equal(o.signers.threshold, 2);
  assert.equal(o.signers.singleSigner, false);
  assert.deepEqual(o.signers.members.map((m) => [m.name, m.you, m.weight]), [['Name u_1', true, 1], ['Name u_2', false, 1], ['A signer', false, 1]]);
  assert.ok(!('userId' in o.signers.members[0]), 'a signer is shown by name, not by id');
});

test('only an owner may manage the wallet, and everyone else is told their role', async () => {
  assert.equal((await buildWalletOverview(deps())).canManage, true);
  const staff = await buildWalletOverview(deps({ role: 'MAKER' }));
  assert.equal(staff.canManage, false);
  assert.equal(staff.role, 'MAKER');
});

test('the route takes the business from the session and reads nothing about a business from the request', () => {
  const route = read('app/api/wallet/overview/route.ts');
  assert.match(route, /requireCustomerRequest\(request\)/);
  assert.match(route, /requireSessionAccount\(auth\.session\)/);
  assert.match(route, /liveWalletContext\(authority\.orgId\)/);
  assert.doesNotMatch(route, /searchParams|body\.orgId|request\.json/, 'nothing is read from the request but the session');
  assert.match(route, /headers: NO_STORE/, 'a balance is never cached');
});
