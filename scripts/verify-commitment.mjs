#!/usr/bin/env node
/**
 * Verify a settlement's on-chain commitments against its Seal bundle.
 *
 *   node --experimental-strip-types scripts/verify-commitment.mjs \
 *     --bundle <decrypted-bundle.json> \
 *     ( --events <events.json> | --digest <tx digest> [--rpc <fullnode url>] )
 *
 * The bundle is the plaintext of a `splash.settlement-evidence.v2` bundle,
 * i.e. what a party on the Seal policy's allowlist decrypts. The script
 * recomputes blake2b256(tag || bcs(payload) || salt) from the bundle's
 * payload and salt, checks it against the commitment the bundle claims, and
 * then against every payment lifecycle event of the transaction: created,
 * confirmed, canceled, anchored, approved, approval consumed.
 *
 * Exit 0 when every lifecycle event carries that commitment; 1 otherwise, or
 * when there is nothing to verify. The salt is never printed.
 *
 * `--events` takes a JSON array of Sui events (`{ type, parsedJson }`), as the
 * RPC returns them and as tests fixture them. `--digest` fetches them.
 */
import { readFile } from 'node:fs/promises';

import {
  commitmentFromEventField,
  fromHex,
  paymentCommitment,
  receiptCommitment,
  toHex,
} from '../lib/evidence/commitment.ts';

const LIFECYCLE = [
  '::payment_intent::IntentCreated',
  '::payment_intent::IntentConfirmed',
  '::payment_intent::IntentCanceled',
  '::audit_anchor::SettlementAnchored',
  '::business_account::PayoutApproved',
  '::business_account::PayoutApprovalConsumed',
];
const RECEIPT = '::receipt_v2::ReceiptIssued';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`verify-commitment: ${message}`);
  process.exit(1);
}

const bundlePath = arg('--bundle');
const eventsPath = arg('--events');
const digest = arg('--digest');
if (!bundlePath || (!eventsPath && !digest)) {
  fail('usage: --bundle <bundle.json> (--events <events.json> | --digest <tx> [--rpc <url>])');
}

const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
const record = bundle?.settlement?.commitment;
if (!record?.tag || !record?.saltHex || !record?.payload || !record?.commitmentHex) {
  fail('the bundle carries no commitment record (settlement.commitment with tag, saltHex, payload, commitmentHex)');
}

const salt = fromHex(record.saltHex);
const recomputed =
  record.tag === 'splash:receipt:v1' ? receiptCommitment(record.payload, salt) : paymentCommitment(record.payload, salt);
const expectedHex = toHex(recomputed);
if (expectedHex !== record.commitmentHex.replace(/^0x/, '').toLowerCase()) {
  fail(`the bundle's commitment does not recompute from its payload and salt (bundle ${record.commitmentHex}, recomputed ${expectedHex})`);
}
console.log(`bundle   ${record.tag}  ${expectedHex}  recomputes from payload and salt`);

let events;
if (eventsPath) {
  events = JSON.parse(await readFile(eventsPath, 'utf8'));
} else {
  const { SuiClient, getFullnodeUrl } = await import('@mysten/sui/client');
  const client = new SuiClient({ url: arg('--rpc') ?? getFullnodeUrl('testnet') });
  const tx = await client.getTransactionBlock({ digest, options: { showEvents: true } });
  events = tx.events ?? [];
}
if (!Array.isArray(events)) fail('events must be a JSON array');

const wanted = record.tag === 'splash:receipt:v1' ? [RECEIPT] : LIFECYCLE;
const lifecycle = events.filter((e) => typeof e?.type === 'string' && wanted.some((suffix) => e.type.endsWith(suffix)));
if (lifecycle.length === 0) fail('no payment lifecycle event in the transaction; nothing to verify');

const intentId = typeof bundle?.settlement?.paymentIntentId === 'string' ? bundle.settlement.paymentIntentId.toLowerCase() : null;
let verified = 0;
let mismatched = 0;
for (const event of lifecycle) {
  const name = event.type.slice(event.type.lastIndexOf('::') + 2);
  const bytes = commitmentFromEventField(event.parsedJson?.commitment);
  const got = bytes ? toHex(bytes) : '(missing)';
  const eventIntent = typeof event.parsedJson?.intent_id === 'string' ? event.parsedJson.intent_id.toLowerCase() : null;
  const wrongIntent = intentId && eventIntent && eventIntent !== intentId;
  if (got === expectedHex && !wrongIntent) {
    verified += 1;
    console.log(`ok       ${name}  ${got}`);
  } else {
    mismatched += 1;
    console.log(
      wrongIntent
        ? `MISMATCH ${name}  intent ${eventIntent} is not the bundle's ${intentId}`
        : `MISMATCH ${name}  expected ${expectedHex} got ${got}: the event does not match the bundle`,
    );
  }
}

console.log(`${verified} of ${lifecycle.length} events verified`);
process.exit(mismatched === 0 ? 0 : 1);
