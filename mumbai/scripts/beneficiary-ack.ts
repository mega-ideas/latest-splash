/**
 * The beneficiary institution's service.
 *
 *   npm run ack -- --payment A [--execute]
 *
 * This is what a beneficiary VASP actually runs. It holds the travel-rule
 * record and its salt — which Splash sent offchain, and which never touch any
 * chain — recomputes the commitment itself, and only then acknowledges.
 *
 * That recomputation is the whole point. The beneficiary is not signing a hash
 * somebody handed it; it is proving it holds the record that hashes to the
 * value the escrow is waiting for. An institution that never received the
 * record cannot produce the value, so it cannot release the money.
 *
 * Steps: recompute → acknowledge on Sepolia → poll CCIP → anchor on Sui.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { travelRuleCommitment, fromHex, toHex, type TravelRuleRecord } from '../lib/travel-rule-commitment.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const which = (arg('payment') ?? 'A').toUpperCase();
const EXECUTE = process.argv.includes('--execute');

const SENDER = (process.env.ACK_SENDER ?? '') as Hex;
const RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const PK = (process.env.PK ?? '') as Hex;

const ABI = parseAbi([
  'function acknowledge(bytes32 paymentRef, bytes32 travelRuleCommitment, bytes32 ackHash) payable returns (bytes32)',
  'function getFee(bytes32 paymentRef, address vasp, bytes32 travelRuleCommitment, bytes32 ackHash) view returns (uint256)',
  'function allowedVasp(address) view returns (bool)',
  'event AckSent(bytes32 indexed messageId, bytes32 indexed paymentRef, address indexed vasp, bytes32 travelRuleCommitment, bytes32 ackHash, uint256 fee)',
]);

// ── 1. The record and salt, as the beneficiary received them ────────────────
const file = new URL(`../demo/payment-${which}.json`, import.meta.url).pathname;
const saved = JSON.parse(readFileSync(file, 'utf8')) as {
  record: TravelRuleRecord;
  salt: string;
  commitment: string;
};

const recomputed = toHex(travelRuleCommitment(saved.record, fromHex(saved.salt)));
console.log(`payment      ${saved.record.paymentRef}`);
console.log(`beneficiary  ${saved.record.beneficiaryName}`);
console.log(`amount       ${(Number(saved.record.amount) / 1e6).toFixed(6)} ${saved.record.currency}`);
console.log(`recomputed   ${recomputed}`);
console.log(`expected     ${saved.commitment}`);

if (recomputed !== saved.commitment) {
  console.error('\nREFUSED: the record does not hash to the commitment Splash published.');
  console.error('A beneficiary that cannot reproduce the value must not acknowledge it.');
  process.exit(1);
}
console.log('match        yes — the beneficiary holds the record, not just the hash\n');

if (!SENDER || !PK) {
  console.log('ACK_SENDER and PK are not set, so this stops at the recomputation.');
  console.log('That step needs no chain and is the part that proves possession.');
  process.exit(0);
}

// ── 2. Acknowledge on Sepolia ───────────────────────────────────────────────
const account = privateKeyToAccount(PK);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

// Splash's payment ref, hashed to bytes32. Never the CCIP message id: that
// value does not exist until after the send.
const paymentRef = (await import('viem')).keccak256(
  new TextEncoder().encode(saved.record.paymentRef) as unknown as Hex,
);
const ackHash = (await import('viem')).keccak256(
  new TextEncoder().encode(`${saved.record.paymentRef}:${account.address}:ack`) as unknown as Hex,
);

const allowed = await publicClient.readContract({
  address: SENDER, abi: ABI, functionName: 'allowedVasp', args: [account.address],
});
console.log(`vasp         ${account.address}  allowlisted: ${allowed}`);
if (!allowed) {
  console.error('This address is not an allowlisted beneficiary on the sender. Ask the admin to setVasp().');
  process.exit(1);
}

const fee = await publicClient.readContract({
  address: SENDER, abi: ABI, functionName: 'getFee',
  args: [paymentRef, account.address, recomputed as Hex, ackHash],
});
console.log(`ccip fee     ${fee} wei`);

if (!EXECUTE) {
  console.log('\nDRY RUN — rerun with --execute to acknowledge on Sepolia.');
  process.exit(0);
}

// A little over the quote, so the fee moving between quote and send does not
// strand the acknowledgement. The contract refunds the difference.
const value = (fee * 120n) / 100n;
const hash = await walletClient.writeContract({
  address: SENDER, abi: ABI, functionName: 'acknowledge',
  args: [paymentRef, recomputed as Hex, ackHash], value,
});
console.log(`\nsepolia tx   ${hash}`);
console.log(`etherscan    https://sepolia.etherscan.io/tx/${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`status       ${receipt.status}`);

const sent = receipt.logs
  .map((l) => { try { return (require('viem') as any).decodeEventLog({ abi: ABI, ...l }); } catch { return null; } })
  .find((e: any) => e?.eventName === 'AckSent') as any;
const messageId: string | undefined = sent?.args?.messageId;
if (messageId) {
  console.log(`messageId    ${messageId}`);
  console.log(`ccip         https://ccip.chain.link/msg/${messageId}`);
}

// ── 3. Poll CCIP until the message is delivered ─────────────────────────────
if (messageId) {
  const until = Date.now() + 25 * 60_000;
  let state = '';
  while (Date.now() < until) {
    const r = await fetch(`https://api.ccip.chain.link/v2/messages/${messageId}`).catch(() => null);
    const body: any = r && r.ok ? await r.json().catch(() => null) : null;
    const s = body?.data?.[0]?.state ?? body?.state ?? '';
    if (s && s !== state) { state = s; console.log(`ccip state   ${state}`); }
    if (/success|committed|finalized/i.test(String(state))) break;
    await new Promise((x) => setTimeout(x, 20_000));
  }
  console.log(`\nNow anchor it on Sui:`);
  console.log(`  npm run anchor -- --commitment ${recomputed} --message-id ${messageId} --src-tx ${hash} --execute`);
}
