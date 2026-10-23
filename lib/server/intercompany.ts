import { MICRO_DECIMALS, formatMinor, parseMinor } from '../money.ts';
// lib/server/intercompany.ts
// Tracks intercompany USD transfers from Splash US → Splash Labuan
// and Labuan settlement confirmations for audit trail.

export type IntercompanyState =
  | 'INITIATED'
  | 'FX_CONFIRMED'
  | 'USD_SENT'       // USD transferred to Maybank Labuan
  | 'USD_RECEIVED'   // Splash Labuan confirms USD receipt
  | 'USDC_ACQUIRED'  // Splash Labuan has acquired USDC
  | 'SETTLED'        // USDC settled on Sui
  | 'FAILED';

export interface IntercompanyRecord {
  id: string;
  transferIntentId: string;    // links to operations.ts TransferIntentRecord
  amountUsd: string;
  amountUsdc: string;
  usdToUsdcRate: string;
  maybankRef: string;          // Maybank intercompany transfer reference
  labuanSettlementId: string;  // Splash Labuan's internal settlement ID
  state: IntercompanyState;
  createdAt: string;
  updatedAt: string;
}

type IntercompanyStore = Map<string, IntercompanyRecord & { orgId?: string }>;
const globalStore = globalThis as typeof globalThis & { splashIntercompany?: IntercompanyStore };
/**
 * The in-process fallback, used only when `DATABASE_URL` is not set so that
 * `npm run dev` works without a database. Every deployed environment reads and
 * writes `intercompany_transfers` (migration 0029). This map was the only
 * store until WS8, so each serverless instance reconciled its own slice of
 * the day and a cold start reconciled nothing.
 */
const intercompanyStore = globalStore.splashIntercompany ?? new Map<string, IntercompanyRecord & { orgId?: string }>();
globalStore.splashIntercompany = intercompanyStore;

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[intercompany] DATABASE_URL is not set, so intercompany transfers live in ' +
        'this process and disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

async function repo() {
  return import('./repository/intercompany.ts');
}

function uid() {
  return `ic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createIntercompanyTransfer(input: {
  /** The org whose customer transfer this leg funds. */
  orgId: string;
  transferIntentId: string;
  amountUsd: string;
  usdToUsdcRate: string;
}): Promise<IntercompanyRecord> {
  const now = new Date().toISOString();
  const record: IntercompanyRecord & { orgId: string } = {
    id: uid(),
    orgId: input.orgId,
    transferIntentId: input.transferIntentId,
    amountUsd: input.amountUsd,
    amountUsdc: '0',
    usdToUsdcRate: input.usdToUsdcRate,
    maybankRef: '',
    labuanSettlementId: '',
    state: 'INITIATED',
    createdAt: now,
    updatedAt: now,
  };
  if (!usingPostgres()) {
    intercompanyStore.set(record.id, record);
    return record;
  }
  // One leg per customer transfer is a unique index: a second leg would send
  // the USD twice.
  return (await repo()).insertIntercompany(await db(), record);
}

export async function updateIntercompany(id: string, patch: Partial<IntercompanyRecord>): Promise<void> {
  if (!usingPostgres()) {
    const record = intercompanyStore.get(id);
    if (!record) return;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    intercompanyStore.set(id, record);
    return;
  }
  await (await repo()).patchIntercompany(await db(), id, patch);
}

export async function getIntercompanyByTransfer(transferIntentId: string): Promise<IntercompanyRecord | null> {
  if (!usingPostgres()) {
    for (const record of intercompanyStore.values()) {
      if (record.transferIntentId === transferIntentId) return record;
    }
    return null;
  }
  return (await repo()).getByTransfer(await db(), transferIntentId);
}

export async function listIntercompanyTransfers(): Promise<IntercompanyRecord[]> {
  if (!usingPostgres()) {
    return [...intercompanyStore.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
  return (await repo()).listIntercompany(await db());
}

/**
 * Daily reconciliation: sum USD in, USDC settled.
 * Returns discrepancy if any.
 */
/**
 * Daily reconciliation: USD paid in against USDC settled out, and the gap
 * between them.
 *
 * The gap is the point of the function — it should be fees and nothing else,
 * so anything unexplained is a signal. Summing the legs as floats put float
 * error into that signal: a hundred rows of "0.10" summed as doubles is
 * 9.999999999999998, and a discrepancy of 2e-15 is indistinguishable from a
 * real one-microunit break at a glance. Both legs are integer micro units
 * now, so a non-zero discrepancy means something actually did not balance.
 *
 * Totals are returned as both minor units and formatted strings: the bigint
 * is what a caller should compare or accumulate, the string is what it should
 * display, and neither invites a float back in.
 */
export async function getDailyReconciliation(dateStr?: string): Promise<{
  date: string;
  totalUsdInMicro: bigint;
  totalUsdcSettledMicro: bigint;
  totalUsdIn: string;
  totalUsdcSettled: string;
  transferCount: number;
  discrepancyMicro: bigint;
  discrepancy: string;
}> {
  const targetDate = dateStr ?? new Date().toISOString().split('T')[0];
  let totalUsdMicro = 0n;
  let totalUsdcMicro = 0n;
  let count = 0;

  if (usingPostgres()) {
    // Every instance's legs for the day, not this instance's. Already integer
    // micro units in the row, so nothing is parsed back out of a string.
    for (const row of await (await repo()).listForDay(await db(), targetDate)) {
      totalUsdMicro += row.amountUsdMicro;
      totalUsdcMicro += row.amountUsdcMicro;
      count++;
    }
  } else {
    for (const record of intercompanyStore.values()) {
      if (record.createdAt.startsWith(targetDate)) {
        totalUsdMicro += parseMinor(record.amountUsd, MICRO_DECIMALS);
        totalUsdcMicro += parseMinor(record.amountUsdc, MICRO_DECIMALS);
        count++;
      }
    }
  }

  // USD out minus USDC in. Near zero by design; the remainder is fees.
  const delta = totalUsdMicro - totalUsdcMicro;
  const discrepancyMicro = delta < 0n ? -delta : delta;

  return {
    date: targetDate,
    totalUsdInMicro: totalUsdMicro,
    totalUsdcSettledMicro: totalUsdcMicro,
    totalUsdIn: formatMinor(totalUsdMicro, MICRO_DECIMALS),
    totalUsdcSettled: formatMinor(totalUsdcMicro, MICRO_DECIMALS),
    transferCount: count,
    discrepancyMicro,
    discrepancy: formatMinor(discrepancyMicro, MICRO_DECIMALS),
  };
}
