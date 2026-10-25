/**
 * Amendment A1 §1 (Sky, 24 Oct 2026): the previous fee design is not in
 * splash_core, and not in splash_spend's intent creation.
 *
 * That design let each intent state a fee rate (`fee_bps`), bounded by a
 * `max_fee_bps` in `compliance_config` under a 2% package ceiling, changed
 * through a 24-hour path inside the compliance config. A1 replaces it fully:
 * intents carry no fee field, the fee is computed on chain from the derived
 * kind and the amount, the ceiling is 100 bps, and the fee configuration lives
 * in its own module (`fee_config`), never in `compliance_config`, whose
 * subtractive-only guard must stay true.
 *
 * Mainnet is a fresh publish and a public function can never be removed after
 * it, so the old design is removed, not left dead. A Move test cannot call a
 * function that does not exist, so this is checked on the source, with
 * comments and strings masked by the Move lexer rules in
 * scripts/move-source.mjs.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { datatypes, functions, modules, moveFiles, parameters, readMove } from '../scripts/move-source.mjs';

const CORE = path.join('move', 'splash_core', 'sources');
const SPEND = path.join('move', 'splash_spend', 'sources');

function units(dir) {
  return moveFiles(dir).map((file) => {
    const unit = readMove(file);
    return { ...unit, module: modules(unit.code)[0]?.name, fns: functions(unit.code), types: datatypes(unit.code) };
  });
}

/** Names only the previous design used, anywhere in core's or splash_spend's code. */
const GONE_TOKENS = [
  'fee_bps',
  'fee_minor',
  'fee_charged_minor',
  'max_fee_bps',
  'fee_cap_minor',
  'fee_address',
  'pending_fee_change',
  'PendingFeeChange',
  'FeeChangeProposed',
  'FeeChangeActivated',
  'FeeChangeCancelled',
  'MAX_FEE_BPS_CEILING',
  'propose_fee_change',
  'activate_fee_change',
  'cancel_fee_change',
  'admin_cancel_fee_change',
  'fee_for',
  'fee_due',
  'fee_of',
  'E_NO_FEE_ADDRESS',
  'E_FEE_CHANGE_PENDING',
  'E_NO_FEE_CHANGE',
  'E_FEE_NOTICE_NOT_RUN',
  'E_FEE_CHANGE_LAPSED',
  'E_FEE_CHANGE_MISMATCH',
  'E_FEE_ADDRESS_SINGLE_SIGNER',
];

/** The intent creates, and the one parameter about fees they may keep: CCTP's own fee ceiling. */
const CREATES = {
  payment_intent: ['create_for_wallet', 'create_cross_chain_for_wallet', 'create_for_app'],
  splash_spend: ['create_intent'],
};
const BRIDGE_FEE = 'bridge_max_fee';

test('the intent creates are still there, so the checks below read real source', () => {
  const all = [...units(CORE), ...units(SPEND)];
  for (const [module, names] of Object.entries(CREATES)) {
    const unit = all.find((u) => u.module === module);
    assert.ok(unit, `a ${module} module exists`);
    for (const name of names) assert.ok(unit.fns.some((f) => f.name === name), `${module}::${name} exists`);
  }
  assert.ok(units(CORE).some((u) => u.module === 'compliance_config'), 'compliance_config exists');
});

test('no intent create takes a fee rate or a fee amount', () => {
  const all = [...units(CORE), ...units(SPEND)];
  const found = [];
  for (const [module, names] of Object.entries(CREATES)) {
    const unit = all.find((u) => u.module === module);
    for (const fn of unit.fns.filter((f) => names.includes(f.name))) {
      for (const p of parameters(fn.params)) {
        if (/fee/i.test(p.name) && p.name !== BRIDGE_FEE) found.push(`${module}::${fn.name}(${p.name}: ${p.type})`);
      }
    }
  }
  assert.deepEqual(found, [], `fee parameters on intent creation:\n  ${found.join('\n  ')}`);
});

test('a PaymentIntent carries no fee field', () => {
  const unit = units(CORE).find((u) => u.module === 'payment_intent');
  const intent = unit.types.find((t) => t.name === 'PaymentIntent');
  assert.ok(intent, 'PaymentIntent is declared');
  const fields = [...intent.body.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/g)].map((m) => m[1]);
  assert.ok(fields.includes('amount_usd'), 'the field scan reads the struct');
  assert.deepEqual(fields.filter((f) => /fee/.test(f) && f !== BRIDGE_FEE), [], 'PaymentIntent fee fields');
});

test('compliance_config holds no fee parameter, fee change path or fee event', () => {
  const unit = units(CORE).find((u) => u.module === 'compliance_config');
  const hits = [...unit.code.matchAll(/\b[A-Za-z_]*(?:fee|Fee|FEE)[A-Za-z_]*\b/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(hits)], [], 'fee names in compliance_config');
});

test('no name only the previous fee design used is left in splash_core or splash_spend', () => {
  const left = [];
  for (const unit of [...units(CORE), ...units(SPEND)]) {
    for (const token of GONE_TOKENS) {
      if (new RegExp(`\\b${token}\\b`).test(unit.code)) left.push(`${path.normalize(unit.file)}: ${token}`);
    }
  }
  assert.deepEqual(left, [], `previous fee design still in the code:\n  ${left.join('\n  ')}`);
});
