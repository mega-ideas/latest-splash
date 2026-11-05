/**
 * The hardware 2-of-3 passkey check owed from Phase 0 (docs/mainnet-checks-2026-10.md:
 * "The hardware 2-of-3, through sui-signers.ts, is the first test of Phase 2.1").
 *
 * It cannot be run by an agent: it needs three real authenticators (a phone's
 * platform passkey, a laptop's, a security key). On testnet one approver, Sky,
 * runs it (his decision of 25 Oct): he enrols one authenticator for each of
 * three owner logins of a testnet business and signs one wallet transaction
 * with two of them. The runbook is docs/v2/phase2-business-wallet.md,
 * "Runbook: the hardware 2-of-3". This script is its last step: given what the
 * devices produced, it checks each signature, combines two of them exactly as
 * the server does (lib/server/wallet-signing.ts), verifies the combined
 * signature, and, with --dry-run, asks a TESTNET fullnode to simulate the
 * transaction. It never submits anything and holds no key.
 *
 *   node scripts/wallet-hardware-check.mjs <evidence.json> [--dry-run]
 *
 * evidence.json:
 *   {
 *     "publicKeys": ["<base64 33-byte compressed P-256>", x3, in wallet order],
 *     "threshold": 2,
 *     "transactionBytes": "<base64, exactly as the request served it>",
 *     "signatures": ["<serialized passkey signature>", ...],
 *     "devices": ["iPhone (iCloud Keychain)", "Windows Hello", "YubiKey 5"]
 *   }
 */
import { readFile } from 'node:fs/promises';

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { PasskeyPublicKey } from '@mysten/sui/keypairs/passkey';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { isValidTransactionSignature } from '@mysten/sui/verify';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/wallet-hardware-check.mjs <evidence.json> [--dry-run]');
  process.exit(2);
}
const evidence = JSON.parse(await readFile(file, 'utf8'));
const keys = evidence.publicKeys.map((k) => new PasskeyPublicKey(fromBase64(k)));
const ms = MultiSigPublicKey.fromPublicKeys({ threshold: evidence.threshold ?? 2, publicKeys: keys.map((publicKey) => ({ publicKey, weight: 1 })) });
const bytes = fromBase64(evidence.transactionBytes);

console.log(`wallet      ${ms.toSuiAddress()}  (${ms.getThreshold()} of ${keys.length})`);
console.log(`digest      ${TransactionDataBuilder.getDigestFromBytes(bytes)}`);

let failed = false;
const valid = [];
for (const [i, signature] of evidence.signatures.entries()) {
  let signer = -1;
  for (const [k, key] of keys.entries()) {
    if (await isValidTransactionSignature(bytes, signature, { address: key.toSuiAddress() })) signer = k;
  }
  const ok = signer >= 0;
  console.log(`signature ${i + 1} ${ok ? `valid, member ${signer + 1}${evidence.devices?.[signer] ? ` (${evidence.devices[signer]})` : ''}` : 'NOT a member signing these bytes'}`);
  if (ok) valid.push({ signer, signature });
  else failed = true;
}

valid.sort((a, b) => a.signer - b.signer);
let combined = null;
try {
  combined = ms.combinePartialSignatures(valid.map((v) => v.signature));
  const ok = await ms.verifyTransaction(bytes, combined);
  console.log(`combined    ${ok ? 'valid multisig signature' : 'DOES NOT VERIFY'}`);
  if (!ok) failed = true;
} catch (error) {
  console.log(`combined    could not combine: ${error instanceof Error ? error.message : error}`);
  failed = true;
}

if (flag === '--dry-run') {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
  const result = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true }, doGasSelection: false });
  const success = result.$kind === 'Transaction';
  console.log(`dry run     ${success ? 'would succeed on testnet' : `would fail: ${result.FailedTransaction?.status?.error?.message ?? 'unknown'}`}`);
  if (!success) failed = true;
}

console.log(failed ? '\nCHECK FAILED' : '\nCHECK PASSED: record the devices, the wallet, the digest and this output in the runbook.');
process.exit(failed ? 1 : 0);
