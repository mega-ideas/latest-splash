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
 * spent.
 *
 * What it rehearses, in the order the app tries them:
 *   1. the transfer as Send USDC quotes it today — gasless (no network fee,
 *      no SUI needed), with a fee leg only if the audit-anchor fee is on;
 *   2. the audit-anchor fee leg, paid to SPLASH_FEE_ADDRESS_MAINNET when it is
 *      set (loaded from .env.local), so the fee wallet is proven before the
 *      fee is switched on; otherwise to a placeholder (0x…fee);
 *   3. the fallback, where the sending wallet pays gas in SUI (x402 uses this
 *      shape too) — skipped for a wallet with no SUI, which only it needs;
 *   4. what a wallet with no USDC is told.
 * The recipient leg goes to a placeholder (0x…aa). Nothing is sent to anyone.
 *
 * Exit code 0 when every check passes.
 */
import {
  anchorFeeEnabled,
  formatUsdc,
  gaslessEnabled,
  parseUsdcMinor,
  quoteStablecoinTransfer,
  stablecoinFeeMinor,
  SUI_USDC_COIN_TYPE,
} from '../lib/payments/stablecoin-lane.ts';
import { verifyStablecoinTransfer } from '../lib/payments/stablecoin-verify.ts';
import { buildTransferBytes, describeBuildError, digestOf, laneClient, senderOf, simulateTransfer } from '../lib/server/stablecoin-chain.ts';
import { Transaction } from '@mysten/sui/transactions';

const USDC = SUI_USDC_COIN_TYPE.mainnet;
const SUI = '0x2::sui::SUI';
const GRAPHQL = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
const RECIPIENT = `0x${'aa'.repeat(32)}`;
// .env.local, as `next dev` reads it; a dry run needs no secret from it.
try { process.loadEnvFile('.env.local'); } catch { /* no file: the defaults */ }
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
function skip(name, why) {
  console.log(`SKIP  ${name}\n      ${why}`);
}

async function balances(client, owner) {
  const [usdc, sui] = await Promise.all([
    client.core.getBalance({ owner, coinType: USDC }),
    client.core.getBalance({ owner, coinType: SUI }),
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

/** Build, dry-run and verify one transfer; returns false when it could not be built. */
async function rehearse(label, { sender, legs, gas }) {
  let bytes;
  try {
    bytes = await buildTransferBytes(client, { sender, coinType: USDC, legs, gas });
  } catch (error) {
    check(`${label}: builds from the sender’s own USDC`, false, describeBuildError(error));
    return false;
  }
  check(`${label}: builds from the sender’s own USDC`, true, `${bytes.length} bytes, digest ${digestOf(bytes)}`);
  check(`${label}: the bytes name the sender`, senderOf(bytes) === sender);
  if (gas === 'GASLESS') {
    const { gasData, expiration } = Transaction.from(bytes).getData();
    check(`${label}: gasless — gas price 0, budget 0, no gas coins, a ValidDuring window`,
      gasData.price === '0' && gasData.budget === '0' && gasData.payment?.length === 0 && Boolean(expiration?.ValidDuring),
      `price ${gasData.price}, budget ${gasData.budget}, ${gasData.payment?.length ?? '?'} gas coins, expiration ${expiration?.$kind ?? 'none'}`);
  }

  let dry;
  try {
    dry = await simulateTransfer(client, bytes);
  } catch (error) {
    // The node refused the transaction outright (or did not answer): report it, don't crash.
    check(`${label}: the dry run succeeds on mainnet`, false, error instanceof Error ? error.message : String(error));
    return false;
  }
  check(`${label}: the dry run succeeds on mainnet`, dry.success, dry.error ?? null);
  check(`${label}: the dry run reports the digest the signed transaction will have`, dry.digest === digestOf(bytes), dry.digest || '(none)');
  const verdict = verifyStablecoinTransfer({ sender, coinType: USDC, legs }, dry);
  check(`${label}: Splash’s check passes — exact amounts, nobody else’s USDC moves`, verdict.ok, verdict.ok ? null : verdict.reason);
  for (const change of dry.balanceChanges.filter((c) => c.coinType.endsWith('::usdc::USDC'))) {
    console.log(`      ${change.address.slice(0, 10)}…  ${BigInt(change.amount) > 0n ? '+' : ''}${formatUsdc(BigInt(change.amount))} USDC`);
  }
  const suiSpent = dry.balanceChanges
    .filter((c) => c.coinType.endsWith('::sui::SUI') && c.address.toLowerCase() === sender.toLowerCase())
    .reduce((sum, c) => sum - BigInt(c.amount), 0n);
  if (gas === 'GASLESS') {
    check(`${label}: no network fee — the sender’s SUI does not move`, suiSpent === 0n, `${Number(suiSpent) / 1e9} SUI`);
  } else {
    console.log(suiSpent >= 0n
      ? `      network fee on this path: about ${Number(suiSpent) / 1e9} SUI, paid by the sending wallet`
      : `      network fee on this path: none net — merging this wallet's coins returned ${Number(-suiSpent) / 1e9} SUI of storage rebate`);
  }

  // The same check refuses a transaction that pays anything else.
  const last = legs.at(-1);
  const skimmed = verifyStablecoinTransfer({ sender, coinType: USDC, legs: [...legs.slice(0, -1), { ...last, amountMinor: last.amountMinor + 1n }] }, dry);
  check(`${label}: a quote that differs by one micro-USDC is refused`, !skimmed.ok, skimmed.ok ? 'it was accepted' : skimmed.reason);
  return true;
}

const client = laneClient();
const amount = arg('amount') ?? '10';
const principal = parseUsdcMinor(amount);
const anchorOn = anchorFeeEnabled();
const gaslessOn = gaslessEnabled();
// As Send USDC quotes a transfer out of Splash (a Splash user's wallet is always free).
const quote = quoteStablecoinTransfer(principal, { destination: 'EXTERNAL', anchorFeeOn: anchorOn });
const anchorFee = stablecoinFeeMinor(principal, 'EXTERNAL', true);
const appLegs = [
  { address: RECIPIENT, amountMinor: quote.principalMinor },
  ...(quote.feeMinor > 0n ? [{ address: FEE, amountMinor: quote.feeMinor }] : []),
];
const anchorLegs = [{ address: RECIPIENT, amountMinor: principal }, { address: FEE, amountMinor: anchorFee }];

console.log(`Rehearsing ${formatUsdc(principal)} USDC on Sui mainnet (${process.env.SUI_MAINNET_RPC_URL || 'fullnode.mainnet.sui.io'}). Nothing is signed or sent.`);
console.log(`Splash fee today: ${quote.feeMinor > 0n ? `${formatUsdc(quote.feeMinor)} USDC audit-anchor fee (STABLECOIN_ANCHOR_FEE=on)` : 'free'}. Network fee: ${gaslessOn ? 'none (gasless)' : 'paid in SUI (STABLECOIN_GASLESS=off)'}.`);
console.log(`Fee wallet: ${FEE === CONFIGURED_FEE ? `${FEE.slice(0, 6)}…${FEE.slice(-4)} (SPLASH_FEE_ADDRESS_MAINNET)` : 'a placeholder (SPLASH_FEE_ADDRESS_MAINNET is not set)'}\n`);

const sender = arg('sender') ?? await findHolder(client, principal + anchorFee);
if (!sender) {
  console.log('FAIL  no public USDC holder found to rehearse with; pass --sender 0x…');
  process.exit(1);
}
const before = await balances(client, sender);
console.log(`Sender ${sender}: ${formatUsdc(before.usdc)} USDC, ${Number(before.sui) / 1e9} SUI\n`);

// 1. The transfer Send USDC would hand the wallet today.
if (!(await rehearse('Send USDC today', { sender, legs: appLegs, gas: gaslessOn ? 'GASLESS' : 'SENDER_PAYS' }))) process.exit(1);

// 2. The audit-anchor fee leg, before it is switched on (already covered by 1
// when it is on). It needs the fee on top, which a wallet funded for exactly
// the transfer does not hold — that is not a failure of today's transfer.
console.log('');
if (quote.feeMinor > 0n) skip('Audit-anchor fee leg', 'already rehearsed above: the fee is on.');
else if (before.usdc < principal + anchorFee) skip('Audit-anchor fee leg', `the wallet holds under ${formatUsdc(principal + anchorFee)} USDC (the amount plus the ${formatUsdc(anchorFee)} fee). Rehearse it with a smaller --amount.`);
else await rehearse(`Audit-anchor fee leg (${formatUsdc(anchorFee)} USDC)`, { sender, legs: anchorLegs, gas: 'GASLESS' });

// 3. The fallback: the sending wallet pays gas in SUI.
console.log('');
if (before.sui < 10_000_000n) skip('Sender-pays fallback', 'this wallet holds under 0.01 SUI. Only the fallback (and x402) needs SUI.');
else await rehearse('Sender-pays fallback', { sender, legs: appLegs, gas: 'SENDER_PAYS' });

// 4. Nothing moved. Only for a wallet you named: a busy public holder's
// balances change on their own between two reads.
console.log('');
if (arg('sender')) {
  const after = await balances(client, sender);
  check('nothing moved: your balances are unchanged', after.usdc === before.usdc && after.sui === before.sui);
}

// 5. What an empty wallet is told.
try {
  await buildTransferBytes(client, { sender: EMPTY_WALLET, coinType: USDC, legs: appLegs, gas: 'GASLESS' });
  check('an empty wallet is refused at build', false, 'it built');
} catch (error) {
  const said = describeBuildError(error);
  check('an empty wallet is told in plain words', !said.startsWith('The transfer could not be prepared'), said);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
