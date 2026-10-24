/**
 * The legacy per-person approval path is not in splash_core (decision 3,
 * Sky, 24 Oct 2026).
 *
 * `payment_intent::confirm_with_approval` let one maker and one approver of
 * an account's legacy approver set pay out of the maker's own coin. v2 core
 * closed it per account (a registered wallet) and for everyone (a one-way
 * `legacy_enabled` switch), but kept it in the package. A public function can
 * never be removed from a published package, so a closed path is still code
 * on mainnet that every later reviewer must re-prove closed. The decision is
 * to publish core without it: migration of the per-person passkey wallets is
 * plain signed transfers, which need nothing in core.
 *
 * What goes with it: the legacy create and approve, the approver set and the
 * `PayoutApproval` it mints and consumes, the switch and its event, and the
 * `path` value 3 that `IntentConfirmed` reported for it. `splash_spend` keeps
 * its own, unrelated `approve_payout` and `PayoutApproval` (the owners'
 * second approval under a spending rule).
 *
 * A Move test cannot call a function that does not exist, so this is checked
 * on the source, with comments and strings masked by the Move lexer rules in
 * scripts/move-source.mjs.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { datatypes, functions, modules, moveFiles, readMove } from '../scripts/move-source.mjs';

const CORE = path.join('move', 'splash_core', 'sources');

function core() {
  return moveFiles(CORE).map((file) => {
    const unit = readMove(file);
    return { ...unit, module: modules(unit.code)[0]?.name, fns: functions(unit.code), types: datatypes(unit.code) };
  });
}

const GONE_FUNCTIONS = {
  payment_intent: ['create_payment_intent_for_account', 'approve_payout', 'confirm_with_approval', 'assert_legacy_open', 'path_legacy_approval'],
  business_account: [
    'add_approver',
    'remove_approver',
    'mint_approval',
    'consume_approval',
    'discard_approval',
    'approvers',
    'is_approver',
    'approval_ttl_ms',
    'approval_account',
    'approval_intent',
    'approval_approver',
    'approval_amount',
    'approval_epoch',
    'approval_expires_at_ms',
  ],
  compliance_config: ['disable_legacy', 'admin_disable_legacy', 'assert_legacy_enabled', 'legacy_enabled'],
};

const GONE_TYPES = {
  business_account: ['PayoutApproval', 'PayoutApproved', 'PayoutApprovalConsumed'],
  compliance_config: ['LegacyDisabled'],
};

/** Names that only the legacy path used, anywhere in core's code. */
const GONE_TOKENS = [
  'legacy_enabled',
  'approvers',
  'APPROVAL_TTL_MS',
  'PATH_LEGACY_APPROVAL',
  'E_LEGACY_DISABLED',
  'E_LEGACY_CLOSED',
  'E_APPROVERS_CLOSED',
  'E_NOT_AN_APPROVER',
  'PayoutApproval',
];

test('splash_core still has the v2 paths, so the checks below read real source', () => {
  const units = core();
  const names = new Set(units.flatMap((u) => u.fns.map((f) => `${u.module}::${f.name}`)));
  for (const fn of [
    'payment_intent::confirm_from_business_wallet',
    'payment_intent::confirm_from_business_wallet_balance',
    'payment_intent::confirm_cross_chain_from_business_wallet',
    'payment_intent::settle_from_app',
    'business_account::add_owner',
    'compliance_config::propose_addition',
  ]) {
    assert.ok(names.has(fn), `${fn} is in splash_core`);
  }
});

test('no legacy function is left in splash_core', () => {
  const units = core();
  const left = [];
  for (const [module, gone] of Object.entries(GONE_FUNCTIONS)) {
    const unit = units.find((u) => u.module === module);
    assert.ok(unit, `splash_core has a ${module} module`);
    for (const fn of unit.fns) if (gone.includes(fn.name)) left.push(`${module}::${fn.name}`);
  }
  assert.deepEqual(left, [], `legacy functions still in splash_core:\n  ${left.join('\n  ')}`);
});

test('no legacy type or event is left in splash_core', () => {
  const units = core();
  const left = [];
  for (const [module, gone] of Object.entries(GONE_TYPES)) {
    const unit = units.find((u) => u.module === module);
    for (const t of unit.types) if (gone.includes(t.name)) left.push(`${module}::${t.name}`);
  }
  assert.deepEqual(left, [], `legacy types still in splash_core:\n  ${left.join('\n  ')}`);
});

test('no constant, field or name only the legacy path used is left in splash_core', () => {
  const left = [];
  for (const unit of core()) {
    for (const token of GONE_TOKENS) {
      if (new RegExp(`\\b${token}\\b`).test(unit.code)) left.push(`${path.normalize(unit.file)}: ${token}`);
    }
  }
  assert.deepEqual(left, [], `legacy names still in splash_core code:\n  ${left.join('\n  ')}`);
});

test('IntentConfirmed.path has two values: the business wallet (1) and a settlement app (2)', async () => {
  const { readFile } = await import('node:fs/promises');
  const unit = readMove(path.join(CORE, 'payment_intent.move'));
  const paths = [...unit.code.matchAll(/\bconst\s+(PATH_[A-Z_]+)\s*:\s*u8\s*=\s*(\d+)\s*;/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(paths, [['PATH_BUSINESS_WALLET', 1], ['PATH_SETTLEMENT_APP', 2]]);
  // splash_spend's own approval stays: it is the owners' second approval.
  const spend = await readFile(path.join('move', 'splash_spend', 'sources', 'splash_spend.move'), 'utf8');
  assert.match(spend, /public fun approve_payout\(/);
});
