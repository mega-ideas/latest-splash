/**
 * The invoice rail on Whitechain, in official USDT, paid by signature.
 *
 *   npm run wc -- [--execute]
 *
 * The customer signs an EIP-3009 authorisation and never sends a transaction,
 * so it needs no WBT. A relayer submits it, the merchant is paid its net at
 * once, and Splash's fee is held until the proof is recorded.
 *
 * The EIP-712 domain was derived from the token rather than assumed: the
 * contract's DOMAIN_SEPARATOR matches name "Tether USD" with version "1",
 * which is what `version()` returning an empty string would otherwise hide.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, defineChain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const EXECUTE = process.argv.includes('--execute');
const RPC = process.env.WHITECHAIN_RPC ?? 'https://rpc.testnet.whitechain.io';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env.wallets', import.meta.url).pathname, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const whitechain = defineChain({
  id: 1874,
  name: 'Whitechain Testnet',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as Hex;
const INVOICE = '0x27e6cC8574deACa4B30A7A97e24fE11C209eCD95' as Hex; // points at official USDT
const REGISTRY = '0xF2cc98A712Da800b73F000075d41276B28D74ec6' as Hex;

const customer = privateKeyToAccount(env.ADMIN_PK as Hex);   // holds the USDT
const relayer = privateKeyToAccount(env.PAYER_PK as Hex);    // pays the gas, is the merchant
const feeRecipient = env.FEE_RECIPIENT_ADDRESS as Hex;

const AMOUNT = 25_000_000n; // 25.000000 USDT
const REF = 'INV-WC-OFFICIAL-1';
const invoiceId = keccak256(toHex(REF));
const commitment = JSON.parse(
  readFileSync(new URL('../demo/payment-A.json', import.meta.url).pathname, 'utf8'),
).commitment as Hex;

const ABI = parseAbi([
  'function createInvoice(bytes32 invoiceId, uint256 amount, uint64 dueAt, bytes32 travelRuleCommitment)',
  'function payWithAuthorization(bytes32 invoiceId, address from, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function recordProof(bytes32 invoiceId, bytes32 travelRuleCommitment)',
  'function setAttestor(address attestor, bool allowed)',
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const REG = parseAbi(['function record(bytes32,bytes32,uint8,uint64,bytes32,uint256,uint256)', 'function total() view returns (uint256)', 'function totalFeesRecorded() view returns (uint256)']);

const pub = createPublicClient({ chain: whitechain, transport: http(RPC) });
const relay = createWalletClient({ account: relayer, chain: whitechain, transport: http(RPC) });
const cust = createWalletClient({ account: customer, chain: whitechain, transport: http(RPC) });
const bal = (a: Hex) => pub.readContract({ address: USDT, abi: ERC20, functionName: 'balanceOf', args: [a] });
const f = (v: bigint) => (Number(v) / 1e6).toFixed(6);

console.log(`token     ${USDT}  (official USDT)`);
console.log(`invoice   ${INVOICE}`);
console.log(`customer  ${customer.address}  ${f(await bal(customer.address))} USDT`);
console.log(`merchant  ${relayer.address}   ${f(await bal(relayer.address))} USDT`);
console.log(`amount    ${f(AMOUNT)} USDT, fee 15 bps = ${f((AMOUNT * 15n) / 10_000n)}`);
if (!EXECUTE) { console.log('\nDRY RUN — rerun with --execute.'); process.exit(0); }

const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });
let h: Hex;

console.log('\n1. merchant raises the invoice');
h = await relay.writeContract({ address: INVOICE, abi: ABI, functionName: 'createInvoice', args: [invoiceId, AMOUNT, BigInt(Math.floor(Date.now() / 1000) + 86_400), commitment] });
await wait(h); console.log(`   ${h}`);

console.log('\n2. customer signs — no transaction, no WBT');
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
const nonce = keccak256(toHex(`${REF}:${Date.now()}`));
const sig = await cust.signTypedData({
  account: customer,
  // Derived from the token's own DOMAIN_SEPARATOR, not assumed.
  domain: { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] },
  primaryType: 'TransferWithAuthorization',
  message: { from: customer.address, to: INVOICE, value: AMOUNT, validAfter: 0n, validBefore, nonce },
});
const r = `0x${sig.slice(2, 66)}` as Hex, s = `0x${sig.slice(66, 130)}` as Hex;
const v = Number.parseInt(sig.slice(130, 132), 16);
console.log(`   signed`);

console.log('\n3. relayer submits — merchant paid at once, fee held');
const before = { m: await bal(relayer.address), f: await bal(feeRecipient) };
h = await relay.writeContract({ address: INVOICE, abi: ABI, functionName: 'payWithAuthorization', args: [invoiceId, customer.address, 0n, validBefore, nonce, v, r, s] });
await wait(h); console.log(`   ${h}`);
console.log(`   merchant ${f(before.m)} -> ${f(await bal(relayer.address))}`);
console.log(`   held     ${f(await bal(INVOICE))}`);
console.log(`   splash   ${f(before.f)} -> ${f(await bal(feeRecipient))}  (not yet)`);

console.log('\n4. proof recorded — the only path that pays Splash');
h = await relay.writeContract({ address: INVOICE, abi: ABI, functionName: 'setAttestor', args: [relayer.address, true] });
await wait(h);
h = await relay.writeContract({ address: INVOICE, abi: ABI, functionName: 'recordProof', args: [invoiceId, commitment] });
await wait(h); console.log(`   ${h}`);
console.log(`   held     ${f(await bal(INVOICE))}`);
console.log(`   splash   ${f(await bal(feeRecipient))}  <- paid, on proof`);

console.log('\n5. into the registry');
h = await relay.writeContract({ address: REGISTRY, abi: REG, functionName: 'record', args: [commitment, invoiceId, 2, 1874n, h, AMOUNT, (AMOUNT * 15n) / 10_000n] });
await wait(h).catch(() => {});
console.log(`   ${h}`);
console.log(`\nregistry: ${await pub.readContract({ address: REGISTRY, abi: REG, functionName: 'total' })} proofs, ${f(await pub.readContract({ address: REGISTRY, abi: REG, functionName: 'totalFeesRecorded' }) as bigint)} fees`);
