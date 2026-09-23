#!/usr/bin/env node
/**
 * e2e-testnet — live testnet proof of the gRPC write path.
 *
 * Drives the REAL deployed Splash Move calls through SuiGrpcClient, mirroring
 * the PTBs in lib/server/sui-settlement.ts, to prove the JSON-RPC -> gRPC
 * migration works end-to-end for signing + execution. Testnet SUI is valueless;
 * the configured test recipient is the operator itself, so funds cycle back.
 *
 * Run: node --use-system-ca --experimental-strip-types --env-file=.env.local scripts/e2e-testnet.mjs
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { DOMAIN_TAGS, newSalt, paymentCommitment, toHex } from '../lib/evidence/commitment.ts';

const NETWORK = process.env.SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const BASE_URL = process.env.SUI_RPC_URL || `https://fullnode.${NETWORK}.sui.io:443`;
const client = new SuiGrpcClient({ network: NETWORK, baseUrl: BASE_URL });

const env = (k) => (process.env[k] ?? '').trim();
const PACKAGE = env('SPLASH_PACKAGE_ID');
const ADMIN_CAP = env('SPLASH_ADMIN_CAP_ID');
/** Cap split (spec §5): attestations (peg push, audit anchor, receipts) run on
 *  the hot AnchorCap once it exists; before the fresh publish the deployed
 *  package still expects the AdminCap in that argument slot, so fall back. */
const ANCHOR_CAP = env('SPLASH_ANCHOR_CAP_ID') || ADMIN_CAP;
const PEG_STATE = env('SPLASH_PEG_STATE_ID');
const BUSINESS = env('SPLASH_BUSINESS_ACCOUNT_ID');
const SMART_TREASURY = env('SPLASH_SMART_TREASURY_SUI_ID');
const RECIPIENT = env('SPLASH_TEST_RECIPIENT_ADDRESS') || env('OPERATOR_SUI_ADDRESS');
const CLOCK = '0x6';

function operatorKeypair() {
  const encoded = (env('OPERATOR_SUI_PRIVATE_KEY') || env('SUI_SPONSOR_PRIVATE_KEY'));
  if (!encoded) throw new Error('OPERATOR_SUI_PRIVATE_KEY is required.');
  const { scheme, secretKey } = decodeSuiPrivateKey(encoded);
  return scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(secretKey)
    : Ed25519Keypair.fromSecretKey(secretKey);
}
const signer = operatorKeypair();

const results = [];

async function exec(label, tx) {
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    include: { effects: true, events: true },
  });
  const t = res.Transaction ?? res.FailedTransaction;
  if (res.$kind !== 'Transaction' || !t.status.success) {
    throw new Error(`${label} failed: ${JSON.stringify(t?.status?.error)}`);
  }
  await client.waitForTransaction({ digest: t.digest }).catch(() => {});
  return {
    digest: t.digest,
    events: (t.events ?? []).map((e) => ({ type: e.eventType, data: e.json ?? {} })),
  };
}

function eventBySuffix(events, suffix) {
  return events.find((e) => e.type.endsWith(suffix)) ?? null;
}

// ── Test 1: peg refresh (simplest gRPC write) ────────────────────────────────
async function testPeg() {
  const tx = new Transaction();
  tx.setGasBudget('10000000');
  tx.moveCall({
    target: `${PACKAGE}::peg_monitor::update_peg`,
    arguments: [tx.object(PEG_STATE), tx.object(ANCHOR_CAP), tx.pure.u64(0), tx.pure.u64(0), tx.object(CLOCK)],
  });
  const { digest } = await exec('peg refresh', tx);
  return { flow: 'Peg refresh', ok: true, digest };
}

// ── Test 2: create payment intent (transfer/invoice open) ────────────────────
async function testCreateIntent() {
  // WS5. The chain gets a 32-byte commitment, never the payment. The salt and
  // the payload are written to a plaintext bundle under .tmp/ so this testnet
  // settlement can be checked with scripts/verify-commitment.mjs; a real
  // payment keeps them only inside the Seal bundle.
  const salt = newSalt();
  const payload = {
    sender: signer.toSuiAddress(),
    recipient: RECIPIENT,
    beneficiaryRef: '',
    amount: 20_000_000,
    currency: '0x2::sui::SUI',
    corridor: '',
    targetCurrency: 'PHP',
    fxRateUsdLocal: 56_420_000,
  };
  const commitment = paymentCommitment(payload, salt);

  const tx = new Transaction();
  tx.setGasBudget('30000000');
  tx.moveCall({
    target: `${PACKAGE}::payment_intent::create_payment_intent`,
    arguments: [
      tx.pure.address(RECIPIENT),
      tx.pure.u64(20_000_000), // 0.02 SUI
      tx.pure.string('PHP'),
      tx.pure.u64(56_420_000), // fx scaled 1e6
      tx.pure.vector('u8', Array.from(commitment)),
      tx.object(CLOCK),
    ],
  });
  const { digest, events } = await exec('create payment intent', tx);
  const created = eventBySuffix(events, '::payment_intent::IntentCreated');
  const intentId = typeof created?.data.intent_id === 'string' ? created.data.intent_id : '';
  if (!intentId) throw new Error(`IntentCreated missing intent_id. Digest ${digest}`);
  mkdirSync('.tmp', { recursive: true });
  const bundlePath = '.tmp/e2e-commitment-bundle.json';
  writeFileSync(
    bundlePath,
    JSON.stringify(
      {
        schema: 'splash.settlement-evidence.v2',
        settlement: {
          paymentIntentId: intentId,
          commitment: { tag: DOMAIN_TAGS.payment, commitmentHex: toHex(commitment), saltHex: toHex(salt), payload },
        },
      },
      null,
      2,
    ),
  );
  console.log(
    `  commitment ${toHex(commitment)} — verify with: node --experimental-strip-types scripts/verify-commitment.mjs --bundle ${bundlePath} --digest ${digest} --rpc ${BASE_URL}`,
  );
  return { intentId, digest };
}

// ── Test 3: confirm composed (pay + treasury deposit + audit anchor) ─────────
async function testComposedConfirm(intentId) {
  const paymentMist = 20_000_000;
  const treasuryMist = 1_000_000;
  const auditHash = createHash('sha256').update(`e2e:${intentId}`).digest('hex');
  const anchorId = `transfer:e2e_${Date.now().toString(36)}`;
  const blobId = `DEMO_WALRUS_${auditHash.slice(0, 24)}`;

  const tx = new Transaction();
  tx.setGasBudget('30000000');
  const [paymentCoin] = tx.splitCoins(tx.gas, [paymentMist]);
  // 2026-07-19 package (0xec3b06…): confirm_payment_intent returns the
  // SettleReceipt hot-potato — it must be consumed by audit_anchor::anchor in
  // the same PTB or the transaction aborts.
  const [settleReceipt] = tx.moveCall({
    target: `${PACKAGE}::payment_intent::confirm_payment_intent`,
    arguments: [tx.object(intentId), paymentCoin, tx.object(CLOCK)],
  });
  tx.moveCall({
    target: `${PACKAGE}::audit_anchor::anchor`,
    arguments: [
      settleReceipt,
      tx.pure.vector('u8', Array.from(Buffer.from(auditHash, 'utf8'))),
      tx.pure.vector('u8', Array.from(Buffer.from(blobId, 'utf8'))),
      tx.object(CLOCK),
    ],
  });
  if (SMART_TREASURY) {
    const [treasuryCoin] = tx.splitCoins(tx.gas, [treasuryMist]);
    tx.moveCall({
      target: `${PACKAGE}::smart_treasury::deposit`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [tx.object(SMART_TREASURY), treasuryCoin, tx.object(CLOCK)],
    });
  }
  tx.moveCall({
    target: `${PACKAGE}::audit_anchor::anchor_audit_hash`,
    arguments: [
      tx.object(ANCHOR_CAP),
      tx.pure.string(auditHash),
      tx.pure.string(anchorId),
      tx.pure.string(blobId),
      tx.pure.address(BUSINESS),
      tx.object(CLOCK),
    ],
  });
  const { digest, events } = await exec('confirm composed', tx);
  console.log(`  emitted events: ${events.map((e) => e.type.split('::').slice(-1)[0]).join(', ')}`);
  const paid = eventBySuffix(events, '::payment_intent::IntentConfirmed') ?? eventBySuffix(events, '::payment_intent::IntentSettled');
  const allocated = eventBySuffix(events, '::smart_treasury::TreasuryDeposited') ?? eventBySuffix(events, '::smart_treasury::Deposited');
  const anchored = eventBySuffix(events, '::audit_anchor::AuditAnchored');
  const settlementAnchored = eventBySuffix(events, '::audit_anchor::SettlementAnchored');
  return {
    digest,
    proofEvents: { paid: !!paid, treasuryAllocated: !!allocated, anchored: !!anchored, settlementAnchored: !!settlementAnchored },
  };
}

// ── Test 4: batch payout via SUI-native settle_sui_batch (no DeepBook) ───────
async function testBatch() {
  // The batch TOTAL must clear the DeepBook pool's minSize, or
  // peg_monitor::assert_deepbook_liquidity aborts 304 E_INSUFFICIENT_DEPTH:
  // `get_quote_quantity_out_input_fee` leaves the whole amount unfilled
  // (remaining_base != 0, quote_out == 0) for anything below minSize.
  // SUI_DBUSDC on testnet has minSize = 1 SUI, so keep the total above it.
  const rows = [
    { recipient: RECIPIENT, amount: 700_000_000 }, // 0.7 SUI
    { recipient: RECIPIENT, amount: 600_000_000 }, // 0.6 SUI  → 1.3 SUI total
  ];
  const tx = new Transaction();
  tx.setGasBudget('30000000');
  tx.moveCall({
    target: `${PACKAGE}::peg_monitor::update_peg`,
    arguments: [tx.object(PEG_STATE), tx.object(ANCHOR_CAP), tx.pure.u64(0), tx.pure.u64(0), tx.object(CLOCK)],
  });
  const payments = rows.map((r) =>
    tx.moveCall({
      target: `${PACKAGE}::settlement::new_payment`,
      arguments: [tx.pure.address(r.recipient), tx.pure.u64(r.amount)],
    }),
  );
  const paymentVec = tx.makeMoveVec({ type: `${PACKAGE}::settlement::Payment`, elements: payments });
  // 2026-07-19 package: settle_sui_batch<QuoteAsset> now requires the
  // ComplianceConfig and a DeepBook Pool<SUI, QuoteAsset> for the liquidity guard.
  tx.moveCall({
    target: `${PACKAGE}::settlement::settle_sui_batch`,
    typeArguments: [env('DEEPBOOK_QUOTE_TYPE')],
    arguments: [
      tx.object(ADMIN_CAP),
      tx.object(env('SPLASH_TREASURY_ID')), // SettlementPool<SUI>
      tx.object(BUSINESS),
      tx.object(PEG_STATE),
      tx.object(env('SPLASH_COMPLIANCE_CONFIG_ID')),
      tx.object(env('DEEPBOOK_POOL_ID')),
      paymentVec,
      tx.pure.u64(80), // 0.80% corridor fee
      tx.object(CLOCK),
    ],
  });
  const { digest, events } = await exec('settle sui batch', tx);
  console.log(`  emitted events: ${events.map((e) => e.type.split('::').slice(-1)[0]).join(', ')}`);
  return { digest, rows: rows.length };
}

async function main() {
  console.log(`\n▓▓ Splash live testnet e2e — gRPC write path ▓▓`);
  console.log(`network=${NETWORK} base=${BASE_URL}`);
  const addr = signer.getPublicKey().toSuiAddress();
  const bal = await client.getBalance({ owner: addr, coinType: '0x2::sui::SUI' });
  console.log(`operator=${addr.slice(0, 14)}… balance=${(Number(bal.balance.balance) / 1e9).toFixed(4)} SUI`);
  console.log(`recipient=${RECIPIENT.slice(0, 14)}… (self-cycle)\n`);

  // Config gate for the DeepBook settle_payment path (single transfer UI + batch).
  const deepbookReady = env('DEEPBOOK_POOL_ID') && env('DEEPBOOK_QUOTE_TYPE') && env('SPLASH_COMPLIANCE_CONFIG_ID');

  try {
    results.push(await testPeg());
    console.log(`✔ Peg refresh            ${results.at(-1).digest}`);
  } catch (e) {
    results.push({ flow: 'Peg refresh', ok: false, error: e.message });
    console.log(`x Peg refresh FAILED     ${e.message}`);
  }

  try {
    const { intentId, digest } = await testCreateIntent();
    console.log(`✔ Payment intent (open)  ${digest}`);
    console.log(`  intent=${intentId.slice(0, 18)}…`);
    const confirm = await testComposedConfirm(intentId);
    console.log(`✔ Composed confirm       ${confirm.digest}`);
    console.log(`  proof events: paid=${confirm.proofEvents.paid} treasury=${confirm.proofEvents.treasuryAllocated} anchored=${confirm.proofEvents.anchored} settlementAnchored=${confirm.proofEvents.settlementAnchored}`);
    results.push({ flow: 'Transfer/Invoice (payment_intent)', ok: true, digest, confirmDigest: confirm.digest, proof: confirm.proofEvents });
    results.push({ flow: 'Treasury deposit (in composed tx)', ok: confirm.proofEvents.treasuryAllocated, digest: confirm.digest });
    results.push({ flow: 'Audit anchor (in composed tx)', ok: confirm.proofEvents.anchored, digest: confirm.digest });
  } catch (e) {
    results.push({ flow: 'Transfer/Invoice (payment_intent)', ok: false, error: e.message });
    console.log(`✗ Composed flow FAILED   ${e.message}`);
  }

  // Batch: the new settle_sui_batch<QuoteAsset> needs DeepBook + compliance
  // config, and the SettlementPool must hold funds — skip cleanly when unset.
  if (!deepbookReady) {
    const missing = ['DEEPBOOK_POOL_ID', 'DEEPBOOK_QUOTE_TYPE', 'SPLASH_COMPLIANCE_CONFIG_ID'].filter((k) => !env(k));
    results.push({ flow: 'Batch payout (settle_sui_batch)', ok: 'SKIP', missing });
    console.log(`- Batch payout SKIPPED   needs ${missing.join(', ')}`);
  } else {
    try {
      const batch = await testBatch();
      console.log(`✔ Batch payout (sui)     ${batch.digest}  (${batch.rows} recipients)`);
      results.push({ flow: 'Batch payout (settle_sui_batch)', ok: true, digest: batch.digest });
    } catch (e) {
      results.push({ flow: 'Batch payout (settle_sui_batch)', ok: false, error: e.message });
      console.log(`✗ Batch payout FAILED    ${e.message}`);
    }
  }

  console.log(`\n── summary ──`);
  for (const r of results) {
    const status = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : r.ok;
    console.log(`  [${status}] ${r.flow}${r.digest ? `  ${r.digest}` : ''}${r.error ? `  — ${r.error}` : ''}${r.missing ? `  — needs ${r.missing.join(', ')}` : ''}`);
  }
  const hardFail = results.some((r) => r.ok === false);
  console.log(`\n${hardFail ? '✗ some flows failed' : '✔ all runnable flows passed'}\n`);
  process.exit(hardFail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
