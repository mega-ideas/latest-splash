#!/usr/bin/env node
/**
 * Treasury money stays in the business's own wallet (v2 D9; the 5.7 review).
 *
 * Treasury is USDY in the business's own Splash Wallet: a swap spends the
 * wallet's USDC and its USDY comes back to the same wallet, and a redemption
 * does the reverse. Two ways round that were found in review. An order that
 * recorded no wallet left whatever builds the transaction to decide where the
 * output goes (the operator, a sponsor, anyone). And the custodial Smart
 * Treasury ledger, which moved a business's USDC into a position Splash held,
 * came back whenever the custody phase was switched on.
 *
 * Both decay the mundane way: someone adds a recipient parameter "for
 * flexibility", or flips a switch for another feature. So this checks, from
 * the source, that:
 *
 *   1. the custodial ledger switch is the constant `false`, read from nothing;
 *   2. every /api/treasury handler answers 410 before the custody phase;
 *   3. an order's source and recipient are the same server-resolved wallet:
 *      the store writes both from one `walletAddress`, the handler takes it
 *      from `resolveWallet`, and no migration drops the CHECK that keeps them
 *      equal;
 *   4. no Treasury wallet route reads an address from the request;
 *   5. an approved custodial move is never carried out or replayed;
 *   6. Zeke's Treasury answer does not lift with the custody phase.
 *
 * Run by `npm run lint` (`check:treasury-wallet`). Paths are read relative to
 * the working directory, so tests can run it over planted copies.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const problems = [];
const read = (relative) => {
  const full = path.join(process.cwd(), relative);
  if (!existsSync(full)) {
    problems.push(`${relative} is missing`);
    return '';
  }
  return readFileSync(full, 'utf8');
};
const strip = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/(^|[^:])\/\/.*$/, '$1')))
    .join('\n');

// 1. The switch.
{
  const file = 'lib/server/custodial-treasury.ts';
  const code = strip(read(file));
  const decl = code.match(/export const CUSTODIAL_TREASURY_LEDGER_ON\s*=\s*([^;]+);/);
  if (!decl) problems.push(`${file}: CUSTODIAL_TREASURY_LEDGER_ON is not declared`);
  else if (decl[1].trim() !== 'false as boolean') {
    problems.push(`${file}: CUSTODIAL_TREASURY_LEDGER_ON must be the constant \`false as boolean\`, not \`${decl[1].trim()}\``);
  }
  if (/process\.env|getEnv\(/.test(code)) problems.push(`${file}: CUSTODIAL_TREASURY_LEDGER_ON must not be read from the environment`);
}

// 2. The ledger route.
{
  const file = 'app/api/treasury/route.ts';
  const code = strip(read(file));
  const handlers = [...code.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
  if (handlers.length === 0) problems.push(`${file}: no handler found`);
  handlers.forEach((match, i) => {
    const end = i + 1 < handlers.length ? handlers[i + 1].index : code.length;
    const body = code.slice(match.index, end);
    const gate = body.indexOf('if (!CUSTODIAL_TREASURY_LEDGER_ON) return custodialTreasuryRetiredResponse();');
    const custody = body.indexOf('custodyPhaseEnabled(');
    const firstWork = body.search(/requireSessionAccount\(|readJsonBody\(|snapshot\(|moveToTreasury\(|proposeForApproval\(/);
    if (gate < 0) problems.push(`${file}: ${match[1]} does not answer 410 (CUSTODIAL_TREASURY_LEDGER_ON)`);
    else {
      if (custody >= 0 && custody < gate) problems.push(`${file}: ${match[1]} reads the custody phase before it answers 410`);
      if (firstWork >= 0 && firstWork < gate) problems.push(`${file}: ${match[1]} does work before it answers 410`);
    }
  });
}

// 3. An order's wallet.
{
  const store = 'lib/server/treasury-wallet-orders.ts';
  const code = strip(read(store));
  if (!/sourceAddress: input\.walletAddress,/.test(code)) problems.push(`${store}: an order's source must be input.walletAddress`);
  if (!/recipientAddress: input\.walletAddress,/.test(code)) problems.push(`${store}: an order's recipient must be input.walletAddress, the same wallet as its source`);
  const recipientWrites = code.match(/recipientAddress:\s*[^,\n]+/g) ?? [];
  for (const w of recipientWrites) {
    if (!/recipientAddress:\s*(input\.walletAddress|row\.recipientAddress|order\.recipientAddress|string)\b/.test(w)) {
      problems.push(`${store}: the recipient is written from something other than the wallet (${w.trim()})`);
    }
  }

  const handler = 'lib/server/treasury-wallet.ts';
  const h = strip(read(handler));
  if (!/const wallet = await deps\.resolveWallet\(caller\.orgId\);/.test(h)) problems.push(`${handler}: the order's wallet must come from resolveWallet(caller.orgId)`);
  const passes = h.match(/walletAddress:\s*([^,\n]+),/g) ?? [];
  if (passes.length === 0) problems.push(`${handler}: no walletAddress is passed to createTreasuryOrder (resolveWallet)`);
  for (const p of passes) {
    if (!/walletAddress:\s*wallet\.address,/.test(p)) problems.push(`${handler}: walletAddress must be wallet.address from resolveWallet, not ${p.trim()}`);
  }

  const dir = path.join(process.cwd(), 'drizzle');
  const sql = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  let added = false;
  for (const f of sql) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    if (/ADD CONSTRAINT "treasury_wallet_orders_recipient_is_source" CHECK \("recipient_address" = "source_address"\)/.test(text)) added = true;
    if (/DROP CONSTRAINT[^;]*treasury_wallet_orders_recipient_is_source/i.test(text) || (added && /DROP COLUMN[^;]*"(recipient_address|source_address)"/i.test(text))) {
      problems.push(`drizzle/${f}: drops treasury_wallet_orders_recipient_is_source or a column it holds equal`);
    }
  }
  if (!added) problems.push('drizzle: no migration adds treasury_wallet_orders_recipient_is_source (recipient_address = source_address)');
}

// 4. No address from the request.
for (const file of ['app/api/treasury/wallet/route.ts', 'app/api/treasury/wallet/quote/route.ts', 'app/api/treasury/wallet/orders/route.ts']) {
  const code = strip(read(file));
  if (/searchParams\.get\(\s*['"](address|wallet|recipient|owner)['"]\s*\)|body\.(address|recipient|recipientAddress|sourceAddress|walletAddress|wallet)\b/.test(code)) {
    problems.push(`${file}: reads an address from the request; the wallet is resolved on the server`);
  }
}

// 5. No custodial move carried out.
{
  const exec = 'lib/server/approval-execution.ts';
  const code = strip(read(exec));
  const at = code.indexOf("case 'TREASURY_ALLOCATE':");
  const end = code.indexOf('default:', at);
  const treasuryCase = at >= 0 ? code.slice(at, end > at ? end : undefined) : '';
  if (!treasuryCase) problems.push(`${exec}: no TREASURY_ALLOCATE case`);
  else if (!/return \{ state: 'SKIPPED'/.test(treasuryCase) || /\bawait\b|state: 'EXECUTED'|[Rr]eplay|import\(/.test(treasuryCase)) {
    problems.push(`${exec}: an approved custodial treasury move must be recorded SKIPPED and carried out by nothing`);
  }
  if (/executeTreasuryMove|authorizeTreasuryForApproval/.test(code)) problems.push(`${exec}: still carries out a custodial treasury move`);
  const replay = 'lib/server/approval-replay.ts';
  if (/app\/api\/treasury\/route|['"]\/api\/treasury['"]/.test(strip(read(replay)))) problems.push(`${replay}: replays into the retired /api/treasury ledger route`);
}

// 6. Zeke.
{
  const file = 'lib/agent/zeke-lane-guard.ts';
  const code = strip(read(file));
  const at = code.indexOf('export function treasuryCustodyRefusal');
  const body = at >= 0 ? code.slice(at, code.indexOf('\n}', at)) : '';
  if (!body) problems.push(`${file}: treasuryCustodyRefusal is missing`);
  else if (/custodyPhaseEnabled|null/.test(body)) problems.push(`${file}: Zeke's Treasury answer must not lift with the custody phase`);
}

if (problems.length > 0) {
  console.error('Treasury can leave the business wallet:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Treasury stays in the business wallet: the custodial ledger is off and answers 410, an order\'s recipient is its own server-resolved wallet, and no route reads an address from the request.');
