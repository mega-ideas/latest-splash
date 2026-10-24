/**
 * Regression guard for scripts/check-fees.mjs, check:fees (Amendment A1 §4).
 *
 * The guard holds four claims about Splash's fee: (a) the generated Move
 * vector test is what lib/fees/vectors.json makes; (b) FEE_CEILING_BPS is
 * one number, 100, in splash_core, splash_spend and lib/fees/schedule.ts;
 * (c) app/, components/, content/, lib/agent/ and the Send USDC lane type in
 * no fee rate; (d) fee_config has
 * no way to change the fee in force at once but set_discount. Each breach
 * below is planted into a scratch copy of the files the rule reads and must
 * be caught; the allowed cases must pass; and the real repository passes,
 * from `npm run lint`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHECKER = path.resolve('scripts/check-fees.mjs');
const COPIED = [
  'lib/fees/vectors.json',
  'lib/fees/schedule.ts',
  'move/splash_core/sources',
  'move/splash_core/tests/fee_vectors_tests.move',
  'move/splash_spend/sources',
];
const FEE_CONFIG = 'move/splash_core/sources/fee_config.move';

const { checkCeiling, checkFeeConfigSetters, checkFeeRates, checkGeneratedVectors, feeRatesInLine, splashRates } = await import(pathToFileURL(CHECKER).href);

/**
 * A scratch root holding a copy of the files check:fees reads, with each
 * `edits[file]` applied (it must change the file) and each `extra[file]`
 * written. `fn(root)` runs inside it; the root is removed after.
 */
function withRoot({ edits = {}, extra = {}, drop = [] }, fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'splash-fees-'));
  try {
    for (const rel of COPIED) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      cpSync(path.resolve(rel), path.join(root, rel), { recursive: true });
    }
    for (const [rel, edit] of Object.entries(edits)) {
      const file = path.join(root, rel);
      // LF, whatever the checkout wrote: every planted edit is written with
      // \n, and a Windows checkout (core.autocrlf) has \r\n on disk.
      const before = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const after = edit(before);
      assert.notEqual(after, before, `the planted edit did not change ${rel}`);
      writeFileSync(file, after);
    }
    for (const [rel, contents] of Object.entries(extra)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), contents);
    }
    for (const rel of drop) rmSync(path.join(root, rel), { force: true });
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const replace = (from, to) => (s) => {
  assert.ok(s.includes(from), `the source no longer contains ${JSON.stringify(from)}`);
  return s.replace(from, to);
};
const plant = (code) => (s) => `${s}\n${code}\n`;
const caught = (failures, pattern) => {
  assert.ok(failures.length > 0, 'nothing was caught');
  assert.ok(
    failures.some((f) => pattern.test(f)),
    `no failure matches ${pattern}:\n${failures.join('\n')}`,
  );
};

// ─── the real repository, in lint ───────────────────────────────────────────

test('the real repository passes check:fees', () => {
  const out = execFileSync(process.execPath, [CHECKER], { stdio: 'pipe' }).toString();
  assert.match(out, /^check:fees: the Move vector test is up to date; FEE_CEILING_BPS is 100/);
});

test('npm run lint runs check:fees', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['check:fees'], 'node scripts/check-fees.mjs');
  assert.match(pkg.scripts.lint, /(?:^|&&\s*)npm run check:fees\s*&&/);
});

test('each rule passes on an unedited copy', () => {
  withRoot({}, (root) => {
    assert.deepEqual(checkGeneratedVectors(root), []);
    assert.deepEqual(checkCeiling(root), []);
    assert.deepEqual(checkFeeConfigSetters(root), []);
    assert.deepEqual(checkFeeRates(root, []), []);
  });
});

// ─── (a) the generated Move vector test ─────────────────────────────────────

test('(a) a vector changed without regenerating the Move test is caught', () => {
  withRoot({ edits: { 'lib/fees/vectors.json': replace('"expected_fee_minor": "2999999"', '"expected_fee_minor": "3000000"') } }, (root) =>
    caught(checkGeneratedVectors(root), /is not what lib[\\/]fees[\\/]vectors\.json makes/),
  );
});

test('(a) a hand edit to the generated Move test is caught', () => {
  withRoot(
    { edits: { 'move/splash_core/tests/fee_vectors_tests.move': replace('check(4, 4, true, 0, 999_999_999, 2_999_999);', 'check(4, 4, true, 0, 999_999_999, 3_000_000);') } },
    (root) => caught(checkGeneratedVectors(root), /fee_vectors_tests\.move is not what/),
  );
});

test('(a) a missing Move vector test is caught, and only line ends are forgiven', () => {
  withRoot({ drop: ['move/splash_core/tests/fee_vectors_tests.move'] }, (root) => caught(checkGeneratedVectors(root), /does not exist/));
  withRoot({ edits: { 'move/splash_core/tests/fee_vectors_tests.move': (s) => s.replace(/\r?\n/g, '\r\n') } }, (root) =>
    assert.deepEqual(checkGeneratedVectors(root), []),
  );
});

// ─── (b) one ceiling ─────────────────────────────────────────────────────────

test('(b) a ceiling raised in splash_spend alone is caught', () => {
  withRoot({ edits: { 'move/splash_spend/sources/splash_spend.move': replace('const FEE_CEILING_BPS: u64 = 100;', 'const FEE_CEILING_BPS: u64 = 150;') } }, (root) =>
    caught(checkCeiling(root), /FEE_CEILING_BPS differs: 100 in splash_core .*150 in splash_spend/),
  );
});

test('(b) a ceiling changed in the server mirror alone is caught', () => {
  withRoot({ edits: { 'lib/fees/schedule.ts': replace('export const FEE_CEILING_BPS = 100n;', 'export const FEE_CEILING_BPS = 90n;') } }, (root) =>
    caught(checkCeiling(root), /FEE_CEILING_BPS differs: .*90 in lib\/fees\/schedule\.ts/),
  );
});

test('(b) a ceiling raised everywhere at once is caught: A1 fixes it at 100', () => {
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: replace('const FEE_CEILING_BPS: u64 = 100;', 'const FEE_CEILING_BPS: u64 = 200;'),
        'move/splash_spend/sources/splash_spend.move': replace('const FEE_CEILING_BPS: u64 = 100;', 'const FEE_CEILING_BPS: u64 = 200;'),
        'lib/fees/schedule.ts': replace('export const FEE_CEILING_BPS = 100n;', 'export const FEE_CEILING_BPS = 200n;'),
      },
    },
    (root) => {
      const failures = checkCeiling(root);
      assert.ok(!failures.some((f) => /differs/.test(f)), failures.join('\n'));
      caught(failures, /A1 §2\.1 fixes the ceiling at 100 bps/);
    },
  );
});

test('(b) a denominator that differs is caught, since the ceiling is a fraction of it', () => {
  withRoot({ edits: { [FEE_CONFIG]: replace('const BPS_DENOM: u64 = 10_000;', 'const BPS_DENOM: u64 = 1_000;') } }, (root) =>
    caught(checkCeiling(root), /BPS_DENOM differs: 1000 in splash_core/),
  );
});

test('(b) a second ceiling in core is caught; a commented-out one is not a definition', () => {
  withRoot({ extra: { 'move/splash_core/sources/other.move': 'module splash_core::other;\nconst FEE_CEILING_BPS: u64 = 100;\n' } }, (root) =>
    caught(checkCeiling(root), /splash_core defines FEE_CEILING_BPS 2 time\(s\)/),
  );
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: plant('// const FEE_CEILING_BPS: u64 = 500;\n/* const FEE_CEILING_BPS: u64 = 500; */'),
        'lib/fees/schedule.ts': plant('// export const FEE_CEILING_BPS = 500n;'),
      },
    },
    (root) => assert.deepEqual(checkCeiling(root), []),
  );
});

test('(b) a ceiling missing from the mirror is caught', () => {
  withRoot({ edits: { 'lib/fees/schedule.ts': replace('export const FEE_CEILING_BPS = 100n;', 'export const FEE_CEILING = 100n;') } }, (root) =>
    caught(checkCeiling(root), /lib\/fees\/schedule\.ts defines FEE_CEILING_BPS 0 time\(s\)/),
  );
});

// ─── (c) no literal fee rate in app/, components/, content/ ─────────────────

test("(c) Splash's own rates are read from the launch schedule, with the retired 0.70%", () => {
  withRoot({}, (root) => assert.deepEqual([...splashRates(root)].sort((a, b) => Number(a - b)), [2n, 5n, 7n, 10n, 12n, 15n, 20n, 30n, 70n]));
});

test('(c) what counts as a literal fee rate', () => {
  const rates = new Set([2n, 5n, 7n, 10n, 12n, 15n, 20n, 30n, 70n]);
  // Caught: a rate beside fee wording, any rate.
  assert.deepEqual(feeRatesInLine(`{ label: 'Fee to local currency', bank: '3–5%', splash: '0.70%' },`, rates), ['3–5%', '0.70%']);
  assert.deepEqual(feeRatesInLine('<p>Our pricing: 1.25 % on every payout</p>', rates), ['1.25%']);
  assert.deepEqual(feeRatesInLine('const corridorFee = "45 bps";', rates), ['45bps']);
  // Caught: one of Splash's own rates, fee wording or not.
  assert.deepEqual(feeRatesInLine("['0.02%', 'to any Sui wallet (min 0.25 USDC)'],", rates), ['0.02%']);
  assert.deepEqual(feeRatesInLine('title: "15–30 bps cheaper FX",', rates), ['15–30bps']);
  assert.deepEqual(feeRatesInLine("['0.70%', 'to local currency'],", rates), ['0.70%']);
  // Caught: a fraction as a fee multiplier, and a fee-rate field given a number.
  assert.deepEqual(feeRatesInLine('const fee = source * 0.007;', rates), ['*0.007']);
  assert.deepEqual(feeRatesInLine("financialImpact: { amountOut: 1n, currencyOut: 'USD', feeBps: 14 },", rates), ['feeBps=14']);
  assert.deepEqual(feeRatesInLine('"fee_rate": 0.007', rates), ['fee_rate=0.007']);

  // Allowed: a rate that is not Splash's and no fee wording.
  assert.deepEqual(feeRatesInLine('<span>At least (0.5% slippage)</span>', rates), []);
  assert.deepEqual(feeRatesInLine("{ rootMargin: '0px 0px -12% 0px' }", rates), []);
  assert.deepEqual(feeRatesInLine('Send feedback: 70% of teams reply', rates), []);
  // Allowed: a Tailwind value beside a fee label, a fee amount, a rendered rate, a fee-rate field typed but not given a number.
  assert.deepEqual(feeRatesInLine('<div className="w-[60%] h-[2%]">Fee</div>', rates), []);
  assert.deepEqual(feeRatesInLine("note: 'Splash fee: min 0.25 USDC, max 5 USDC'", rates), []);
  assert.deepEqual(feeRatesInLine('<span>Splash fee {formatBps(quote.splashFee.bps)}</span>', rates), []);
  assert.deepEqual(feeRatesInLine('feeBps?: number;', rates), []);
  assert.deepEqual(feeRatesInLine('const ok = feeBps === 5;', rates), []);
});

test('(c) a fee rate typed into app/, components/ or content/ is caught, with its line; lib/fees is not scanned', () => {
  withRoot(
    {
      extra: {
        'components/landing/Pricing.tsx': "export const P = () => (\n  <p>Splash fee: 0.12% to exchanges</p>\n);\n",
        'content/pricing.ts': "export const line = ['0.05%', 'to a bank'];\n",
        'app/demo/data.ts': 'export const demo = { feeBps: 18 };\n',
        'lib/fees/labels.ts': "export const old = 'fee 0.70%';\n",
      },
    },
    (root) => {
      const failures = checkFeeRates(root, []);
      caught(failures, /\(c\) components\/landing\/Pricing\.tsx:2: `0\.12%` is a literal fee rate/);
      caught(failures, /\(c\) content\/pricing\.ts:1: `0\.05%`/);
      caught(failures, /\(c\) app\/demo\/data\.ts:1: `feeBps=18`/);
      assert.equal(failures.length, 3, failures.join('\n'));
    },
  );
});

test("(c) a fee rate typed into Zeke's replies (lib/agent/) or the Send USDC lane is caught", () => {
  // A1 §2.8 names Zeke's reply copy; the desk's lane quotes the WALLET fee.
  // Both were outside the scan, and a 2.00% ceiling and a typed
  // "(0.02%, min 0.05, max 5)" survived there.
  withRoot(
    {
      extra: {
        'lib/agent/oxwal.ts': "export const reply = 'Batches get a blended rate, typically 15-30 bps inside single-transfer pricing, and the 2.00% fee ceiling applies.';\n",
        'lib/agent/tools/pricing.ts': "export const line = ['0.30%', 'to a bank'];\n",
        'lib/payments/stablecoin-lane.ts': "export const terms = 'Audit-anchor fee (0.02%, min 0.05, max 5)';\n",
      },
    },
    (root) => {
      const failures = checkFeeRates(root, []);
      caught(failures, /\(c\) lib\/agent\/oxwal\.ts:1: `15-30bps`/);
      caught(failures, /\(c\) lib\/agent\/oxwal\.ts:1: `2\.00%`/);
      caught(failures, /\(c\) lib\/agent\/tools\/pricing\.ts:1: `0\.30%`/);
      caught(failures, /\(c\) lib\/payments\/stablecoin-lane\.ts:1: `0\.02%`/);
    },
  );
});

test('(c) a rate rendered from the schedule is allowed', () => {
  withRoot(
    {
      extra: {
        'components/landing/Pricing.tsx':
          "import { formatBps } from '@/lib/fees/format';\nexport const P = ({ q }) => <p>Splash fee {formatBps(q.splashFee.bps)} · {q.splashFee.tierLabel}</p>;\n",
      },
    },
    (root) => assert.deepEqual(checkFeeRates(root, []), []),
  );
});

test('(c) the list A1 §2.8 is clearing can only shrink', () => {
  const extra = { 'components/Old.tsx': "const a = 'Fee to local currency 0.70%';\nconst b = 'Fee to local currency 0.70%';\n" };
  const listed = (count) => [{ file: 'components/Old.tsx', rate: '0.70%', count }];
  withRoot({ extra }, (root) => {
    assert.deepEqual(checkFeeRates(root, listed(2)), []);
    caught(checkFeeRates(root, listed(1)), /`0\.70%` is a literal fee rate 2 time\(s\) \(lines 1, 2\); PENDING_2_8 allows 1/);
    caught(checkFeeRates(root, listed(3)), /PENDING_2_8 still lists 3\. Lower or remove its entry/);
    caught(checkFeeRates(root, [...listed(2), { file: 'components/Gone.tsx', rate: '0.70%', count: 1 }]), /components\/Gone\.tsx: `0\.70%` is a literal fee rate 0 time\(s\); PENDING_2_8 still lists 1/);
  });
});

test('(c) without a readable launch schedule the rule fails rather than guess', () => {
  withRoot({ edits: { [FEE_CONFIG]: replace('fun launch_schedules()', 'fun launch_schedules_renamed()') } }, (root) =>
    caught(checkFeeRates(root, []), /Splash's rates cannot be read from fee_config/),
  );
});

// ─── (d) no immediate setter in fee_config but set_discount ─────────────────

test('(d) an immediate fee recipient setter is caught', () => {
  withRoot(
    { edits: { [FEE_CONFIG]: plant('public fun set_fee_recipient(_: &FeeAdminCap, cfg: &mut FeeConfig, r: address) {\n    cfg.fee_recipient = option::some(r);\n}') } },
    (root) => {
      const failures = checkFeeConfigSetters(root);
      caught(failures, /`set_fee_recipient` takes a FeeConfig mutably/);
      caught(failures, /`set_fee_recipient` writes fee_recipient; only `apply_fee_recipient` may/);
    },
  );
});

test('(d) an immediate schedule setter, private and reached through a borrow, is caught', () => {
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: plant(
          'fun overwrite(cfg: &mut FeeConfig, kind: u8, s: Schedule) {\n    let slot = &mut cfg.schedules[kind as u64];\n    *slot = s;\n}',
        ),
      },
    },
    (root) => {
      const failures = checkFeeConfigSetters(root);
      caught(failures, /`overwrite` takes a FeeConfig mutably/);
      caught(failures, /`overwrite` writes schedules; only `apply_schedule` may/);
    },
  );
});

test('(d) set_discount that also writes a schedule is caught', () => {
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: replace(
          '    if (discount_bps > 0) cfg.discounts.add(business, discount_bps);',
          '    if (discount_bps > 0) cfg.discounts.add(business, discount_bps);\n    cfg.schedules.swap(0, 1);',
        ),
      },
    },
    (root) => caught(checkFeeConfigSetters(root), /`set_discount` writes schedules; only `apply_schedule` may/),
  );
});

test('(d) a discount written anywhere but set_discount is caught', () => {
  withRoot(
    { edits: { [FEE_CONFIG]: replace('    cfg.fee_recipient = option::some(recipient);\n    event::emit(FeeRecipientApplied', '    cfg.fee_recipient = option::some(recipient);\n    cfg.discounts.add(object::id_from_address(recipient), 100);\n    event::emit(FeeRecipientApplied') } },
    (root) => caught(checkFeeConfigSetters(root), /`apply_fee_recipient` writes discounts; only `set_discount` may/),
  );
});

test('(d) an apply that does not wait for the eta is caught', () => {
  withRoot(
    { edits: { [FEE_CONFIG]: replace('    assert!(now >= slot.borrow().eta_ms, E_FEE_PROPOSAL_NOT_READY);\n', '') } },
    (root) => caught(checkFeeConfigSetters(root), /`apply_schedule` does not assert E_FEE_PROPOSAL_NOT_READY/),
  );
});

test('(d) an apply that writes before it checks the eta is caught', () => {
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: replace(
          '    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);\n',
          '    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);\n    cfg.fee_recipient = option::some(cfg.pending_recipient.borrow().recipient);\n',
        ),
      },
    },
    (root) => caught(checkFeeConfigSetters(root), /`apply_fee_recipient` writes fee_recipient before it checks the eta/),
  );
});

test('(d) an apply that ignores the seven-day window is caught, so a lapsed proposal cannot apply', () => {
  // The A1 review: apply_schedule and apply_fee_recipient apply a proposal
  // only within [eta, eta + 7 days).
  withRoot({ edits: { [FEE_CONFIG]: replace('    assert!(now < slot.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);\n', '') } }, (root) =>
    caught(checkFeeConfigSetters(root), /`apply_schedule` does not assert E_FEE_PROPOSAL_LAPSED against the proposal's eta_ms \+ FEE_APPLY_WINDOW_MS/),
  );
  withRoot(
    { edits: { [FEE_CONFIG]: replace('    assert!(now < cfg.pending_recipient.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);\n', '') } },
    (root) => caught(checkFeeConfigSetters(root), /`apply_fee_recipient` does not assert E_FEE_PROPOSAL_LAPSED/),
  );
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: replace(
          '    assert!(now < cfg.pending_recipient.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);\n',
          '    cfg.fee_recipient = option::some(cfg.pending_recipient.borrow().recipient);\n    assert!(now < cfg.pending_recipient.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);\n',
        ),
      },
    },
    (root) => caught(checkFeeConfigSetters(root), /`apply_fee_recipient` writes fee_recipient before it checks the window/),
  );
});

test('(d) a no-op window or notice assert is caught: the assert itself must compare the clock with the eta', () => {
  // The A1 review: the rule used to look only for the text
  // `eta_ms + FEE_APPLY_WINDOW_MS` and the code's name somewhere in the body.
  const LAPSE = '    assert!(now < slot.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);';
  const READY = '    assert!(now >= slot.borrow().eta_ms, E_FEE_PROPOSAL_NOT_READY);';
  const lapse = /`apply_schedule` does not assert E_FEE_PROPOSAL_LAPSED/;
  const ready = /`apply_schedule` does not assert E_FEE_PROPOSAL_NOT_READY/;
  withRoot({ edits: { [FEE_CONFIG]: replace(LAPSE, '    assert!(true || now < slot.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);') } }, (root) =>
    caught(checkFeeConfigSetters(root), lapse),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace(LAPSE, '    assert!(now < slot.borrow().eta_ms + FEE_APPLY_WINDOW_MS || true, E_FEE_PROPOSAL_LAPSED);') } }, (root) =>
    caught(checkFeeConfigSetters(root), lapse),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace(LAPSE, '    let _ = now < slot.borrow().eta_ms + FEE_APPLY_WINDOW_MS; let _ = E_FEE_PROPOSAL_LAPSED;') } }, (root) =>
    caught(checkFeeConfigSetters(root), lapse),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace(READY, '    assert!(now >= slot.borrow().eta_ms || true, E_FEE_PROPOSAL_NOT_READY);') } }, (root) =>
    caught(checkFeeConfigSetters(root), ready),
  );
  withRoot(
    { edits: { [FEE_CONFIG]: replace('    assert!(slot.is_some(), E_NO_FEE_PROPOSAL);\n    let now = clock.timestamp_ms();', '    assert!(slot.is_some(), E_NO_FEE_PROPOSAL);\n    let now = 0;') } },
    (root) => caught(checkFeeConfigSetters(root), /`apply_schedule` does not read `now` from the clock/),
  );
});

test('(d) the two withdrawals are allowed: each takes the cap and empties only its own slot', () => {
  withRoot({}, (root) => assert.deepEqual(checkFeeConfigSetters(root), []));
});

test('(d) a withdrawal that writes what is in force, or the other slot, or skips the cap, is caught', () => {
  const CANCEL_RECIPIENT = '    let PendingRecipient { recipient: _, eta_ms } = cfg.pending_recipient.extract();\n';
  withRoot({ edits: { [FEE_CONFIG]: replace(CANCEL_RECIPIENT, `${CANCEL_RECIPIENT}    cfg.fee_recipient = option::none();\n`) } }, (root) =>
    caught(checkFeeConfigSetters(root), /`cancel_fee_recipient_proposal` writes fee_recipient; only `apply_fee_recipient` may/),
  );
  const CANCEL_SCHEDULE = '    let PendingSchedule { schedule: _, eta_ms } = slot.extract();\n';
  withRoot({ edits: { [FEE_CONFIG]: replace(CANCEL_SCHEDULE, `${CANCEL_SCHEDULE}    cfg.pending_recipient = option::none();\n`) } }, (root) =>
    caught(checkFeeConfigSetters(root), /`cancel_schedule_proposal` writes pending_recipient; only propose_fee_recipient, apply_fee_recipient or cancel_fee_recipient_proposal may/),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace(CANCEL_SCHEDULE, `${CANCEL_SCHEDULE}    *&mut cfg.schedules[kind as u64] = schedule_of(cfg, 0);\n`) } }, (root) =>
    caught(checkFeeConfigSetters(root), /`cancel_schedule_proposal` writes schedules; only `apply_schedule` may/),
  );
  withRoot(
    { edits: { [FEE_CONFIG]: replace('public fun cancel_fee_recipient_proposal(_: &FeeAdminCap, cfg: &mut FeeConfig)', 'public fun cancel_fee_recipient_proposal(cfg: &mut FeeConfig)') } },
    (root) => caught(checkFeeConfigSetters(root), /`cancel_fee_recipient_proposal` does not take &FeeAdminCap/),
  );
  withRoot({ edits: { [FEE_CONFIG]: (s) => s.replaceAll('cancel_schedule_proposal', 'drop_schedule_proposal') } }, (root) => {
    const failures = checkFeeConfigSetters(root);
    caught(failures, /fee_config has no `cancel_schedule_proposal`/);
    caught(failures, /`drop_schedule_proposal` takes a FeeConfig mutably/);
  });
});

test('(d) a window longer than seven days, or none, is caught', () => {
  withRoot({ edits: { [FEE_CONFIG]: replace('const FEE_APPLY_WINDOW_MS: u64 = 604_800_000;', 'const FEE_APPLY_WINDOW_MS: u64 = 31_536_000_000;') } }, (root) =>
    caught(checkFeeConfigSetters(root), /FEE_APPLY_WINDOW_MS is 31536000000 ms; a proposal must lapse within seven days/),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace('const FEE_APPLY_WINDOW_MS: u64 = 604_800_000;', 'const FEE_APPLY_WINDOW_MS: u64 = 0;') } }, (root) =>
    caught(checkFeeConfigSetters(root), /FEE_APPLY_WINDOW_MS is 0 ms/),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace('const FEE_APPLY_WINDOW_MS: u64 = 604_800_000;\n', '') } }, (root) =>
    caught(checkFeeConfigSetters(root), /fee_config defines FEE_APPLY_WINDOW_MS 0 time\(s\)/),
  );
});

test('(d) a proposal without the notice, or a notice under 24 hours, is caught', () => {
  withRoot(
    { edits: { [FEE_CONFIG]: replace('    let recipient = multisig::derive_address(&keys, &weights, threshold);\n    assert!(!multisig::is_single_signer(&weights, threshold), E_INVALID_FEE_RECIPIENT);\n    let eta = clock.timestamp_ms() + FEE_NOTICE_MS;', '    let recipient = multisig::derive_address(&keys, &weights, threshold);\n    assert!(!multisig::is_single_signer(&weights, threshold), E_INVALID_FEE_RECIPIENT);\n    let eta = clock.timestamp_ms();') } },
    (root) => caught(checkFeeConfigSetters(root), /`propose_fee_recipient` does not set its eta as `\+ FEE_NOTICE_MS`/),
  );
  withRoot({ edits: { [FEE_CONFIG]: replace('const FEE_NOTICE_MS: u64 = 86_400_000;', 'const FEE_NOTICE_MS: u64 = 0;') } }, (root) =>
    caught(checkFeeConfigSetters(root), /FEE_NOTICE_MS is 0 ms; a schedule or recipient change needs at least 24 hours/),
  );
});

test('(d) an eta shortened after the proposal is caught', () => {
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: replace(
          '    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);\n',
          '    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);\n    cfg.pending_recipient.borrow_mut().eta_ms = 0;\n',
        ),
      },
    },
    (root) => caught(checkFeeConfigSetters(root), /`apply_fee_recipient` assigns an eta_ms/),
  );
});

test('(d) a change that does not take the FeeAdminCap is caught', () => {
  withRoot({ edits: { [FEE_CONFIG]: replace('public fun set_discount(_: &FeeAdminCap, cfg: &mut FeeConfig,', 'public fun set_discount(cfg: &mut FeeConfig,') } }, (root) =>
    caught(checkFeeConfigSetters(root), /`set_discount` does not take &FeeAdminCap/),
  );
});

test('(d) a second FeeConfig, a by-value config and a &mut out are caught', () => {
  withRoot({ edits: { [FEE_CONFIG]: plant('public fun fresh(ctx: &mut TxContext): FeeConfig { new(launch_schedules(), ctx) }') } }, (root) =>
    caught(checkFeeConfigSetters(root), /`fresh` calls `new`; only `init` makes the one FeeConfig/),
  );
  withRoot(
    { edits: { [FEE_CONFIG]: plant('public fun rebuild(cfg: FeeConfig): FeeConfig {\n    let FeeConfig { id, schedules, fee_recipient: _, discounts, pending_schedules, pending_recipient } = cfg;\n    FeeConfig { id, schedules, fee_recipient: option::none(), discounts, pending_schedules, pending_recipient }\n}') } },
    (root) => {
      const failures = checkFeeConfigSetters(root);
      caught(failures, /`rebuild` takes a FeeConfig by value/);
      caught(failures, /`rebuild` builds or unpacks a FeeConfig/);
    },
  );
  withRoot({ edits: { [FEE_CONFIG]: plant('public(package) fun schedules_mut(cfg: &mut FeeConfig): &mut vector<Schedule> { &mut cfg.schedules }') } }, (root) =>
    caught(checkFeeConfigSetters(root), /`schedules_mut` returns `&mut vector<Schedule>`/),
  );
});

test('(d) a `use fun` alias in fee_config is caught', () => {
  withRoot({ edits: { [FEE_CONFIG]: replace('use sui::event;', 'use sui::event;\nuse fun set_discount as FeeConfig.lower;') } }, (root) =>
    caught(checkFeeConfigSetters(root), /`use fun` in fee_config/),
  );
});

test('(d) a test-only setter is allowed: it never publishes', () => {
  withRoot(
    {
      edits: {
        [FEE_CONFIG]: plant(
          '#[test_only]\npublic fun poke_for_testing(cfg: &mut FeeConfig) { cfg.fee_recipient = option::none() }\n\n#[test]\nfun pokes() { }',
        ),
      },
    },
    (root) => assert.deepEqual(checkFeeConfigSetters(root), []),
  );
});

test('(d) only an exact #[test_only] or #[test] exempts a function: an attribute that merely mentions test still publishes', () => {
  // The A1 review: rule (d) skipped any function whose attribute contained
  // the word `test`, so this immediate setter passed under #[ext(test)] and
  // compiled into the published bytecode.
  const setter = (attribute) =>
    plant(`${attribute}\npublic fun set_fee_recipient_now(_: &FeeAdminCap, cfg: &mut FeeConfig, r: address) {\n    cfg.fee_recipient = option::some(r);\n}`);
  for (const attribute of ['#[ext(test)]', '#[ext(test_only)]', '#[allow(unused), ext(test)]', '#[ext(test)]\n#[allow(unused)]']) {
    withRoot({ edits: { [FEE_CONFIG]: setter(attribute) } }, (root) => {
      const failures = checkFeeConfigSetters(root);
      caught(failures, /`set_fee_recipient_now` takes a FeeConfig mutably/);
      caught(failures, /`set_fee_recipient_now` writes fee_recipient; only `apply_fee_recipient` may/);
    });
  }
});

test('(d) the exact test attributes still exempt, alone or in a list', () => {
  const setter = (attribute, name) => `${attribute}\npublic fun ${name}(cfg: &mut FeeConfig) { cfg.fee_recipient = option::none() }`;
  const planted = [
    setter('#[test_only]', 'a_for_testing'),
    setter('#[test_only, allow(unused)]', 'b_for_testing'),
    setter('#[allow(unused)]\n#[test_only]', 'c_for_testing'),
    '#[test]\nfun d() { }',
    "#[test(alice = @0xA)]\nfun e(alice: address) { let _ = alice; }",
    '#[test, expected_failure(abort_code = 1)]\nfun f() { abort 1 }',
  ].join('\n\n');
  withRoot({ edits: { [FEE_CONFIG]: plant(planted) } }, (root) => assert.deepEqual(checkFeeConfigSetters(root), []));
});

test('(d) a renamed change function is caught, so the check is revisited', () => {
  withRoot({ edits: { [FEE_CONFIG]: (s) => s.replaceAll('apply_schedule', 'enact_schedule') } }, (root) => {
    const failures = checkFeeConfigSetters(root);
    caught(failures, /fee_config has no `apply_schedule`/);
    caught(failures, /`enact_schedule` takes a FeeConfig mutably/);
  });
});

test('the scratch copies hold what the rules read', () => {
  for (const rel of COPIED) assert.ok(existsSync(path.resolve(rel)), `${rel} is missing; COPIED in this test is out of date`);
});
