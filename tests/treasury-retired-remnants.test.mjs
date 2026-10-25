import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

/**
 * What the retired custodial Smart Treasury left behind (v2 D9, the 5.7
 * review). Treasury is USDY in the business's own Splash Wallet; the ledger
 * Splash held answers 410 at /api/treasury (CUSTODIAL_TREASURY_LEDGER_ON is
 * false). Three places still spoke for that ledger:
 *
 * - The copilot's fallback card pitched "Smart Treasury (Ondo USDY, T-bill)"
 *   for "Idle Available cash", naming the issuer without the signed-partner
 *   check.
 * - SettlementEngineFlow kept an unused 'treasury' variant: "Withdraw T+1-T+3
 *   to Available", "Approval-gated simulation".
 * - The two treasury crons gated the ledger on the custody phase alone, not on
 *   CUSTODIAL_TREASURY_LEDGER_ON, so turning the custody phase on reopened it.
 */

process.env.CRON_SECRET = 'remnants-test-secret';

// Plain Node resolves the package's file, not Next's extensionless subpath.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(specifier, context);
  },
});

async function source(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

test('the copilot has no Smart Treasury card, whatever the custody phase and execution flag', async () => {
  const copilot = await import('../lib/server/copilot.ts');
  assert.equal(copilot.idleCashSuggestion, undefined, 'the fallback card is gone');
  assert.deepEqual(await copilot.getCopilotSuggestions('org-a', true, true), [], 'custody on, execution on: still nothing');
  const text = await source('lib/server/copilot.ts');
  assert.doesNotMatch(text, /Smart Treasury \(|Ondo/, 'no ledger pitch, no hard-coded issuer name');
});

test('SettlementEngineFlow has no treasury variant', async () => {
  const text = await source('components/dashboard/SettlementEngineFlow.tsx');
  assert.doesNotMatch(text, /'treasury'|treasury:/, 'no treasury variant');
  assert.doesNotMatch(text, /T\+1|Approval-gated simulation|to Available/, 'no ledger copy');
});

for (const cron of ['settle-withdrawals', 'accrue-yield']) {
  test(`the ${cron} cron answers 410 while the custodial ledger is retired, even with the custody phase on`, async () => {
    const prev = { ...process.env };
    process.env.SPLASH_CUSTODY_PACKAGE_ID = '0x' + 'ab'.repeat(32);
    process.env.FEATURE_CUSTODY_PHASE = 'true';
    try {
      const route = await import(`../app/api/cron/${cron}/route.ts`);
      for (const method of ['GET', 'POST']) {
        if (typeof route[method] !== 'function') continue;
        const res = await route[method](new Request(`http://localhost/api/cron/${cron}`, {
          method,
          headers: { authorization: 'Bearer remnants-test-secret', 'content-type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
        }));
        assert.equal(res.status, 410, `${method} is retired`);
      }
      const unauth = await (route.GET ?? route.POST)(new Request(`http://localhost/api/cron/${cron}`, { method: route.GET ? 'GET' : 'POST', body: route.GET ? undefined : '{}' }));
      assert.equal(unauth.status, 401, 'the secret is still checked first');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
      Object.assign(process.env, prev);
    }
    const text = await source(`app/api/cron/${cron}/route.ts`);
    assert.match(text, /CUSTODIAL_TREASURY_LEDGER_ON/, 'reads the retirement switch');
    assert.doesNotMatch(text, /licen[cs]/i, 'cites no licence');
  });
}
