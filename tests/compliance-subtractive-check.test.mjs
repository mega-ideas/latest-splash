/**
 * Regression guard for scripts/check-compliance-subtractive.mjs.
 *
 * That script is what compliance_config.move, tests/compliance_tests.move,
 * SECURITY.md and the key-ceremony runbook point at as the proof that a
 * ComplianceCap can only make settlement controls stricter, and that the
 * v2 registries grow only through the 24-hour path. Its first version
 * matched `&ComplianceCap` and substrings of one function's body. An adversarial
 * review built mutated copies of compliance_config.move with Sui CLI 1.82.3
 * that loosened controls while the check printed "all of them tightening".
 * Each mutation is planted below into a copy of the real sources and must
 * fail the check; the first test requires the real sources to pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHECKER = path.resolve('scripts/check-compliance-subtractive.mjs');
const REAL = path.resolve('move/splash_core/sources');
const MODULE = 'compliance_config.move';

/**
 * Run the checker, from a scratch root, over a copy of splash_core's sources
 * with `edit` applied to compliance_config.move and `extra` written beside it.
 */
function runWith(edit, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'splash-compliance-'));
  try {
    const sources = path.join(root, 'move', 'splash_core', 'sources');
    mkdirSync(sources, { recursive: true });
    cpSync(REAL, sources, { recursive: true });
    const file = path.join(sources, MODULE);
    const before = readFileSync(file, 'utf8');
    const after = edit(before);
    if (edit !== keep) assert.notEqual(after, before, 'the planted edit did not change the source');
    writeFileSync(file, after);
    for (const [relative, contents] of Object.entries(extra)) {
      const full = path.join(sources, relative);
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
const keep = (s) => s;
const plant = (code) => (s) => `${s}\n${code}\n`;

test('the real splash_core passes', () => {
  const r = runWith(keep);
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /ComplianceCap is subtractive/);
});

test('a resume through &mut ComplianceCap is caught', () => {
  const r = runWith(
    plant(`public fun resume_mut(config: &mut ComplianceConfig, cap: &mut ComplianceCap, registry: &CapRegistry) {
    assert_compliance_cap(registry, cap);
    config.paused = false;
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /resume_mut/);
});

test('a resume and a venue added through a by-value ComplianceCap are caught', () => {
  const r = runWith(
    plant(`public fun resume_by_value(config: &mut ComplianceConfig, cap: ComplianceCap, registry: &CapRegistry, pool_id: ID, ctx: &TxContext) {
    assert_compliance_cap(registry, &cap);
    config.paused = false;
    config.allowed_deepbook_pools.insert(pool_id);
    transfer::transfer(cap, ctx.sender());
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /resume_by_value/);
});

test('an allowed function that loosens through a helper is caught', () => {
  const r = runWith((s) =>
    s
      .replace(/(\n[ \t]*config\.paused = true;)(\r?\n)/, '$1$2    set_flag(config);$2')
      .concat(`
fun set_flag(config: &mut ComplianceConfig) {
    config.paused = false;
    config.accepted_assets.insert(std::string::utf8(b"0x2::sui::SUI"));
}
`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /set_flag/);
});

test('a registry insert outside activate_addition, skipping the 24-hour notice, is caught', () => {
  const r = runWith(
    plant(`public fun admin_add_asset_now(_admin: &AdminCap, config: &mut ComplianceConfig, name: String) {
    registry_set_mut(config, REGISTRY_ASSET).insert(name);
    config.settlement_apps.insert(name);
    emit_update(config);
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /admin_add_asset_now/);
});

test('a registry replaced wholesale outside create is caught', () => {
  const r = runWith(
    plant(`public fun admin_replace_apps(_admin: &AdminCap, config: &mut ComplianceConfig, apps: vector<String>) {
    config.settlement_apps = vec_set::from_keys(apps);
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /admin_replace_apps/);
});

test('a ComplianceCap function in a subdirectory of sources/ is read', () => {
  const r = runWith(keep, {
    'extra/loosen.move': `module splash_core::loosen;

use splash_core::compliance_config::{ComplianceCap, ComplianceConfig};

public fun loosen(config: &mut ComplianceConfig, cap: &ComplianceCap) {
    let _ = config;
    let _ = cap;
    sui::event::emit(Loosened {});
}

public struct Loosened has copy, drop {}
`,
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /loosen/);
});

test('a ComplianceCap that gains store, declared with postfix abilities, is caught', () => {
  const r = runWith((s) => s.replace(/public struct ComplianceCap has key \{([\s\S]*?)\}/, 'public struct ComplianceCap {$1} has key, store;'));
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /store/);
});

// Found by the independent check of the hardened script: an expression that
// starts with the allowed literal is not that literal.
test('a pause that writes `true && false` is caught', () => {
  const r = runWith((s) => {
    const edited = s.replace(
      /(public fun pause\(config: &mut ComplianceConfig[^{]*\{[\s\S]*?)config\.paused = true;/,
      '$1config.paused = true && false;',
    );
    assert.notEqual(edited, s, 'the fixture edits the real pause');
    return edited;
  });
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /\bpause\b/);
});

test('a ComplianceCap function that lowers the settlement floor is caught', () => {
  const r = runWith(
    plant(`public fun floor_trick(config: &mut ComplianceConfig, cap: &ComplianceCap, registry: &CapRegistry) {
    assert_compliance_cap(registry, cap);
    config.min_settlement_amount = 0;
    emit_update(config);
}`),
  );
  assert.equal(r.exitCode, 1, r.output);
  assert.match(r.output, /floor_trick/);
  assert.match(r.output, /not an approved subtractive operation/);
});
