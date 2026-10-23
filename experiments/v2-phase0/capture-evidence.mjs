#!/usr/bin/env node
/**
 * Records the raw evidence behind docs/mainnet-checks-2026-10.md: every
 * GraphQL query with its full response and the time it was read, to
 * experiments/v2-phase0/reads/*.json. Read-only: it sends no transaction and
 * reads no key file.
 *
 *   node experiments/v2-phase0/capture-evidence.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blake2b } from '@noble/hashes/blake2.js';
import { parseSerializedSignature } from '@mysten/sui/cryptography';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'reads');
mkdirSync(OUT, { recursive: true });
const results = JSON.parse(readFileSync(path.join(HERE, 'testnet-proof-results.json'), 'utf8'));

const ENDPOINT = { mainnet: 'https://graphql.mainnet.sui.io/graphql', testnet: 'https://graphql.testnet.sui.io/graphql' };
async function gql(network, query) {
  const res = await fetch(ENDPOINT[network], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  return { network, endpoint: ENDPOINT[network], readAt: new Date().toISOString(), query, response: await res.json() };
}
const write = (name, data) => writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);

// ── 1. Chain, protocol and feature flags, both networks ─────────────────────
const FLAGS = [
  'enable_allowances', 'enable_accumulators', 'create_root_accumulator_object', 'enable_object_funds_withdraw',
  'check_object_funds_withdraw_in_execution', 'enable_address_balance_gas_payments', 'passkey_auth',
  'accept_passkey_in_multisig', 'accept_zklogin_in_multisig', 'upgraded_multisig_supported',
  'additional_multisig_checks', 'address_aliases', 'enable_gasless',
];
const chains = {};
for (const n of ['mainnet', 'testnet']) {
  chains[n] = await gql(n, '{ chainIdentifier epoch { epochId protocolConfigs { protocolVersion featureFlags { key value } } } package(address:"0x2") { version } }');
}
const flagsOf = (n) => Object.fromEntries(chains[n].response.data.epoch.protocolConfigs.featureFlags.map((f) => [f.key, f.value]));
const fm = flagsOf('mainnet');
const ft = flagsOf('testnet');
const differing = Object.keys({ ...fm, ...ft }).filter((k) => fm[k] !== ft[k]).sort().map((k) => ({ flag: k, mainnet: fm[k] ?? null, testnet: ft[k] ?? null }));
write('01-chains-and-flags', {
  summary: Object.fromEntries(['mainnet', 'testnet'].map((n) => {
    const d = chains[n].response.data;
    return [n, { chainIdentifier: d.chainIdentifier, epoch: d.epoch.epochId, protocolVersion: d.epoch.protocolConfigs.protocolVersion, framework0x2Version: d.package.version, flags: Object.fromEntries(FLAGS.map((k) => [k, flagsOf(n)[k] ?? null])) }];
  })),
  flagsThatDiffer: differing,
  raw: chains,
});

// ── 2. allowance and address-balance functions and structs ──────────────────
const FUNCTIONS = [
  ['allowance', 'new'], ['allowance', 'propose_for_app'], ['allowance', 'issue'], ['allowance', 'balance_spend'],
  ['allowance', 'app_balance_spend'], ['allowance', 'spend_permit'], ['allowance', 'settings_permit'], ['allowance', 'revoke'],
  ['allowance', 'rotate_spender'], ['allowance', 'periodic_rate_limit'], ['allowance', 'monthly_rate_limit'],
  ['balance', 'send_funds'], ['balance', 'redeem_funds'], ['coin', 'redeem_funds'], ['coin', 'send_funds'],
  ['balance', 'withdraw_funds_from_object'], ['funds_accumulator', 'withdrawal_split'], ['address_alias', 'enable'], ['address_alias', 'add'],
];
const fnReads = {};
for (const n of ['mainnet', 'testnet']) {
  fnReads[n] = {};
  for (const [m, f] of FUNCTIONS) {
    fnReads[n][`${m}::${f}`] = await gql(n, `{ package(address:"0x2") { module(name:"${m}") { function(name:"${f}") { visibility isEntry typeParameters { constraints } parameters { repr } return { repr } } } } }`);
  }
  for (const s of ['Allowance', 'AllowanceCap', 'AllowanceProposal', 'AllowanceWithdrawal', 'SpendPermit', 'SettingsPermit', 'RateLimit']) {
    fnReads[n][`allowance::${s} (struct)`] = await gql(n, `{ package(address:"0x2") { module(name:"allowance") { datatype(name:"${s}") { abilities } } } }`);
  }
  // Bytecode identity of the modules the proof used, so testnet stands in for mainnet.
  for (const m of ['allowance', 'balance', 'coin', 'funds_accumulator']) {
    const r = await gql(n, `{ package(address:"0x2") { module(name:"${m}") { bytes } } }`);
    const b = r.response.data?.package?.module?.bytes;
    fnReads[n][`${m} (bytecode sha256)`] = { readAt: r.readAt, sha256: b ? createHash('sha256').update(Buffer.from(b, 'base64')).digest('hex') : null };
  }
}
const sameBytecode = ['allowance', 'balance', 'coin', 'funds_accumulator'].map((m) => ({
  module: m,
  mainnet: fnReads.mainnet[`${m} (bytecode sha256)`].sha256,
  testnet: fnReads.testnet[`${m} (bytecode sha256)`].sha256,
  identical: fnReads.mainnet[`${m} (bytecode sha256)`].sha256 === fnReads.testnet[`${m} (bytecode sha256)`].sha256,
}));
write('02-framework-functions', { bytecodeIdentity: sameBytecode, raw: fnReads });

// ── 3. CCTP V2: every package and state object, both networks ───────────────
const CCTP = {
  mainnet: {
    'MessageTransmitterV2 package': '0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87',
    'TokenMessengerMinterV2 package': '0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830',
    'StablecoinHandler package': '0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf',
    'CctpExtensions package': '0x194c593691aed72b23b967cacad967a93c0b17ff98180d417e91ac503ce3597d',
    'MessageTransmitterV2 state': '0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c',
    'TokenMessengerMinterV2 state': '0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167',
    'StablecoinHandler state': '0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41',
    'USDC Treasury': '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
  },
  testnet: {
    'MessageTransmitterV2 package': '0xe9678cd42a81886e18e21361088071f275105636a4d3751e1d7f255211f73bbe',
    'TokenMessengerMinterV2 package': '0x267d3c0cb776eace2840f27e4d33da9c6d952f9749403f1fe6579f4962ed3c64',
    'StablecoinHandler package': '0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561',
    'CctpExtensions package': '0x3cdb05f9a035c147410f5a9cfe2ccb741f4ab3cd59411e86714ce4b45e2c4d95',
    'MessageTransmitterV2 state': '0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed',
    'TokenMessengerMinterV2 state': '0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0',
    'StablecoinHandler state': '0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32',
    'USDC Treasury': '0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe',
  },
};
const cctp = { source: 'https://developers.circle.com/cctp/references/sui-packages', domain: 8, resolved: {}, raw: {} };
for (const [n, ids] of Object.entries(CCTP)) {
  cctp.resolved[n] = {};
  cctp.raw[n] = {};
  for (const [label, id] of Object.entries(ids)) {
    const r = await gql(n, `{ object(address:"${id}") { owner { __typename } asMovePackage { version modules { nodes { name } } } asMoveObject { contents { type { repr } } } } }`);
    const o = r.response.data?.object;
    cctp.resolved[n][label] = o
      ? (o.asMovePackage ? `package (v${o.asMovePackage.version}, ${o.asMovePackage.modules.nodes.length} modules)` : `${o.owner?.__typename} object ${o.asMoveObject?.contents?.type?.repr ?? ''}`)
      : 'NOT FOUND';
    cctp.raw[n][label] = r;
  }
}
cctp.depositForBurn = await gql('mainnet', `{ package(address:"${CCTP.mainnet['TokenMessengerMinterV2 package']}") { module(name:"deposit_for_burn") { functions { nodes { name visibility isEntry parameters { repr } return { repr } } } datatypes { nodes { name abilities } } } } }`);
write('03-cctp-v2', cctp);

// ── 4. Testnet proof read-back ──────────────────────────────────────────────
const M = results.multisig.address;
const txReads = {};
for (const [step, v] of Object.entries(results.steps)) {
  if (!v?.digest) continue;
  const r = await gql('testnet', `{ transaction(digest:"${v.digest}") { digest sender { address } gasInput { gasSponsor { address } gasBudget gasPrice } signatures { signatureBytes } effects { status timestamp balanceChanges { nodes { owner { address } coinType { repr } amount } } } } }`);
  const t = r.response.data?.transaction;
  const sigs = (t?.signatures ?? []).map((s) => {
    const p = parseSerializedSignature(s.signatureBytes);
    if (p.signatureScheme !== 'MultiSig') return { scheme: p.signatureScheme };
    return {
      scheme: 'MultiSig',
      threshold: p.multisig.multisig_pk.threshold,
      members: p.multisig.multisig_pk.pk_map.map((m) => `${Object.keys(m.pubKey)[0]}:w${m.weight}`),
      signaturesUsed: p.multisig.sigs.map((x) => Object.keys(x)[0]),
      bitmap: p.multisig.bitmap,
    };
  });
  txReads[step] = {
    digest: v.digest,
    status: t?.effects?.status,
    timestamp: t?.effects?.timestamp,
    sender: t?.sender?.address === M ? `multisig ${M}` : t?.sender?.address,
    gasSponsor: t?.gasInput?.gasSponsor?.address,
    gasBudget: t?.gasInput?.gasBudget,
    gasPrice: t?.gasInput?.gasPrice,
    signatures: sigs,
    usdcChanges: (t?.effects?.balanceChanges?.nodes ?? []).filter((b) => b.coinType.repr.includes('::usdc::USDC')).map((b) => ({ owner: b.owner.address, amount: b.amount })),
    raw: r,
  };
}
const objects = {};
for (const [label, id] of [
  ['app allowance (phase0 app)', results.steps.proposeForApp.allowance.id],
  ['app AllowanceCap', results.steps.proposeForApp.cap.id],
  ['staff allowance (phase0 staff)', results.steps.staffAllowance?.allowance?.id],
  ['plain allowance (revoked)', results.steps.allowanceNew.allowance.id],
  ['probe package', results.steps.publish.packageId],
  ['probe UpgradeCap (made immutable)', results.steps.makeImmutable?.upgradeCap],
]) {
  if (!id) continue;
  objects[label] = await gql('testnet', `{ object(address:"${id}") { owner { __typename ... on AddressOwner { address { address } } } asMoveObject { contents { type { repr } json } } asMovePackage { version } } }`);
}
const balances = {};
for (const [label, a] of [['multisig', M], ['staff (should hold no SUI)', results.staffAddress]]) {
  if (!a) continue;
  balances[label] = await gql('testnet', `{ address(address:"${a}") { balances { nodes { coinType { repr } totalBalance addressBalance coinBalance } } } }`);
}
write('04-testnet-proof-readback', { transactions: txReads, objects, balances });

// ── 5. Multisig address, recomputed without the SDK's key encoding ──────────
// Raw compressed P-256 keys (33 bytes) come from the chain's own decoding of a
// multisig signature; the passkey flag 0x06, the layout and the weights are
// written out here by hand.
const anyMultisigSig = Object.values(txReads).find((x) => x.signatures[0]?.scheme === 'MultiSig');
const sigBytes = anyMultisigSig.raw.response.data.transaction.signatures[0].signatureBytes;
const decoded = parseSerializedSignature(sigBytes);
const rawKeys = decoded.multisig.multisig_pk.pk_map.map((m) => Uint8Array.from(Object.values(m.pubKey)[0]));
const layout = [0x03, 2, 0];
for (const k of rawKeys) layout.push(0x06, ...k, 1);
const recomputed = `0x${Buffer.from(blake2b(Uint8Array.from(layout), { dkLen: 32 })).toString('hex')}`;
write('05-multisig-derivation', {
  layout: 'blake2b256( 0x03 || threshold u16 LE (02 00) || for each member: 0x06 (passkey flag) || 33-byte compressed P-256 key || weight u8 (01) )',
  compressedKeysHex: rawKeys.map((k) => Buffer.from(k).toString('hex')),
  recomputedAddress: recomputed,
  multisigAddress: M,
  matches: recomputed === M,
  note: 'The keys are taken from a multisig signature the validators accepted; the address the chain treated as sender is the multisig address.',
});

// ── 6. Sui CLI binary ───────────────────────────────────────────────────────
const exe = path.join(os.homedir(), '.sui-cli', 'mainnet-v1.82.3', 'sui.exe');
write('06-sui-cli', {
  path: '%USERPROFILE%\\.sui-cli\\mainnet-v1.82.3\\sui.exe',
  exists: existsSync(exe),
  suiExeSha256: existsSync(exe) ? createHash('sha256').update(readFileSync(exe)).digest('hex') : null,
  releaseArchive: 'sui-mainnet-v1.82.3-windows-x86_64.tgz',
  releaseArchiveSha256Published: 'd9d7c6887ff44f3ee957b87ab506669bab6aaa638f491cf2a9024ae720edaf8a',
  note: 'The archive was checked against GitHub\'s published digest before unpacking and then deleted; this file records the binary\'s own hash.',
});

console.log('evidence written to', path.relative(process.cwd(), OUT));
console.log('flags that differ between mainnet and testnet:', JSON.stringify(differing));
console.log('bytecode identical:', JSON.stringify(sameBytecode.map((b) => `${b.module}=${b.identical}`)));
console.log('cctp:', JSON.stringify(cctp.resolved, null, 1));
console.log('multisig recomputed without SDK encoding matches:', recomputed === M);
