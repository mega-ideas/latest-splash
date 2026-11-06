/**
 * Anchor a travel-rule commitment on Sui.
 *
 *   npm run anchor -- --commitment 0x… --message-id 0x… --src-tx 0x… [--execute]
 *
 * Sui is the audit record in this build. After the escrow on Arc emits
 * `Released`, the same 32-byte commitment is written to Splash's existing
 * `audit_anchor` module on Sui testnet, keyed by the CCIP message that released
 * it. One value, three chains: Sepolia emitted it, Arc released on it, Sui
 * records it.
 *
 * This calls the deployed v2 package — no new Move was written for the event.
 * The AnchorCap is owned by the publisher key, which signs here.
 *
 * Why not a CCIP message to Sui: that lane runs 1.6.0 and has not delivered
 * since 15 April. See CHAINLINK_FEEDBACK.md.
 */
import { readFileSync } from 'node:fs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

/** Splash v2 on Sui testnet. Deployed before this event; unchanged by it. */
const PACKAGE = process.env.SUI_PACKAGE_ID
  ?? '0xdf9ed06f8dc6d9f3e8b0b5fe3a4f7252bb90ddd4f4b5421f0de77b8e26b53adf';
const ANCHOR_CAP = process.env.SUI_ANCHOR_CAP_ID
  ?? '0x29b470aa1f6fb02da0843ea418e8c475e6bc6d622ff38912ba665ea4d83db685';
const CAP_REGISTRY = process.env.SUI_CAP_REGISTRY_ID
  ?? '0x34e2d637616b917e5f7cf34a30f92087e9751200183bba1ff3c711e94fa310d1';
const BUSINESS_ACCOUNT = process.env.SUI_BUSINESS_ACCOUNT_ID
  ?? '0xe466ed9f0dcd2b524499d62869bd4f796645ac760f286a8b59b92e6db1bc58eb';
const KEY_FILE = process.env.SUI_KEY_FILE ?? '/Users/sebastianbelulok/b2b-app-splash/.env.pri';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const commitment = (arg('commitment') ?? '').replace(/^0x/, '').toLowerCase();
const messageId = arg('message-id') ?? '';
const srcTx = arg('src-tx') ?? '';
const EXECUTE = process.argv.includes('--execute');

if (!/^[0-9a-f]{64}$/.test(commitment)) {
  console.error('--commitment must be the 32-byte travel-rule commitment (64 hex chars)');
  process.exit(1);
}
if (!messageId) {
  console.error('--message-id is the CCIP message that released the payment');
  process.exit(1);
}

// What the anchor records: the commitment itself, keyed by the message that
// released it and backed by the transaction that sent it.
const auditHash = commitment;
const anchorId = `ccip:${messageId}`;
const backingBlobId = `ccip-src:${srcTx || 'unknown'}`;

const raw = /^SUI_WALLET_PRIVATE_KEY=(.+)$/m.exec(readFileSync(KEY_FILE, 'utf8'))?.[1]?.trim();
if (!raw) { console.error(`no SUI_WALLET_PRIVATE_KEY in ${KEY_FILE}`); process.exit(1); }
const kp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(raw).secretKey);
const sender = kp.getPublicKey().toSuiAddress();

console.log(`package    ${PACKAGE}`);
console.log(`signer     ${sender}`);
console.log(`auditHash  ${auditHash}`);
console.log(`anchorId   ${anchorId}`);
console.log(`backing    ${backingBlobId}`);

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
});

const tx = new Transaction();
tx.setSender(sender);
tx.setGasBudget(20_000_000);
tx.moveCall({
  target: `${PACKAGE}::audit_anchor::anchor_audit_hash`,
  arguments: [
    tx.object(ANCHOR_CAP),
    tx.object(CAP_REGISTRY),
    tx.pure.string(auditHash),
    tx.pure.string(anchorId),
    tx.pure.string(backingBlobId),
    tx.pure.address(BUSINESS_ACCOUNT),
    tx.object('0x6'),
  ],
});

const bytes = await tx.build({ client });
const dry = await client.core.simulateTransaction({ transaction: bytes });
const status = (dry as any).transaction?.effects?.status ?? (dry as any).Transaction?.status;
console.log('simulate  ', JSON.stringify(status).slice(0, 300));
if (status?.error || status?.success === false) process.exit(1);

if (!EXECUTE) {
  console.log('\nDRY RUN — rerun with --execute to anchor.');
  process.exit(0);
}

const { signature } = await kp.signTransaction(bytes);
const res: any = await client.core.executeTransaction({ transaction: bytes, signatures: [signature] });
const digest = res.Transaction?.digest ?? res.transaction?.digest;
console.log(`\nanchored   ${digest}`);
console.log(`explorer   https://testnet.suivision.xyz/txblock/${digest}`);
