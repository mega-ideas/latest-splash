/**
 * v2 Phase 3, Zeke and payout sheets: the old batch path is gone, not hidden.
 *
 * Zeke used to draft a "batch payout" proposal (kind BATCH_PAYOUT) through a
 * model tool, and an approval of it recorded "not executed" because the v1
 * custody route it belonged to was removed. A sheet now goes to the wallet
 * batch flow (tests/zeke-sheet-review.test.mjs), so nothing builds, approves,
 * steps up or routes the old kind any more, and this proves it three ways:
 *
 *   - by search: none of the names that only served it is in the code;
 *   - by behaviour: the tool, the step-up purpose and the executor refuse it;
 *   - by data: proposals of that kind already on file are closed, once, by a
 *     migration, and an old one that still reaches the executor is recorded
 *     as not carried out, never as "re-authorize" or as money moved.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OXWAL_TOOL_REGISTRY, PROPOSE_TOOL_NAMES, executeOxwalTool, classifyZekeIntent, ZEKE_LIMITATION_TEXT, runOxwalAgent } from '../lib/agent/oxwal.ts';
import { PROPOSAL_KINDS } from '../lib/agent/types.ts';
import { migratedDb } from './helpers/store-db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (['node_modules', '.next', '.claude', 'build'].includes(name)) continue;
    const rel = `${dir}/${name}`;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mjs|js|json|css)$/.test(name)) out.push(rel);
  }
  return out;
}

const CODE = ['app', 'components', 'lib', 'scripts', 'config', 'content'].flatMap((d) => walk(d));

test('none of the names that only served the old batch proposal is left in the code', () => {
  const gone = [
    'BATCH_PAYOUT',
    'proposeBatchPayout',
    'batchPayoutSubject',
    'batchPayoutSubstance',
    'batchTargetCurrency',
    'payableBatchRows',
    'BATCH_PAYOUT_RETIRED_REASON',
    'stashBatchDraft',
    'takeBatchDraft',
    'batch-parse',
    'ParsedBatch',
    'draft=1',
  ];
  const found = [];
  for (const file of CODE) {
    const text = read(file);
    for (const name of gone) if (text.includes(name)) found.push(`${file}: ${name}`);
  }
  assert.deepEqual(found, []);
  for (const file of ['lib/batch-parse.ts', 'tests/batch-parse.test.mjs']) assert.throws(() => statSync(join(root, file)), `${file} is removed`);
});

test('what stays on the batch side is the wallet flow: the wallet batch routes, the sheet reader and the review', () => {
  for (const file of ['lib/server/wallet-batches.ts', 'lib/batch/sheet.ts', 'lib/batch/ingest.ts', 'lib/server/zeke-batch-sheet.ts', 'app/api/wallet/batches/route.ts', 'app/api/wallet/batches/review/route.ts', 'app/api/wallet/batches/sheet/route.ts']) {
    assert.ok(statSync(join(root, file)).isFile(), file);
  }
});

test('Zeke has no tool that drafts a batch, and the model is not told it can', async () => {
  assert.ok(!PROPOSE_TOOL_NAMES.some((n) => /batch/i.test(n)));
  assert.ok(!OXWAL_TOOL_REGISTRY.some((t) => /batch/i.test(t.name)));
  await assert.rejects(() => executeOxwalTool('proposeBatchPayout', { orgId: 'demo-business', corridor: 'MY_PH', payouts: [] }), /unknown Zeke tool/);
  assert.ok(!PROPOSAL_KINDS.some((k) => /BATCH/.test(k)), 'the kind is not one a proposal can have');
  assert.deepEqual([...PROPOSAL_KINDS].sort(), ['FX_CONVERT', 'INTERNAL_TRANSFER', 'NETTING_SETTLE', 'PAYMENT', 'TREASURY_ALLOCATE', 'TREASURY_REDEEM', 'X402_PAYMENT']);
});

test('asked for a batch, Zeke points to the sheet and states its limit; it drafts nothing', async () => {
  assert.deepEqual(classifyZekeIntent('Prepare a batch for this month'), { class: 'MONEY_MOVING', action: 'BATCH' });
  const events = [];
  for await (const event of runOxwalAgent({ forceLocal: true, message: 'Prepare a batch for this month', orgId: 'demo-business', sessionKey: 's-sheet' })) events.push(event);
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.ok(text.startsWith(ZEKE_LIMITATION_TEXT.BATCH));
  assert.match(text, /attach|paperclip/i);
  assert.match(text, /recipient, amount and reference/);
  assert.doesNotMatch(text, /name, address, country/);
  assert.ok(!events.some((e) => e.type === 'proposal'), 'no proposal is drafted');
});

test('the step-up code no longer has a batch purpose: not in the type, the gate, the subjects or the request check', () => {
  assert.doesNotMatch(read('lib/server/step-up.ts'), /BATCH/);
  assert.doesNotMatch(read('lib/server/step-up-http.ts'), /BATCH/);
  assert.doesNotMatch(read('lib/server/step-up-subjects.ts'), /batch/i);
  assert.doesNotMatch(read('components/approvals/ApprovalFlow.tsx'), /BATCH/);
  assert.doesNotMatch(read('components/approvals/ApprovalsInbox.tsx'), /BATCH/);
});

test('an approval of an old payout-run proposal that reaches the executor is recorded as not carried out, in plain words, and spends the approval once', async () => {
  const { executeApprovedProposal } = await import('../lib/server/approval-execution.ts');
  const old = { id: 'prop_old_batch', orgId: 'acme', kind: 'BATCH_PAYOUT', status: 'APPROVED', explain: {}, approvals: [] };
  const outcome = await executeApprovedProposal(old, null, { cookie: '', origin: 'http://x.test' });
  assert.equal(outcome.state, 'SKIPPED');
  assert.match(outcome.detail, /no longer|retired|not carried out|not executed/i);
  assert.match(outcome.detail, /Batch payouts/);
  assert.match(outcome.detail, /Nothing was sent/);
  assert.doesNotMatch(outcome.detail, /re-authori[sz]e/i);
  const odd = await executeApprovedProposal({ ...old, id: 'prop_odd', kind: 'SOMETHING_ELSE' }, null, { cookie: '', origin: 'http://x.test' });
  assert.equal(odd.state, 'SKIPPED');
});

test('migration 0072 closes the payout-run proposals still open, once, and leaves every other proposal and every closed one alone', async () => {
  const sql = read('drizzle/0072_retire_batch_payout_proposals.sql');
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  assert.ok(journal.entries.some((e) => e.tag === '0072_retire_batch_payout_proposals'), '0072 is journalled');
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|CASCADE/i, 'nothing is dropped or deleted');
  const { db, client } = await migratedDb();
  const org = 'acme';
  const run = async () => { for (const part of sql.split('--> statement-breakpoint')) if (part.trim()) await client.exec(part.trim()); };
  const ins = (id, kind, status) =>
    client.query(
      `insert into proposals (id, org_id, idempotency_key, kind, status, tier, created_by, explain) values ($1, $2, $3, $4, $5, 'TIER_0_PROPOSE', 'OXWAL', '{}'::jsonb)`,
      [id, org, `k_${id}`, kind, status],
    );
  await ins('p_open_1', 'BATCH_PAYOUT', 'PENDING_APPROVAL');
  await ins('p_open_2', 'BATCH_PAYOUT', 'DRAFTED');
  await ins('p_open_3', 'BATCH_PAYOUT', 'APPROVED');
  await ins('p_done', 'BATCH_PAYOUT', 'ANCHORED');
  await ins('p_pay', 'PAYMENT', 'PENDING_APPROVAL');
  await run();
  await run();
  const rows = (await client.query('select id, status, execution_state from proposals order by id')).rows;
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const id of ['p_open_1', 'p_open_2', 'p_open_3']) assert.equal(by[id].status, 'EXPIRED', id);
  assert.equal(by.p_done.status, 'ANCHORED');
  assert.equal(by.p_pay.status, 'PENDING_APPROVAL');
  void db;
});
