import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { AGENT_ACTOR_ID, AGENT_DISPLAY_NAME } from '../lib/agent/identity.ts';

/**
 * The rename contract (Build Prompt v3.1 §2).
 *
 * 'OXWAL' is not only a name — it is the sentinel two security rules compare
 * against: the maker-checker exemption and the signer rejection. The display
 * name may change freely; the sentinel may not, because proposal rows and
 * approval events already persist it. These tests pin both halves.
 */

test('the persisted actor id is OXWAL, forever', () => {
  // If this assertion is in your way, you are about to silently disable the
  // maker-checker exemption and the signer rejection for every existing
  // record. Add a SECOND actor id if you must — never change this one.
  assert.equal(AGENT_ACTOR_ID, 'OXWAL');
  assert.notEqual(AGENT_DISPLAY_NAME, AGENT_ACTOR_ID, 'display and sentinel must never converge');
});

test('the security rules compare against the constant, not a literal', async () => {
  for (const file of [
    'lib/queue/proposal-state.ts',
    'lib/queue/approval-queue.ts',
    'lib/safety/submit-guard.ts',
    'app/api/proposals/[id]/submit/route.ts',
  ]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /AGENT_ACTOR_ID/, `${file} must read the constant`);
    assert.doesNotMatch(text, /[!=]== 'OXWAL'/, `${file} must not compare a raw literal`);
  }
});

test('the signer rejection still rejects the agent id', async () => {
  const state = await readFile(new URL('../lib/queue/proposal-state.ts', import.meta.url), 'utf8');
  const guard = await readFile(new URL('../lib/safety/submit-guard.ts', import.meta.url), 'utf8');
  assert.match(state, /event\.signedBy === AGENT_ACTOR_ID/);
  assert.match(guard, /input\.signedBy === AGENT_ACTOR_ID/);
});

test('no user-visible surface says the old name', async () => {
  // Identifiers (OxWalComposer, runOxwalAgent, oxwal.ts) deliberately keep
  // their spelling — file moves are churn for a later commit and carry no
  // user-visible name. Display copy spelled "0xWal" must be gone.
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(p);
      } else if (/\.(tsx?|mjs)$/.test(entry.name)) {
        const text = await readFile(p, 'utf8');
        if (text.includes('0xWal')) offenders.push(p);
      }
    }
  }
  for (const root of ['components', 'app', 'content', 'lib']) {
    await walk(new URL(`../${root}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  }
  assert.deepEqual(offenders, [], 'user-visible "0xWal" resurfaced');
});
