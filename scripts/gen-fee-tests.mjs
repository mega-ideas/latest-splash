#!/usr/bin/env node
/**
 * Generate move/splash_core/tests/fee_vectors_tests.move from
 * lib/fees/vectors.json (Amendment A1 §3).
 *
 * The vectors live in one file so the chain and the server are held to the
 * same numbers: this script turns each row into one Move #[test] that calls
 * `address_registry::derive_kind` and `fee_config::splash_fee` exactly as
 * splash_core defines them, on the launch schedule, and
 * tests/fee-schedule.test.mjs runs the same rows through lib/fees/schedule.ts.
 *
 * A row is set up from what it says, nothing else:
 *   - the recipient is a registered business wallet when `kind` is
 *     SPLASH_BUSINESS, and a partner deposit address when `partner` is true
 *     (default: when `kind` is BANK_PAYOUT);
 *   - the payment goes through CCTP when `kind` is CROSS_CHAIN;
 *   - the payer declares `declared` (default: `kind`);
 *   - the business has `discount_bps` off the rate, set through
 *     `set_discount` like any discount.
 * The test asserts the chain derives `kind` and charges `expected_fee_minor`.
 *
 *   node scripts/gen-fee-tests.mjs           write the Move file
 *   node scripts/gen-fee-tests.mjs --check   exit 1 if it is out of date
 *
 * check:fees (scripts/check-fees.mjs) runs the same comparison in npm run lint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VECTORS_PATH = path.join('lib', 'fees', 'vectors.json');
export const GENERATED_PATH = path.join('move', 'splash_core', 'tests', 'fee_vectors_tests.move');

const KINDS = { SPLASH_BUSINESS: 0, WALLET: 1, EXCHANGE: 2, CROSS_CHAIN: 3, BANK_PAYOUT: 4 };
const KIND_ACCESSORS = {
  SPLASH_BUSINESS: 'kind_splash_business',
  WALLET: 'kind_wallet',
  EXCHANGE: 'kind_exchange',
  CROSS_CHAIN: 'kind_cross_chain',
  BANK_PAYOUT: 'kind_bank_payout',
};
const U64_MAX = 18_446_744_073_709_551_615n;
const U16_MAX = 65_535;
const WHOLE = /^(0|[1-9]\d*)$/;

/** `1234567` as `1_234_567`. */
function moveNumber(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/** `BANK 999.999999` as `vector_bank_999_999999`. */
export function testName(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`vector "${name}" has no usable name`);
  return `vector_${slug}`;
}

function u64(row, field) {
  const v = row[field];
  if (typeof v !== 'string' || !WHOLE.test(v) || BigInt(v) > U64_MAX) {
    throw new Error(`vector "${row.name}": ${field} must be a decimal string of a u64, got ${JSON.stringify(v)}`);
  }
  return v;
}

function kindOf(row, field, kinds) {
  const v = row[field];
  if (!Object.values(kinds).includes(v)) throw new Error(`vector "${row.name}": ${field} must be one of ${Object.values(kinds).join(', ')}, got ${JSON.stringify(v)}`);
  return v;
}

/** Every row, checked and with its defaults filled in. Throws on the first bad one. */
export function normalizeVectors(file) {
  const kinds = file?.kinds;
  if (JSON.stringify(kinds) !== JSON.stringify(KINDS)) {
    throw new Error(`${VECTORS_PATH}: kinds must be A1's numbers ${JSON.stringify(KINDS)}, got ${JSON.stringify(kinds)}`);
  }
  if (!Array.isArray(file.vectors) || file.vectors.length === 0) throw new Error(`${VECTORS_PATH}: no vectors`);
  const seen = new Set();
  return file.vectors.map((row) => {
    if (typeof row?.name !== 'string' || !row.name.trim()) throw new Error(`${VECTORS_PATH}: a vector has no name`);
    const fn = testName(row.name);
    if (seen.has(fn)) throw new Error(`${VECTORS_PATH}: two vectors make the test name ${fn}`);
    seen.add(fn);
    const kind = kindOf(row, 'kind', kinds);
    const declared = 'declared' in row ? kindOf(row, 'declared', kinds) : kind;
    if ('partner' in row && typeof row.partner !== 'boolean') throw new Error(`vector "${row.name}": partner must be true or false`);
    const partner = row.partner ?? kind === KINDS.BANK_PAYOUT;
    const discount = row.discount_bps ?? 0;
    if (!Number.isInteger(discount) || discount < 0 || discount > U16_MAX) {
      throw new Error(`vector "${row.name}": discount_bps must be a whole number of basis points (a u16)`);
    }
    return {
      name: row.name,
      fn,
      kind,
      declared,
      partner,
      businessWallet: kind === KINDS.SPLASH_BUSINESS,
      viaCctp: kind === KINDS.CROSS_CHAIN,
      discountBps: discount,
      principalMinor: u64(row, 'principal_minor'),
      expectedFeeMinor: u64(row, 'expected_fee_minor'),
    };
  });
}

/** The Move test file for `file` (the parsed vectors.json), with LF line ends. */
export function renderFeeVectorTests(file) {
  const rows = normalizeVectors(file);
  const kindLines = Object.entries(KINDS).map(
    ([name, n]) => `    assert_eq!(fee_config::${KIND_ACCESSORS[name]}(), ${n});`,
  );
  const tests = rows.map((r) =>
    [
      `/// ${r.name.replace(/\s+/g, ' ')}`,
      `#[test]`,
      `fun ${r.fn}() {`,
      `    check(${r.kind}, ${r.declared}, ${r.partner}, ${r.discountBps}, ${moveNumber(r.principalMinor)}, ${moveNumber(r.expectedFeeMinor)});`,
      `}`,
    ].join('\n'),
  );
  return `${[
    '// GENERATED by scripts/gen-fee-tests.mjs from lib/fees/vectors.json. Do not edit:',
    '// change the vectors and run `node scripts/gen-fee-tests.mjs` (check:fees fails',
    '// until this file matches).',
    '',
    "/// Splash's fee vectors (Amendment A1 §3), one #[test] per row of",
    '/// lib/fees/vectors.json. Each derives the kind with',
    "/// `address_registry::derive_kind` and charges it with `fee_config::splash_fee`",
    '/// on the launch schedule, as the settle paths do. A settle path then also',
    '/// refuses a derived kind that does not fit the declared one',
    '/// (`address_registry::assert_kind_fits`), so the partner-address row, which',
    '/// derives a bank payout from a declared wallet, pins `derive_kind` and',
    '/// `splash_fee`, not a payment that settles. The same rows run through the',
    '/// server mirror in tests/fee-schedule.test.mjs.',
    '#[test_only]',
    'module splash_core::fee_vectors_tests;',
    '',
    'use splash_core::address_registry;',
    'use splash_core::fee_config;',
    'use std::unit_test::assert_eq;',
    '',
    'const FINANCE: address = @0xF1A4CE;',
    'const RECIPIENT: address = @0xC0FFEE;',
    '',
    'fun business(): ID { object::id_from_address(@0xB12) }',
    '',
    '/// Set the recipient up as the row says, derive the kind, and charge it.',
    'fun check(kind: u8, declared: u8, partner: bool, discount_bps: u16, principal: u64, expected_fee: u64) {',
    '    let mut ctx = tx_context::dummy();',
    '    let mut cfg = fee_config::new_for_testing(FINANCE, &mut ctx);',
    '    let mut reg = address_registry::new_for_testing(&mut ctx);',
    '    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);',
    '    let ops = address_registry::ops_cap_for_testing(&mut ctx);',
    '    if (kind == fee_config::kind_splash_business()) address_registry::add_business_wallet_for_testing(&mut reg, RECIPIENT);',
    '    if (partner) address_registry::add_partner_address(&ops, &mut reg, RECIPIENT);',
    '    if (discount_bps > 0) fee_config::set_discount(&cap, &mut cfg, business(), discount_bps);',
    '    let via_cctp = kind == fee_config::kind_cross_chain();',
    '',
    '    let derived = address_registry::derive_kind(&reg, RECIPIENT, declared, via_cctp);',
    '    assert_eq!(derived, kind);',
    '    assert_eq!(fee_config::splash_fee(&cfg, business(), derived, principal), expected_fee);',
    '',
    '    fee_config::destroy_for_testing(cfg);',
    '    address_registry::destroy_for_testing(reg);',
    '    fee_config::destroy_fee_admin_cap_for_testing(cap);',
    '    address_registry::destroy_ops_cap_for_testing(ops);',
    '}',
    '',
    "/// The vectors' kind numbers are core's.",
    '#[test]',
    'fun the_kind_numbers_are_core_s() {',
    ...kindLines,
    '}',
    '',
    tests.join('\n\n'),
  ].join('\n')}\n`;
}

/** The vectors file under `root`, parsed. */
export function readVectors(root = process.cwd()) {
  return JSON.parse(readFileSync(path.join(root, VECTORS_PATH), 'utf8'));
}

/** Whether the committed Move file under `root` is what the vectors make. */
export function generatedIsCurrent(root = process.cwd()) {
  const expected = renderFeeVectorTests(readVectors(root));
  let committed;
  try {
    committed = readFileSync(path.join(root, GENERATED_PATH), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return { current: false, reason: `${GENERATED_PATH} does not exist` };
  }
  return committed === expected
    ? { current: true }
    : { current: false, reason: `${GENERATED_PATH} is not what ${VECTORS_PATH} makes` };
}

function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const r = generatedIsCurrent();
    if (!r.current) {
      console.error(`gen-fee-tests: ${r.reason}. Run \`node scripts/gen-fee-tests.mjs\`.`);
      process.exit(1);
    }
    console.log('gen-fee-tests: the Move vector test is up to date.');
    return;
  }
  const out = renderFeeVectorTests(readVectors());
  writeFileSync(GENERATED_PATH, out);
  console.log(`gen-fee-tests: wrote ${GENERATED_PATH} (${normalizeVectors(readVectors()).length} vectors).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
