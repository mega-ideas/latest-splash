/**
 * The accountant's export.
 *
 *   npm run csv -- --out reconciliation.csv
 *
 * One row per payment, with the commitment that ties the chains together and
 * every explorer link needed to check it. The point of the column layout is
 * that an accountant who has never heard of CCIP can still reconcile: the
 * amount, the fee, what was charged and why, and a link proving each claim.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = arg('out') ?? 'reconciliation.csv';
const demoDir = new URL('../demo/', import.meta.url).pathname;

const COLUMNS = [
  'payment_ref',
  'corridor',
  'originator',
  'beneficiary',
  'amount',
  'currency',
  'fee_charged',
  'fee_reason',
  'travel_rule_commitment',
  'sepolia_ack_tx',
  'ccip_message_id',
  'arc_release_tx',
  'sui_anchor_digest',
  'status',
] as const;

type Row = Record<(typeof COLUMNS)[number], string>;

const rows: Row[] = [];

if (existsSync(demoDir)) {
  for (const file of readdirSync(demoDir).filter((f) => f.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(demoDir + file, 'utf8'));
    const r = d.record ?? {};
    // Settlement links are filled in by the demo run; an empty cell is an
    // honest "this did not happen", never a blank that hides a failure.
    const links = d.settlement ?? {};
    const released = Boolean(links.arcReleaseTx);
    rows.push({
      payment_ref: r.paymentRef ?? '',
      corridor: r.corridor ?? '',
      originator: r.originatorName ?? '',
      beneficiary: r.beneficiaryName ?? '',
      amount: r.amount ? (Number(r.amount) / 1e6).toFixed(6) : '',
      currency: r.currency ?? '',
      fee_charged: released ? (links.feeMinor ? (Number(links.feeMinor) / 1e6).toFixed(6) : '') : '0.000000',
      fee_reason: released ? 'travel-rule proof recorded' : 'no proof recorded — refunded in full, zero fee',
      travel_rule_commitment: d.commitment ?? '',
      sepolia_ack_tx: links.sepoliaAckTx ? `https://sepolia.etherscan.io/tx/${links.sepoliaAckTx}` : '',
      ccip_message_id: links.ccipMessageId ? `https://ccip.chain.link/msg/${links.ccipMessageId}` : '',
      arc_release_tx: links.arcReleaseTx ? `https://explorer.testnet.arc.io/tx/${links.arcReleaseTx}` : '',
      sui_anchor_digest: links.suiAnchorDigest ? `https://testnet.suivision.xyz/txblock/${links.suiAnchorDigest}` : '',
      status: released ? 'Released' : (links.refundTx ? 'Refunded' : 'Open'),
    });
  }
}

const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((c) => esc(row[c] ?? '')).join(','))].join('\n');

writeFileSync(out, `${csv}\n`);
console.log(`${rows.length} payment(s) -> ${out}`);
for (const row of rows) {
  console.log(`  ${row.payment_ref.padEnd(16)} ${row.amount.padStart(12)} ${row.currency}  fee ${row.fee_charged}  ${row.status}`);
}
