/**
 * The relayer that puts every Splash proof in one place.
 *
 *   npm run record -- --rail arc        [--execute]
 *   npm run record -- --rail whitechain [--execute]
 *
 * Each rail enforces its own rule locally and keeps its own money safe. This
 * reads what a rail actually settled and writes one row into the registry on
 * Whitechain, so an auditor has a single list instead of three explorers.
 *
 * It reads the settlement from chain rather than from our own notes: the
 * amount and the fee come out of the escrow's Released event, so a row cannot
 * claim a payment the rail did not make. In production this role is Walrus;
 * the registry is the hackathon stand-in.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, type Hex, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const RAIL = (arg('rail') ?? 'arc').toLowerCase();
const EXECUTE = process.argv.includes('--execute');

const ARC_RPC = process.env.ARC_RPC ?? 'https://rpc.testnet.arc.io';
const WC_RPC = process.env.WHITECHAIN_RPC ?? 'https://rpc-testnet.whitechain.io';
const ESCROW = (process.env.ESCROW ?? '0xc536d49c040c3327ee6aa72b83c8a9d31a72ae34') as Hex;
const REGISTRY = (process.env.REGISTRY ?? '') as Hex;
const PK = (process.env.ADMIN_PK ?? '') as Hex;

const RAIL_ID = { unknown: 0, arc: 1, whitechain: 2, sui: 3 } as const;

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
});
const whitechainTestnet = defineChain({
  id: 2625,
  name: 'Whitechain Testnet',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [WC_RPC] } },
});

const ESCROW_ABI = parseAbi([
  'event Released(bytes32 indexed paymentRef, bytes32 indexed messageId, address indexed recipient, uint256 net, uint256 fee, bytes32 ackHash, bytes32 commitment)',
]);
const REGISTRY_ABI = parseAbi([
  'function record(bytes32 travelRuleCommitment, bytes32 paymentRef, uint8 rail, uint64 sourceChainId, bytes32 sourceTx, uint256 amount, uint256 feeCharged)',
  'function isRecorded(bytes32) view returns (bool)',
  'function total() view returns (uint256)',
  'function totalFeesRecorded() view returns (uint256)',
]);

const arc = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });

// What the rail actually settled, read from its own event.
const logs = await arc.getLogs({
  address: ESCROW,
  event: ESCROW_ABI[0],
  fromBlock: BigInt(process.env.ESCROW_DEPLOY_BLOCK ?? '71095257'),
  toBlock: 'latest',
});

console.log(`rail        ${RAIL}`);
console.log(`escrow      ${ESCROW}`);
console.log(`settlements ${logs.length}`);
if (!logs.length) {
  console.log('\nNothing settled on this rail yet, so there is nothing to record.');
  process.exit(0);
}

const rows = logs.map((l) => {
  const a = l.args as Record<string, unknown>;
  return {
    commitment: a.commitment as Hex,
    paymentRef: a.paymentRef as Hex,
    amount: (a.net as bigint) + (a.fee as bigint),
    fee: a.fee as bigint,
    sourceTx: l.transactionHash as Hex,
  };
});

for (const r of rows) {
  console.log(
    `  ${r.paymentRef.slice(0, 10)}…  amount ${(Number(r.amount) / 1e6).toFixed(6)}  fee ${(Number(r.fee) / 1e6).toFixed(6)}  commitment ${r.commitment.slice(0, 12)}…`,
  );
}

if (!REGISTRY) {
  console.log('\nREGISTRY is not set, so this stops at reading the rail.');
  console.log('Deploy SplashProofRegistry on Whitechain, then set REGISTRY and rerun.');
  process.exit(0);
}
if (!EXECUTE) {
  console.log('\nDRY RUN — rerun with --execute to write these rows into the registry.');
  process.exit(0);
}

const account = privateKeyToAccount(PK);
const wc = createPublicClient({ chain: whitechainTestnet, transport: http(WC_RPC) });
const wallet = createWalletClient({ account, chain: whitechainTestnet, transport: http(WC_RPC) });

for (const r of rows) {
  const already = await wc.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'isRecorded', args: [r.commitment] });
  if (already) { console.log(`  ${r.commitment.slice(0, 12)}… already recorded, skipping`); continue; }
  const hash = await wallet.writeContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'record',
    args: [r.commitment, r.paymentRef, RAIL_ID[RAIL as keyof typeof RAIL_ID] ?? 1, BigInt(arcTestnet.id), r.sourceTx, r.amount, r.fee],
  });
  console.log(`  recorded ${r.commitment.slice(0, 12)}… -> ${hash}`);
  await wc.waitForTransactionReceipt({ hash });
}

const total = await wc.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'total' });
const fees = await wc.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'totalFeesRecorded' });
console.log(`\nregistry now holds ${total} proof(s), ${(Number(fees) / 1e6).toFixed(6)} USDC of fees recorded`);
