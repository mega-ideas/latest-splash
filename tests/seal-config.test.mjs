import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MOVED_TO_FILE,
  assertNoLegacySealEnv,
  getSealConfig,
  parseSealConfigFile,
  resetSealConfigCache,
  sealConfigPath,
} from '../lib/server/seal-config.ts';

/* parseSealConfigFile is pure and getSealConfig takes an env object, so every
   case here is a literal file or a literal environment. SEAL_CONFIG_FILE
   points the loader at a fixture written to a temp dir; nothing on this
   machine leaks in. */

const ID = (n) => '0x' + String(n).padStart(64, '0');

const GOOD = {
  mode: 'decentralized',
  threshold: 2,
  packageId: ID(1),
  policyObjectId: ID(2),
  servers: [
    { objectId: ID(10), aggregatorUrl: 'https://a.example', weight: 1 },
    { objectId: ID(11), aggregatorUrl: 'https://b.example/', weight: 1 },
  ],
};

const fails = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });

test('a valid decentralized committee parses and is configured', () => {
  const c = parseSealConfigFile(GOOD, 'fixture', {});
  assert.equal(c.configured, true);
  assert.equal(c.mode, 'decentralized');
  assert.equal(c.threshold, 2);
  assert.equal(c.serverConfigs.length, 2);
  // trailing slash normalised, exactly as the env-var loader did
  assert.equal(c.serverConfigs[1].aggregatorUrl, 'https://b.example');
  assert.equal(c.approveTarget, `${ID(1)}::allowlist::seal_approve`);
  assert.equal(c.source, 'fixture');
});

test('the twelve checks still run — threshold, duplicates, https, aggregator, ids, mode', () => {
  fails(() => parseSealConfigFile({ ...GOOD, threshold: 3 }, 'f', {}), /threshold 3 is not satisfiable by configured weight 2/);
  fails(() => parseSealConfigFile({ ...GOOD, servers: [GOOD.servers[0], { ...GOOD.servers[0] }] }, 'f', {}), /Duplicate Seal key-server object ID/);
  fails(() => parseSealConfigFile({ ...GOOD, servers: [{ ...GOOD.servers[0], aggregatorUrl: 'http://a.example' }] }, 'f', {}), /must use HTTPS/);
  fails(() => parseSealConfigFile({ ...GOOD, servers: [{ objectId: ID(10), weight: 1 }] }, 'f', {}), /requires an aggregatorUrl/);
  fails(() => parseSealConfigFile({ ...GOOD, servers: [{ ...GOOD.servers[0], objectId: '0x12' }] }, 'f', {}), /Invalid Seal key-server object ID/);
  fails(() => parseSealConfigFile({ ...GOOD, servers: [{ ...GOOD.servers[0], weight: 0 }] }, 'f', {}), /weight .* must be a positive integer/);
  fails(() => parseSealConfigFile({ ...GOOD, packageId: 'nope' }, 'f', {}), /packageId must be a canonical Sui package ID/);
  fails(() => parseSealConfigFile({ ...GOOD, mode: 'sideways' }, 'f', {}), /mode must be decentralized or independent/);
});

test('independent mode does not require an aggregator', () => {
  const c = parseSealConfigFile({ ...GOOD, mode: 'independent', threshold: 1, servers: [{ objectId: ID(10), weight: 1 }] }, 'f', {});
  assert.equal(c.configured, true);
});

test('an empty server list is unconfigured, not an error — the development posture', () => {
  const c = parseSealConfigFile({ mode: 'decentralized', threshold: 1, servers: [] }, 'f', {});
  assert.equal(c.configured, false);
  assert.equal(c.serverConfigs.length, 0);
});

test('a moved key still set in the environment is refused and named', () => {
  for (const key of MOVED_TO_FILE) {
    fails(() => assertNoLegacySealEnv({ [key]: 'x' }), new RegExp(`${key}.*moved to config/seal`));
  }
  assert.doesNotThrow(() => assertNoLegacySealEnv({ SEAL_HEALTH_TIMEOUT_MS: '5000', SEAL_ALERT_WEBHOOK_URL: 'https://x' }));
  // blank means unset, as .env.example ships it
  assert.doesNotThrow(() => assertNoLegacySealEnv({ SEAL_THRESHOLD: '' }));
});

test('the file is selected by NODE_ENV, and SEAL_CONFIG_FILE overrides it', () => {
  assert.match(sealConfigPath({ NODE_ENV: 'production' }), /config[\\/]seal\.production\.json$/);
  assert.match(sealConfigPath({ NODE_ENV: 'test' }), /config[\\/]seal\.test\.json$/);
  assert.match(sealConfigPath({}), /config[\\/]seal\.development\.json$/);
  assert.match(sealConfigPath({ SEAL_CONFIG_FILE: 'x/y.json' }), /x[\\/]y\.json$/);
});

test('getSealConfig reads a real file via SEAL_CONFIG_FILE and memoises it', () => {
  resetSealConfigCache();
  const dir = mkdtempSync(join(tmpdir(), 'seal-'));
  const file = join(dir, 'seal.json');
  writeFileSync(file, JSON.stringify(GOOD));
  const env = { NODE_ENV: 'test', SEAL_CONFIG_FILE: file };
  const a = getSealConfig(env);
  assert.equal(a.configured, true);
  assert.equal(a.threshold, 2);
  writeFileSync(file, JSON.stringify({ ...GOOD, threshold: 1 }));
  assert.equal(getSealConfig(env).threshold, 2, 'memoised per path');
  resetSealConfigCache();
  assert.equal(getSealConfig(env).threshold, 1, 'reset re-reads');
});

test('a malformed file is named, with the reason', () => {
  resetSealConfigCache();
  const dir = mkdtempSync(join(tmpdir(), 'seal-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{ not json');
  fails(() => getSealConfig({ NODE_ENV: 'test', SEAL_CONFIG_FILE: file }), /is not valid JSON/);
  writeFileSync(file, '[]');
  resetSealConfigCache();
  fails(() => getSealConfig({ NODE_ENV: 'test', SEAL_CONFIG_FILE: file }), /must be a JSON object/);
});

test('production with no file refuses to start and names the file; development does not', () => {
  resetSealConfigCache();
  const missing = join(mkdtempSync(join(tmpdir(), 'seal-')), 'absent.json');
  fails(() => getSealConfig({ NODE_ENV: 'production', SEAL_CONFIG_FILE: missing }), /does not exist\. Production refuses to start/);
  resetSealConfigCache();
  const dev = getSealConfig({ NODE_ENV: 'development', SEAL_CONFIG_FILE: missing });
  assert.equal(dev.configured, false);
  assert.match(dev.source, /\(absent\)$/);
});

test('the committed development and test files load and are unconfigured', () => {
  resetSealConfigCache();
  for (const NODE_ENV of ['development', 'test']) {
    const c = getSealConfig({ NODE_ENV });
    assert.equal(c.configured, false, `${NODE_ENV} should be unconfigured`);
    assert.equal(c.threshold, 1);
    assert.match(c.source, new RegExp(`seal\\.${NODE_ENV}\\.json$`));
  }
});

test('the build traces the committed Seal files, not the whole project', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/server/seal-config.ts', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export function sealConfigPath('), source.indexOf('function readFile('));
  // Without the comment Turbopack traced the whole project, public/ included, into the server output.
  assert.match(fn, /path\.resolve\(\/\*turbopackIgnore: true\*\/ process\.cwd\(\), override\)/);
  const loader = source.slice(source.indexOf('function readFile('));
  assert.match(loader, /readFileSync\(\/\*turbopackIgnore: true\*\/ file, 'utf8'\)/);
  assert.match(loader, /existsSync\(\/\*turbopackIgnore: true\*\/ file\)/);
  // So the committed files are included explicitly, or production ships without its Seal committee.
  const config = await readFile(new URL('../next.config.ts', import.meta.url), 'utf8');
  assert.match(config, /outputFileTracingIncludes: \{\s*'\/\*': \['\.\/config\/seal\.\*\.json'\]/);
});
