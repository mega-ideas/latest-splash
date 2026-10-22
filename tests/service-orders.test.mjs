/**
 * WS3 — server-pays becomes three signatures by three parties.
 *
 * Before WS3, `createPaymentIntentOnSui` opened an intent with the operator
 * key and `confirmComposedPaymentOnSui` paid it from the operator's own gas
 * coin. The chain saw one address authorise and pay its own payout. Now:
 *
 *   1. buildServiceOrderTx     — the client member's wallet signs, in the browser
 *   2. buildApprovePayoutTx    — a different approver's wallet signs
 *   3. confirmServiceOrderOnSui — the operator signs, paying exactly what was approved
 *
 * These tests pin the three builders to the Move sequence
 * `operator_pays_what_the_client_approved` call for call, pin the abort the
 * old path now meets, and prove the CI guard fails on a planted violation and
 * passes on the real tree.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
/** A file's text with LF line endings, so patterns hold on a CRLF checkout. */
async function source(rel) {
  return (await readFile(new URL(rel, root), 'utf8')).split(/\r?\n/).join('\n');
}

const orders = () => import('../lib/sui/service-orders.ts');
const settlement = () => import('../lib/server/sui-settlement.ts');

const PKG = normalizeSuiAddress('0xc0re');
const POLICY = normalizeSuiAddress('0x9011c7');
const ACCOUNT = normalizeSuiAddress('0xacc0');
const RECIPIENT = normalizeSuiAddress('0xb0b');
const INTENT = normalizeSuiAddress('0x1e7e47');
const APPROVAL = normalizeSuiAddress('0xa99');
const ANCHOR_CAP = normalizeSuiAddress('0xa4c4');
const CAP_REGISTRY = normalizeSuiAddress('0x4e9');
const SUI = '0x2::sui::SUI';
const CLOCK = normalizeSuiAddress('0x6');
const COMMITMENT = Uint8Array.from({ length: 32 }, (_, i) => i);
/** 100 USD in six-decimal minor units, as the Move test pays. */
const AMOUNT = 100_000_000n;

const contract = { packageId: PKG, policyId: POLICY, coinType: SUI };

/** A command's MoveCall, with `module::function` and its resolved arguments. */
function calls(tx) {
  const data = tx.getData();
  const arg = (a) => {
    if (a.$kind === 'Input') {
      const input = data.inputs[a.Input];
      if (input.$kind === 'Pure') return { pure: Buffer.from(input.Pure.bytes, 'base64') };
      return { object: normalizeSuiAddress(input.UnresolvedObject?.objectId ?? input.Object?.SharedObject?.objectId ?? '') };
    }
    if (a.$kind === 'GasCoin') return { gas: true };
    if (a.$kind === 'Result') return { result: a.Result };
    return { result: a.NestedResult[0] };
  };
  return data.commands.map((cmd) => {
    if (cmd.$kind === 'MoveCall') {
      return {
        kind: 'MoveCall',
        target: `${cmd.MoveCall.module}::${cmd.MoveCall.function}`,
        packageId: normalizeSuiAddress(cmd.MoveCall.package),
        typeArguments: cmd.MoveCall.typeArguments,
        args: cmd.MoveCall.arguments.map(arg),
      };
    }
    if (cmd.$kind === 'SplitCoins') {
      return { kind: 'SplitCoins', coin: arg(cmd.SplitCoins.coin), amounts: cmd.SplitCoins.amounts.map(arg) };
    }
    return { kind: cmd.$kind };
  });
}

/* ── The three builders, against the Move sequence ───────────────────── */

test('the Move sequence the builders mirror exists, in this order', async () => {
  const move = await source('move/splash_core/tests/service_order_tests.move');
  const start = move.indexOf('fun operator_pays_what_the_client_approved()');
  assert.ok(start > 0, 'service_order_tests.move defines operator_pays_what_the_client_approved');
  const body = move.slice(start, move.indexOf('\n}\n', start));
  const order = ['open_order(', 'approve(', 'settle_as(&mut scenario, OPERATOR'].map((step) => {
    assert.ok(body.includes(step), `the Move sequence calls ${step}`);
    return body.indexOf(step);
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // And the helpers it calls are the three entry points the builders compose.
  for (const fn of ['payment_intent::create_service_order<SUI>(', 'payment_intent::approve_payout(', 'payment_intent::confirm_with_approval(', 'audit_anchor::anchor(']) {
    assert.ok(move.includes(fn), `service_order_tests.move calls ${fn}`);
  }
});

test('step 1: the client member signs create_service_order on their own account, under the policy', async () => {
  const { buildServiceOrderTx } = await orders();
  const tx = buildServiceOrderTx({
    contract,
    account: ACCOUNT,
    recipient: RECIPIENT,
    amountUsd: AMOUNT,
    targetCurrency: 'php',
    fxRate: 56_000_000n,
    commitment: COMMITMENT,
  });
  const [call, ...rest] = calls(tx);
  assert.equal(rest.length, 0, 'one call: the client signs an order, nothing else');
  assert.equal(call.target, 'payment_intent::create_service_order');
  assert.equal(call.packageId, PKG);
  assert.deepEqual(call.typeArguments, [SUI]);
  assert.equal(call.args.length, 8, 'account, policy, recipient, amount, currency, rate, commitment, clock');
  assert.deepEqual(call.args[0], { object: ACCOUNT });
  assert.deepEqual(call.args[1], { object: POLICY });
  assert.equal(normalizeSuiAddress(bcs.Address.parse(call.args[2].pure)), RECIPIENT);
  assert.equal(BigInt(bcs.u64().parse(call.args[3].pure)), AMOUNT);
  assert.equal(bcs.string().parse(call.args[4].pure), 'PHP');
  assert.equal(BigInt(bcs.u64().parse(call.args[5].pure)), 56_000_000n);
  assert.deepEqual([...bcs.vector(bcs.u8()).parse(call.args[6].pure)], [...COMMITMENT]);
  assert.deepEqual(call.args[7], { object: CLOCK });
  // No coin anywhere: the client's signature spends nothing of Splash's.
  assert.ok(!tx.getData().commands.some((c) => c.$kind === 'SplitCoins' || c.$kind === 'TransferObjects'));
});

test('step 1 refuses what the chain would refuse, before anyone is asked to sign', async () => {
  const { buildServiceOrderTx } = await orders();
  const good = { contract, account: ACCOUNT, recipient: RECIPIENT, amountUsd: AMOUNT, targetCurrency: 'PHP', fxRate: 1n, commitment: COMMITMENT };
  assert.throws(() => buildServiceOrderTx({ ...good, commitment: COMMITMENT.slice(1) }), /32 bytes/);
  assert.throws(() => buildServiceOrderTx({ ...good, amountUsd: 0n }), /amount/i);
  assert.throws(() => buildServiceOrderTx({ ...good, recipient: '0x0' }), /recipient/i);
  assert.throws(() => buildServiceOrderTx({ ...good, contract: { ...contract, policyId: '' } }), /policy/i);
  assert.throws(() => buildServiceOrderTx({ ...good, targetCurrency: ' ' }), /currency/i);
});

test('step 2: a different approver signs approve_payout on the same intent and account', async () => {
  const { buildApprovePayoutTx } = await orders();
  const tx = buildApprovePayoutTx({ packageId: PKG, intentId: INTENT, account: ACCOUNT });
  const [call, ...rest] = calls(tx);
  assert.equal(rest.length, 0);
  assert.equal(call.target, 'payment_intent::approve_payout');
  assert.deepEqual(call.typeArguments, []);
  assert.deepEqual(call.args, [{ object: INTENT }, { object: ACCOUNT }, { object: CLOCK }]);
  assert.ok(!tx.getData().commands.some((c) => c.$kind === 'SplitCoins' || c.$kind === 'TransferObjects'));
});

test('step 3: the operator splits exactly the approved amount, settles with the approval, and anchors the receipt', async () => {
  const { buildConfirmServiceOrderTx } = await settlement();
  const tx = buildConfirmServiceOrderTx({
    packageId: PKG,
    coinType: SUI,
    intentId: INTENT,
    account: ACCOUNT,
    approvalId: APPROVAL,
    amountMinor: AMOUNT,
    anchorCapId: ANCHOR_CAP,
    capRegistryId: CAP_REGISTRY,
    auditHash: 'ciphertext-hash',
    anchorId: 'transfer:t_1',
    backingBlobId: 'walrus-blob',
  });
  const steps = calls(tx);
  assert.deepEqual(
    steps.map((s) => (s.kind === 'MoveCall' ? s.target : s.kind)),
    ['SplitCoins', 'payment_intent::confirm_with_approval', 'audit_anchor::anchor', 'audit_anchor::anchor_audit_hash'],
  );
  const [split, confirm, anchor, auditHash] = steps;
  // Splash's own coin, for the amount the client opened and the approver saw.
  assert.deepEqual(split.coin, { gas: true });
  assert.equal(split.amounts.length, 1);
  assert.equal(BigInt(bcs.u64().parse(split.amounts[0].pure)), AMOUNT);
  assert.deepEqual(confirm.typeArguments, [SUI]);
  assert.deepEqual(confirm.args, [{ object: INTENT }, { object: ACCOUNT }, { object: APPROVAL }, { result: 0 }, { object: CLOCK }]);
  // The hot-potato receipt goes straight into the anchor.
  assert.deepEqual(anchor.args[0], { result: 1 });
  assert.deepEqual(auditHash.args.slice(0, 2), [{ object: ANCHOR_CAP }, { object: CAP_REGISTRY }]);
  assert.ok(!tx.getData().commands.some((c) => c.$kind === 'TransferObjects'), 'the contract pays the recipient; the PTB transfers nothing itself');
});

test('the three builders, run as the Move test runs them, move the same amount end to end', async () => {
  const { buildServiceOrderTx, buildApprovePayoutTx } = await orders();
  const { buildConfirmServiceOrderTx } = await settlement();
  const order = calls(buildServiceOrderTx({ contract, account: ACCOUNT, recipient: RECIPIENT, amountUsd: AMOUNT, targetCurrency: 'PHP', fxRate: 56_000_000n, commitment: COMMITMENT }))[0];
  const approval = calls(buildApprovePayoutTx({ packageId: PKG, intentId: INTENT, account: ACCOUNT }))[0];
  const settle = calls(buildConfirmServiceOrderTx({ packageId: PKG, coinType: SUI, intentId: INTENT, account: ACCOUNT, approvalId: APPROVAL, amountMinor: AMOUNT, anchorCapId: ANCHOR_CAP, capRegistryId: CAP_REGISTRY, auditHash: 'h', anchorId: 'a', backingBlobId: 'b' }));
  assert.equal(BigInt(bcs.u64().parse(order.args[3].pure)), BigInt(bcs.u64().parse(settle[0].amounts[0].pure)));
  // Same account through all three, same intent through the last two.
  assert.deepEqual(order.args[0], approval.args[1]);
  assert.deepEqual(approval.args[1], settle[1].args[1]);
  assert.deepEqual(approval.args[0], settle[1].args[0]);
});

/* ── The old path aborts, and the abort is explained ─────────────────── */

test('once an operator is registered, the server-pays path aborts 421 — 420 is already the bad commitment', async () => {
  const move = await source('move/splash_core/sources/payment_intent.move');
  assert.match(move, /const E_BAD_COMMITMENT: +u64 = 420;/, 'WS5 owns 420');
  assert.match(move, /const E_OPERATOR_NEEDS_SERVICE_ORDER: +u64 = 421;/);
  assert.match(move, /const E_NO_OPERATOR: +u64 = 422;/);
  assert.match(move, /const E_PAYER_CANNOT_APPROVE: +u64 = 423;/);
  // Every creator checks the policy, so none is a server-pays side door.
  for (const fn of ['create_payment_intent', 'create_payment_intent_for_account', 'create', 'create_service_order']) {
    const at = move.search(new RegExp(`public fun ${fn}<T>\\(`));
    assert.ok(at > 0, `${fn} is a public fun`);
    const signature = move.slice(at, move.indexOf(')', at));
    assert.match(signature, /policy: &SettlementPolicy/, `${fn} takes the SettlementPolicy`);
  }

  const { humanizeSuiError } = await settlement();
  const abort = (code, module) => `MoveAbort(MoveLocation { module: ModuleId { address: 0x1, name: Identifier("${module}") }, function: 2, instruction: 9, function_name: Some("create_payment_intent") }, ${code}) in command 0`;
  assert.match(humanizeSuiError(abort(421, 'payment_intent'), ''), /^E_OPERATOR_NEEDS_SERVICE_ORDER/);
  assert.match(humanizeSuiError(abort(422, 'payment_intent'), ''), /^E_NO_OPERATOR/);
  assert.match(humanizeSuiError(abort(423, 'payment_intent'), ''), /^E_PAYER_CANNOT_APPROVE/);
  assert.match(humanizeSuiError(abort(1000, 'settlement_policy'), ''), /^E_INVALID_OPERATOR/);
  assert.match(humanizeSuiError(abort(420, 'payment_intent'), ''), /^E_BAD_COMMITMENT/);
});

test('no server path opens an intent with the operator key any more', async () => {
  const mod = await settlement();
  assert.equal(mod.createPaymentIntentOnSui, undefined, 'createPaymentIntentOnSui is gone');
  assert.equal(mod.confirmComposedPaymentOnSui, undefined, 'its pay-from-gas confirm is gone with it');
  assert.equal(typeof mod.confirmServiceOrderOnSui, 'function');
  const ptb = await source('lib/server/ptb.ts');
  assert.doesNotMatch(ptb, /createPaymentIntentOnSui|confirmComposedPaymentOnSui/);
  const composed = await source('lib/server/composed-payment.ts');
  assert.doesNotMatch(composed, /createPaymentIntentOnSui/);
});

/* ── The window is the contract's ────────────────────────────────────── */

test('the remaining window is read off the intent object, not a constant', async () => {
  const { parseIntentObject, serviceOrderWindow } = await orders();
  const intent = parseIntentObject({
    id: INTENT,
    sender: '0xa11ce',
    payer: '0x0fe7',
    amount_usd: '100000000',
    created_at: '1000',
    expires_at: '301000',
    status: 0,
    account: ACCOUNT,
  });
  assert.equal(intent.expiresAtMs, 301_000);
  assert.equal(intent.createdAtMs, 1_000);
  assert.equal(intent.amountMinor, AMOUNT);
  assert.equal(intent.isServiceOrder, true);
  assert.deepEqual(serviceOrderWindow(intent, 61_000), { remainingMs: 240_000, totalMs: 300_000, expired: false, label: '4:00 left' });
  assert.equal(serviceOrderWindow(intent, 301_000).expired, true);
  assert.equal(serviceOrderWindow(intent, 301_000).label, 'Window closed');
  // A window the contract changes is a window the UI shows changed.
  assert.equal(serviceOrderWindow({ createdAtMs: 0, expiresAtMs: 600_000 }, 0).totalMs, 600_000);

  for (const file of ['lib/sui/service-orders.ts', 'components/service-orders/ServiceOrderSignatures.tsx']) {
    const text = await source(file);
    assert.doesNotMatch(text, /300[_,]?000|5 \* 60 \* 1000|5 minutes/i, `${file} hardcodes the expiry window`);
  }
});

test('who has signed is stated plainly, party by party', async () => {
  const { signatureLedger } = await orders();
  const ledger = signatureLedger({
    maker: { address: '0xa11ce', digest: 'D1' },
    approver: null,
    operator: null,
  });
  assert.deepEqual(ledger.map((p) => [p.role, p.signed]), [['maker', true], ['approver', false], ['operator', false]]);
  assert.match(ledger[0].label, /Signed/);
  assert.match(ledger[1].label, /Waiting/);
  assert.match(ledger[2].label, /Waiting/);
});

/* ── The CI guard ─────────────────────────────────────────────────────── */

function guard(cwd) {
  return spawnSync(process.execPath, [path.join(rootPath, 'scripts/check-operator-paths.mjs'), '--root', cwd], { encoding: 'utf8' });
}

async function plant(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ws3-guard-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

test('the CI guard passes on the real tree', () => {
  const run = guard(rootPath);
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test('the CI guard fails on a server module that opens an intent with the operator signer', async () => {
  for (const target of ['payment_intent::create_payment_intent', 'payment_intent::create', 'payment_intent::create_payment_intent_for_account']) {
    const dir = await plant({
      'lib/server/sneaky.ts': `import { getOperatorKeypair } from './sui-settlement';\nexport function go(tx, pkg) {\n  const signer = getOperatorKeypair();\n  tx.moveCall({ target: \`\${pkg}::${target}\`, arguments: [] });\n  return signer;\n}\n`,
    });
    const run = guard(dir);
    assert.equal(run.status, 1, `${target} was not caught`);
    assert.match(run.stderr, /sneaky\.ts/);
  }
});

test('the CI guard fails on a raw transferObjects of operator coins outside confirmServiceOrderOnSui', async () => {
  const dir = await plant({
    'app/api/payout/route.ts': `import { executeSdkTransaction } from '@/lib/server/sui-settlement';\nexport async function POST(tx, to) {\n  const [coin] = tx.splitCoins(tx.gas, [1]);\n  tx.transferObjects([coin], to);\n  return executeSdkTransaction(tx);\n}\n`,
  });
  const run = guard(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /transferObjects/);
});

test('the CI guard allows a transfer inside confirmServiceOrderOnSui, and a payer moving their own coin', async () => {
  const dir = await plant({
    'lib/server/sui-settlement.ts': `export function getOperatorKeypair() { return null; }\nexport async function confirmServiceOrderOnSui(tx, to) {\n  const [coin] = tx.splitCoins(tx.gas, [1]);\n  tx.transferObjects([coin], to);\n}\n`,
    'lib/server/own-coin.ts': `export function send(tx, sender, coin, to) {\n  tx.setSender(sender);\n  tx.transferObjects([coin], to);\n}\n`,
  });
  const run = guard(dir);
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test('the guard runs under npm run lint', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.match(pkg.scripts.lint, /npm run check:operator/);
  assert.equal(pkg.scripts['check:operator'], 'node scripts/check-operator-paths.mjs');
});
