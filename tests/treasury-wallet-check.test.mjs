/**
 * Regression guard for scripts/check-treasury-wallet.mjs (`npm run
 * check:treasury-wallet`, part of `npm run lint`).
 *
 * The 5.7 review found two ways Treasury money could reach a position that is
 * not the business's own wallet: an order that recorded no wallet at all, and
 * the custodial Smart Treasury ledger coming back with the custody phase. The
 * check keeps both closed mechanically. Each mutation below is planted into a
 * copy of the real files and must fail it; the real files must pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHECKER = path.resolve('scripts/check-treasury-wallet.mjs');
const FILES = [
  'lib/server/custodial-treasury.ts',
  'app/api/treasury/route.ts',
  'app/api/treasury/wallet/route.ts',
  'app/api/treasury/wallet/quote/route.ts',
  'app/api/treasury/wallet/orders/route.ts',
  'lib/server/treasury-wallet.ts',
  'lib/server/treasury-wallet-orders.ts',
  'lib/server/approval-execution.ts',
  'lib/server/approval-replay.ts',
  'lib/agent/zeke-lane-guard.ts',
  'drizzle',
];

function runWith(file, edit, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'splash-treasury-wallet-'));
  try {
    for (const f of FILES) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      cpSync(path.resolve(f), path.join(root, f), { recursive: true });
    }
    if (file) {
      const full = path.join(root, file);
      const before = readFileSync(full, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, `the planted edit did not change ${file}`);
      writeFileSync(full, after);
    }
    for (const [relative, contents] of Object.entries(extra)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    try {
      const out = execFileSync(process.execPath, [CHECKER], { cwd: root, stdio: 'pipe' });
      return { exitCode: 0, output: String(out) };
    } catch (error) {
      return { exitCode: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fails(r, pattern) {
  assert.notEqual(r.exitCode, 0, r.output);
  assert.match(r.output, pattern);
}

test('the real files pass', () => {
  const r = runWith(null);
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /Treasury stays in the business wallet/);
});

test('turning the custodial ledger on fails', () => {
  fails(runWith('lib/server/custodial-treasury.ts', (s) => s.replace('= false as boolean;', '= true as boolean;')), /CUSTODIAL_TREASURY_LEDGER_ON/);
  fails(runWith('lib/server/custodial-treasury.ts', (s) => s.replace('= false as boolean;', "= process.env.CUSTODIAL_TREASURY === 'true';")), /CUSTODIAL_TREASURY_LEDGER_ON/);
});

test('a ledger handler that skips the 410 fails', () => {
  fails(runWith('app/api/treasury/route.ts', (s) => s.replace(/  if \(!CUSTODIAL_TREASURY_LEDGER_ON\) return custodialTreasuryRetiredResponse\(\);\r?\n/, '')), /app\/api\/treasury\/route\.ts/);
});

test('an order whose recipient is not its source fails', () => {
  fails(runWith('lib/server/treasury-wallet-orders.ts', (s) => s.replace('recipientAddress: input.walletAddress,', 'recipientAddress: input.recipientAddress,')), /recipient/);
  fails(runWith('lib/server/treasury-wallet.ts', (s) => s.replace('walletAddress: wallet.address,', 'walletAddress: String(body.walletAddress),')), /resolveWallet/);
});

test('a later migration that drops the recipient CHECK fails', () => {
  fails(
    runWith(null, null, { 'drizzle/9999_loosen.sql': 'ALTER TABLE "treasury_wallet_orders" DROP CONSTRAINT "treasury_wallet_orders_recipient_is_source";\n' }),
    /treasury_wallet_orders_recipient_is_source/,
  );
});

test('a Treasury route that reads an address from the request fails', () => {
  fails(runWith('app/api/treasury/wallet/route.ts', (s) => `${s}\nconst asked = new URL('http://x').searchParams.get('address');\n`), /address from the request/);
  fails(runWith('app/api/treasury/wallet/orders/route.ts', (s) => `${s}\nconst r = (body: { recipient: string }) => body.recipient;\n`), /address from the request/);
});

test('an executor that carries out a custodial move, or a replay into the ledger, fails', () => {
  fails(runWith('lib/server/approval-replay.ts', (s) => `${s}\nexport const x = () => import('@/app/api/treasury/route');\n`), /approval-replay/);
  fails(
    runWith('lib/server/approval-execution.ts', (s) => s.replace("return { state: 'SKIPPED', detail: `Approved and recorded, not executed. ${CUSTODIAL_TREASURY_RETIRED_REASON}` };", 'return await executeTreasuryMove(proposal, payload, context);')),
    /approval-execution/,
  );
});

test('a Zeke Treasury answer that lifts with the custody phase fails', () => {
  fails(
    runWith('lib/agent/zeke-lane-guard.ts', (s) => s.replace('  return treasuryRefusalText(process.env);', '  return custodyPhaseEnabled() ? null : treasuryRefusalText(process.env);')),
    /zeke-lane-guard/,
  );
});
