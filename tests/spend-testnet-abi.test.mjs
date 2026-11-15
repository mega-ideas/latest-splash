/**
 * Pre-audit B1: Splash calls nothing the splash_spend package on testnet
 * lacks.
 *
 * B1 added three public functions to `spend_policy`
 * (`policy_threshold_total`, `policy_total_count`, `prune_policy_totals`).
 * They exist only in a package published after B1; the package on testnet
 * (0x59c3…1112, version 1) was published before, and testnet is not being
 * republished now. A transaction that names a function its package does not
 * have fails outright, whatever else is in it, so nothing Splash builds or
 * simulates may name one.
 *
 * `TESTNET_PUBLIC` is every public function of that package's two modules,
 * read from the chain on 15 November 2026. Every `spend_policy::…` and
 * `splash_spend::…` function the app's code names must be among them.
 *
 * When testnet runs a package published from this source, this file has
 * done its work: replace the list with that package's, or delete the file.
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types
 *        --import ./scripts/alias-hook.mjs --test tests/spend-testnet-abi.test.mjs
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const words = (s) => s.trim().split(/\s+/);

/** The public functions of 0x59c3bac8598d7f15799ab7d741fb33f5ca85ac4c55d5325fd24b1aa47a151112, version 1. */
const TESTNET_PUBLIC = {
  spend_policy: words(`
    account add_spender address_registry asset beneficiaries_bound_to beneficiary_count config create_policy
    default_running_window_ms default_second_approval_threshold fee_config generation is_beneficiary_bound_to
    is_executor is_owner is_partner_deposit is_recipient_verified is_spender is_staff max_running_window_ms
    max_spenders min_running_window_ms owners per_payment_max prune_running_totals recipient_count recipient_kind
    remove_beneficiary remove_recipient remove_spender role_executor role_staff running_total running_total_count
    running_window_end_ms running_window_ms running_window_start_ms second_approval_threshold set_limits
    set_running_window spender_count spender_per_payment_max threshold_total verify_beneficiary verify_recipient
    wallet wallet_epoch
  `),
  splash_spend: words(`
    accept allowance_name approval_amount approval_approver approval_intent approval_max_total approval_payer
    approval_policy approval_policy_generation approval_settle_by_ms approve_payout create_intent
    delegate_execution discard_approval pay_intent
  `),
};
/** What pre-audit B1 added. */
const ADDED_BY_B1 = ['policy_threshold_total', 'policy_total_count', 'prune_policy_totals'];

const ROOT = new URL('../', import.meta.url);

async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...(await sourceFiles(`${dir}${e.name}/`)));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(`${dir}${e.name}`);
  }
  return out;
}

/** The source without its comments: what runs. (A `//` straight after a colon is a URL, not a comment.) */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every `module::function` of splash_spend's two modules the code names (types, in capitals, are not functions). */
function named(src) {
  return [...code(src).matchAll(/\b(spend_policy|splash_spend)::([a-z_][a-z0-9_]*)/g)].map((m) => ({ module: m[1], fn: m[2] }));
}

/**
 * The public functions a Move source declares and a publish keeps: one
 * marked `#[test_only]` (the attribute, then any doc comment lines, then the
 * function) is left out of the package.
 */
const publicFns = (move) => [...move.matchAll(/^(#\[test_only\]\s*(?:\/\/\/.*\s*)*)?public fun ([a-z_][a-z0-9_]*)/gm)].filter((m) => !m[1]).map((m) => m[2]);

test('the list is the package before B1: this source adds exactly the three policy-wide functions to it', async () => {
  const policy = publicFns(await readFile(new URL('move/splash_spend/sources/spend_policy.move', ROOT), 'utf8'));
  const spend = publicFns(await readFile(new URL('move/splash_spend/sources/splash_spend.move', ROOT), 'utf8'));
  for (const fn of ADDED_BY_B1) assert.ok(!TESTNET_PUBLIC.spend_policy.includes(fn), `${fn} is not on testnet`);
  assert.deepEqual([...policy].sort(), [...TESTNET_PUBLIC.spend_policy, ...ADDED_BY_B1].sort(), 'spend_policy: testnet, and what B1 added');
  assert.deepEqual([...spend].sort(), [...TESTNET_PUBLIC.splash_spend].sort(), 'splash_spend: B1 added no public function');
});

test('every splash_spend function the app names exists in the package on testnet', async () => {
  const files = (await Promise.all(['lib/', 'app/', 'components/', 'scripts/'].map((d) => sourceFiles(d)))).flat();
  const uses = [];
  for (const f of files) for (const u of named(await readFile(new URL(f, ROOT), 'utf8'))) uses.push({ ...u, file: f });
  const missing = uses.filter((u) => !TESTNET_PUBLIC[u.module].includes(u.fn));
  assert.deepEqual(missing, [], 'a function the package on testnet does not have: a transaction naming it fails there');

  // The scan sees what the builders build: every call Splash makes into splash_spend.
  const built = new Set(uses.filter((u) => u.file === 'lib/server/spend-rules-builders.ts').map((u) => `${u.module}::${u.fn}`));
  for (const target of [
    'spend_policy::create_policy',
    'spend_policy::add_spender',
    'spend_policy::remove_spender',
    'spend_policy::verify_recipient',
    'spend_policy::remove_recipient',
    'spend_policy::verify_beneficiary',
    'spend_policy::remove_beneficiary',
    'spend_policy::set_limits',
    'spend_policy::set_running_window',
    'splash_spend::accept',
    'splash_spend::approve_payout',
    'splash_spend::create_intent',
    'splash_spend::pay_intent',
  ]) {
    assert.ok(built.has(target), `${target} is built in lib/server/spend-rules-builders.ts`);
  }
});

test('the scan would see a call to a function B1 added, and leaves comments alone', () => {
  const src = [
    '/** counted as `spend_policy::policy_threshold_total` counts it */',
    '// spend_policy::prune_policy_totals is for the wallet',
    "const url = 'https://example.test/x'; tx.moveCall({ target: spendFn(chain, 'spend_policy::policy_total_count') });",
    'tx.moveCall({ target: `${pkg}::spend_policy::set_limits` }); // spend_policy::policy_total_count',
    'const type = `${pkg}::splash_spend::PayoutApproval`;',
  ].join('\n');
  assert.deepEqual(named(src), [
    { module: 'spend_policy', fn: 'policy_total_count' },
    { module: 'spend_policy', fn: 'set_limits' },
  ]);
});
