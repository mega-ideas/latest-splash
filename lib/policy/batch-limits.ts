/**
 * Batch size ceiling and gas sizing (audit finding: unbounded batch).
 *
 * The v1 testnet custody batch (`settlement::settle_batch`, now
 * `settle_sui_batch_delegated`; custody is retired from mainnet) loops the
 * caller's `vector<Payment>`, and each
 * iteration emits a `PaymentExecuted` event AND creates a new `Coin` object via
 * `public_transfer`. Sui caps a transaction at 1024 emitted events and 1024
 * programmable-transaction commands, and the server was sending any row count
 * under a FLAT 10_000_000 MIST budget — the smallest of any settlement path in
 * the file, while the composed single-transfer path uses 30_000_000 and the
 * e2e script uses 30_000_000 for a TWO-row batch of the same shape.
 *
 * So a large payroll failed atomically on gas. Nothing was lost, but the
 * product's headline feature broke on correctly-funded, correctly-priced input.
 */

/**
 * Must match `MAX_BATCH_ROWS` in `move/splash_custody/sources/settlement.move`.
 *
 * 256 leaves ~4x headroom under Sui's 1024-event and 1024-command ceilings
 * (one `new_payment` command and one `PaymentExecuted` event per row, plus the
 * peg refresh and settle call).
 */
export const MAX_BATCH_ROWS = 256;

/** Base cost: peg refresh + DeepBook reads + the settle call itself. */
const BASE_GAS_MIST = 30_000_000;
/**
 * Per row: one created Coin object's storage plus the event. Sui charges
 * storage on object creation with no rebate here, since nothing is deleted.
 */
const PER_ROW_GAS_MIST = 3_000_000;

/**
 * Gas budget for a batch of `rowCount` rows. Scaling with row count is the
 * point — the previous flat budget was exhausted at single-digit row counts.
 */
export function batchGasBudgetMist(rowCount: number, override?: string | null): string {
  const explicit = (override ?? '').trim();
  if (explicit && /^\d+$/.test(explicit)) return explicit;
  const rows = Number.isFinite(rowCount) && rowCount > 0 ? Math.ceil(rowCount) : 1;
  return String(BASE_GAS_MIST + rows * PER_ROW_GAS_MIST);
}

export type BatchSizeCheck =
  | { ok: true }
  | { ok: false; code: 'batch_too_large'; message: string; maxRows: number };

export function checkBatchSize(rowCount: number): BatchSizeCheck {
  if (rowCount <= MAX_BATCH_ROWS) return { ok: true };
  return {
    ok: false,
    code: 'batch_too_large',
    message:
      `This run has ${rowCount} payable rows; a single settlement carries at most ${MAX_BATCH_ROWS}. ` +
      'Split it into smaller runs — the limit exists because Sui caps a transaction at 1024 events and ' +
      '1024 commands, and each row costs one of each.',
    maxRows: MAX_BATCH_ROWS,
  };
}
