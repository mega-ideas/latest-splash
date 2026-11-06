/**
 * The whole invoice rail, end to end, against a real EIP-3009 token.
 *
 *   npm run invoice -- [--execute]
 *
 * 1. the merchant raises an invoice carrying the travel-rule commitment
 * 2. the customer SIGNS an authorisation — no transaction, no gas token
 * 3. a relayer submits it: the merchant is paid its net at once, the fee is held
 * 4. the attestor records the proof and only then is Splash paid
 * 5. the proof is written into the registry, beside the Arc settlement
 *
 * Deployed on Sepolia rather than Whitechain: the Whitechain faucet gives
 * 0.5 WBT per 24h and ours never arrived, and the official USDT address is
 * mainnet-only. Circle's Sepolia USDC has the same EIP-3009 surface, so the
 * contract is unchanged — only the token address and the EIP-712 domain differ.
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, defineChain, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const EXECUTE = process.argv.includes('--execute');
const RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env.wallets', import.meta.url).pathname, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Hex;
const INVOICE = (env.INVOICE_SEPOLIA ?? '') as Hex;
const REGISTRY = (env.REGISTRY_SEPOLIA ?? '') as Hex;

// The customer holds the USDC, so it signs. The admin relays and attests.
const customer = privateKeyToAccount(env.BENEFICIARY_PK as Hex);
const relayer = privateKeyToAccount(env.ADMIN_PK as Hex);
const merchant = (env.PAYER_ADDRESS ?? '') as Hex;
const feeRecipient = (env.FEE_RECIPIENT_ADDRESS ?? '') as Hex;

const AMOUNT = 10_000_000n; // 10.000000 USDC
const REF = 'INV-MUM-0001';
const invoiceId = keccak256(toHex(REF));
const commitment = JSON.parse(
  readFileSync(new URL('../demo/payment-B.json', import.meta.url).pathname, 'utf8'),
).commitment as Hex;

const INVOICE_ABI = parseAbi([
  'function createInvoice(bytes32 invoiceId, uint256 amount, uint64 dueAt, bytes32 travelRuleCommitment)',
  'function payWithAuthorization(bytes32 invoiceId, address from, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function recordProof(bytes32 invoiceId, bytes32 travelRuleCommitment)',
  'function setAttestor(address attestor, bool allowed)',
  'function getInvoice(bytes32) view returns ((address merchant,uint256 amount,uint256 feeAmount,uint64 dueAt,uint64 proofDeadline,bytes32 travelRuleCommitment,uint8 status,address payer))',
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const REGISTRY_ABI = parseAbi([
  'function setRecorder(address,bool)',
  'function record(bytes32,bytes32,uint8,uint64,bytes32,uint256,uint256)',
  'function total() view returns (uint256)',
  'function totalFeesRecorded() view returns (uint256)',
]);

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const relay = createWalletClient({ account: relayer, chain: sepolia, transport: http(RPC) });
const cust = createWalletClient({ account: customer, chain: sepolia, transport: http(RPC) });

const usdc = (who: Hex) => pub.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [who] });
const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(6);

console.log(`invoice   ${INVOICE}`);
console.log(`registry  ${REGISTRY}`);
console.log(`merchant  ${merchant}`);
console.log(`customer  ${customer.address}  (${fmt(await usdc(customer.address))} USDC)`);
console.log(`amount    ${fmt(AMOUNT)} USDC, fee 15 bps = ${fmt((AMOUNT * 15n) / 10_000n)}`);
console.log(`commitment ${commitment}`);

if (!EXECUTE) { console.log('\nDRY RUN — rerun with --execute.'); process.exit(0); }

const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });

// ── 1. the merchant raises the invoice ──────────────────────────────────────
// Signed by the relayer key standing in for the merchant's own wallet; the
// contract records msg.sender as the merchant.
console.log('\n1. createInvoice');
const dueAt = BigInt(Math.floor(Date.now() / 1000) + 86_400);
let h = await relay.writeContract({ address: INVOICE, abi: INVOICE_ABI, functionName: 'createInvoice', args: [invoiceId, AMOUNT, dueAt, commitment] });
await wait(h); console.log(`   ${h}`);

// ── 2. the customer signs. No transaction, no gas token ─────────────────────
console.log('\n2. customer signs an EIP-3009 authorisation (no gas)');
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
const nonce = keccak256(toHex(`${REF}:${Date.now()}`));
const signature = await cust.signTypedData({
  account: customer,
  // Circle's USDC declares name "USDC" version "2"; Whitechain's USDT declares
  // "Tether USD" version "1". Same scheme, different domain.
  domain: { name: 'USDC', version: '2', chainId: sepolia.id, verifyingContract: USDC },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: { from: customer.address, to: INVOICE, value: AMOUNT, validAfter, validBefore, nonce },
});
const r = `0x${signature.slice(2, 66)}` as Hex;
const s = `0x${signature.slice(66, 130)}` as Hex;
const v = Number.parseInt(signature.slice(130, 132), 16);
console.log(`   signed, nonce ${nonce.slice(0, 18)}…`);

// ── 3. the relayer submits it. The relayer pays the gas ─────────────────────
console.log('\n3. relayer submits — merchant paid at once, fee held');
const before = { merchant: await usdc(merchant), fee: await usdc(feeRecipient), escrow: await usdc(INVOICE) };
h = await relay.writeContract({ address: INVOICE, abi: INVOICE_ABI, functionName: 'payWithAuthorization', args: [invoiceId, customer.address, validAfter, validBefore, nonce, v, r, s] });
await wait(h); console.log(`   ${h}`);
console.log(`   merchant  ${fmt(before.merchant)} -> ${fmt(await usdc(merchant))}`);
console.log(`   held      ${fmt(before.escrow)} -> ${fmt(await usdc(INVOICE))}`);
console.log(`   splash    ${fmt(before.fee)} -> ${fmt(await usdc(feeRecipient))}   (not yet)`);

// ── 4. the proof is recorded, and only then is Splash paid ──────────────────
console.log('\n4. attestor records the proof — the only path that pays Splash');
h = await relay.writeContract({ address: INVOICE, abi: INVOICE_ABI, functionName: 'setAttestor', args: [relayer.address, true] });
await wait(h);
h = await relay.writeContract({ address: INVOICE, abi: INVOICE_ABI, functionName: 'recordProof', args: [invoiceId, commitment] });
await wait(h); console.log(`   ${h}`);
console.log(`   held      ${fmt(await usdc(INVOICE))}`);
console.log(`   splash    ${fmt(await usdc(feeRecipient))}   <- paid, on proof`);

// ── 5. one registry, both rails ─────────────────────────────────────────────
console.log('\n5. write it into the registry');
h = await relay.writeContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'setRecorder', args: [relayer.address, true] });
await wait(h);
h = await relay.writeContract({
  address: REGISTRY, abi: REGISTRY_ABI, functionName: 'record',
  args: [commitment, invoiceId, 2, BigInt(sepolia.id), h, AMOUNT, (AMOUNT * 15n) / 10_000n],
});
await wait(h); console.log(`   ${h}`);
const total = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'total' });
const fees = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'totalFeesRecorded' });
console.log(`\nregistry holds ${total} proof(s), ${fmt(fees as bigint)} USDC of fees recorded`);
