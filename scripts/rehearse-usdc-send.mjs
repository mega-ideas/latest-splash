#!/usr/bin/env node
/**
 * Rehearse a USDC wallet transfer against Sui MAINNET, moving nothing.
 *
 *   npm run rehearse:usdc                        # finds a public USDC holder to rehearse with
 *   npm run rehearse:usdc -- --sender 0x…        # rehearse from a wallet you name (e.g. your own)
 *   npm run rehearse:usdc -- --amount 25
 *
 * It drives the lane's real code, not a copy: buildTransferBytes (the exact
 * transaction Send USDC hands a wallet to sign), simulateTransfer (the dry run
 * Splash does on signed bytes before submitting), and verifyStablecoinTransfer
 * (the check that the recipient gets exactly the amount, the fee address
 * exactly the fee, the sender pays exactly both, and no one else's USDC
 * moves). A dry run needs no signature, so nothing is signed, submitted or
 * spent. It also checks what a wallet with no USDC is told.
 *
 * The recipient leg goes to a placeholder (0x…aa). The fee leg goes to
 * SPLASH_FEE_ADDRESS_MAINNET when it is set (loaded from .env.local), so the
 * rehearsal proves the real fee wallet can be paid; otherwise to a
 * placeholder (0x…fee). Nothing is sent to either: this is a simulation.
 *
 * Exit code 0 when every check passes.
 */
import { parseUsdcMinor, quoteStablecoinTransfer, SUI_USDC_COIN_TYPE, formatUsdc } from '../lib/payments/stablecoin-lane.ts';
import { verifyStablecoinTransfer } from '../lib/payments/stablecoin-verify.ts';
import { buildTransferBytes, describeBuildError, digestOf, laneClient, senderOf, simulateTransfer } from '../lib/server/stablecoin-chain.ts';

const USDC = SUI_USDC_COIN_TYPE.mainnet;
const GRAPHQL = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
const RECIPIENT = `0x${'aa'.repeat(32)}`;
// .env.local, as `next dev` reads it; a dry run needs no secret from it.
try { process.loadEnvFile('.env.local'); } catch { /* no file: the placeholder fee leg */ }
const CONFIGURED_FEE = (process.env.SPLASH_FEE_ADDRESS_MAINNET ?? '').trim();
const FEE = /^0x[0-9a-fA-F]{64}$/.test(CONFIGURED_FEE) ? CONFIGURED_FEE : `0x${'0'.repeat(61)}fee`;
const EMPTY_WALLET = `0x${'0'.repeat(62)}42`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
}

async function balances(client, owner) {
  const [usdc, sui] = await Promise.all([
    client.core.getBalance({ owner, coinType: USDC }),
    client.core.getBalance({ owner, coinType: '0x2::sui::SUI' }),
  ]);
  return { usdc: BigInt(usdc.balance.balance), sui: BigInt(sui.balance.balance) };
}

/** A public address holding at least `need` USDC and 0.1 SUI: read from mainnet, used only to simulate. */
async function findHolder(client, need) {
  const query = `{ objects(first: 50, filter: { type: "0x2::coin::Coin<${USDC}>" }) { nodes { owner { __typename ... on AddressOwner { address { address } } } } } }`;
  const response = await fetch(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const body = await response.json();
  const owners = [...new Set((body.data?.objects?.nodes ?? [])
    .filter((n) => n.owner?.__typename === 'AddressOwner')
    .map((n) => n.owner.address.address))];
  for (const owner of owners) {
    const b = await balances(client, owner);
    if (b.usdc >= need && b.sui >= 100_000_000n) return owner;
  }
  return null;
}

const client = laneClient();
const amount = arg('amount') ?? '10';
const principal = parseUsdcMinor(amount);
const quote = quoteStablecoinTransfer(principal);
console.log(`Rehearsing ${formatUsdc(principal)} USDC + ${formatUsdc(quote.feeMinor)} fee on Sui mainnet (${process.env.SUI_MAINNET_RPC_URL || 'fullnode.mainnet.sui.io'}). Nothing is signed or sent.`);
console.log(`Fee leg: ${FEE === CONFIGURED_FEE ? `your fee wallet ${FEE.slice(0, 6)}…${FEE.slice(-4)} (SPLASH_FEE_ADDRESS_MAINNET)` : 'a placeholder (SPLASH_FEE_ADDRESS_MAINNET is not set)'}\n`);

const sender = arg('sender') ?? await findHolder(client, quote.totalDebitMinor);
if (!sender) {
  console.log('FAIL  no public USDC holder found to rehearse with; pass --sender 0x…');
  process.exit(1);
}
const before = await balances(client, sender);
console.log(`Sender ${sender}: ${formatUsdc(before.usdc)} USDC, ${Number(before.sui) / 1e9} SUI\n`);

// 1. The transaction Send USDC would hand the wallet.
let bytes;
try {
  bytes = await buildTransferBytes(client, {
    sender,
    coinType: USDC,
    legs: [
      { address: RECIPIENT, amountMinor: quote.principalMinor },
      { address: FEE, amountMinor: quote.feeMinor },
    ],
  });
  check('builds the transfer from the sender’s own USDC', true, `${bytes.length} bytes, digest ${digestOf(bytes)}`);
  check('the bytes name the sender', senderOf(bytes) === sender);
} catch (error) {
  check('builds the transfer from the sender’s own USDC', false, describeBuildError(error));
  process.exit(1);
}

// 2. The dry run Splash does before submitting, and the verdict it acts on.
const dry = await simulateTransfer(client, bytes);
check('the dry run succeeds on mainnet', dry.success, dry.error ?? null);
check('the dry run reports the digest the signed transaction will have', dry.digest === digestOf(bytes), dry.digest || '(none)');
const expected = {
  sender,
  coinType: USDC,
  legs: [
    { address: RECIPIENT, amountMinor: quote.principalMinor },
    { address: FEE, amountMinor: quote.feeMinor },
  ],
};
const verdict = verifyStablecoinTransfer(expected, dry);
check('Splash’s check passes: exact amount, exact fee, nobody else’s USDC moves', verdict.ok, verdict.ok ? null : verdict.reason);
for (const change of dry.balanceChanges.filter((c) => c.coinType.endsWith('::usdc::USDC'))) {
  console.log(`      ${change.address.slice(0, 10)}…  ${BigInt(change.amount) > 0n ? '+' : ''}${formatUsdc(BigInt(change.amount))} USDC`);
}

// 3. The same check refuses a transaction that pays anything else.
const skimmed = verifyStablecoinTransfer({ ...expected, legs: [expected.legs[0], { address: FEE, amountMinor: quote.feeMinor + 1n }] }, dry);
check('a quote that differs by one micro-USDC is refused', !skimmed.ok, skimmed.ok ? 'it was accepted' : skimmed.reason);

// 4. Nothing moved. Only for a wallet you named: a busy public holder's
// balances change on their own between two reads.
if (arg('sender')) {
  const after = await balances(client, sender);
  check('nothing moved: your balances are unchanged', after.usdc === before.usdc && after.sui === before.sui);
}

// 5. What an empty wallet is told.
try {
  await buildTransferBytes(client, { sender: EMPTY_WALLET, coinType: USDC, legs: expected.legs });
  check('an empty wallet is refused at build', false, 'it built');
} catch (error) {
  const said = describeBuildError(error);
  check('an empty wallet is told in plain words', !said.startsWith('The transfer could not be prepared'), said);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
