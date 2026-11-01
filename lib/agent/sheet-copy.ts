/**
 * Zeke's words about a payout sheet (v2 Phase 3).
 *
 * Fixed text, Splash's own, never the model's. Zeke prepares and never sends:
 * nothing here says money moved, and tests/zeke-sheet-review.test.mjs runs
 * every string through the completion guard (lib/agent/oxwal.ts) to prove it.
 * Client-safe: no imports.
 */

export const SHEET_COPY = {
  reading: 'Reading your sheet…',
  readFailed: 'Nothing was prepared. The sheet could not be read just now.',
  title: 'Payout sheet',
  checkRows: 'Check these rows. Nothing has been prepared yet.',
  prepareButton: 'Prepare batch',
  preparing: 'Preparing…',
  dismiss: 'Dismiss',
  openBatchPayouts: 'Open Batch payouts',
  confirmLabel: 'I have checked the rows marked Check and want to prepare this batch anyway.',
  blockedHelp: 'A batch is signed once, so every row in it must be clear. Fix the sheet or remove the rows marked Cannot be paid, then attach it again.',
  readyHelp: 'Every row is clear. Press Prepare batch and the owners are asked to sign it.',
  readyHelpStaff: 'Every row is clear. Press Prepare batch and the owners are told it is waiting.',
  stateReady: 'Clear',
  stateConfirm: 'Check',
  stateBlocked: 'Cannot be paid',

  // Flags on a row.
  not_verified: 'Not a verified recipient. It cannot be paid until it is saved in Recipients and Splash has screened it.',
  currency_not_usdc: 'Batches pay USDC only.',
  repeat_of_earlier_batch: 'This payment is already in a batch you made. Check that you mean to repeat it.',
  new_payee: 'A business on Splash that nobody on your team has saved. Check its name and country before you go on.',
  inside_rule: 'Fits your spending rule. A batch is still signed by your owners.',

  // Notes on the whole sheet.
  short_of_funds: 'The wallet holds less than this batch and its fees need. Add funds, or remove rows.',
  balance_unknown: 'The wallet balance could not be read just now, so Splash cannot say whether it covers this batch.',
  rule_unavailable: 'Your spending rule could not be checked here, so every row waits for your owners.',
  staff_batch: 'A batch waits for your owners. Rows outside your rule say why.',
  mapped_by_assistant: 'Zeke matched the columns by their names. It read no cell to do it.',
  ignored_columns: 'Columns that were not used:',
} as const;

export type SheetCopyKey = keyof typeof SHEET_COPY;

/** What Zeke says once a batch is prepared. It never says the money moved. */
export function preparedLine(input: { role: string; rowCount: number }): string {
  const n = Math.max(0, Math.floor(input.rowCount));
  const payments = `${n} ${n === 1 ? 'payment' : 'payments'}`;
  if (input.role === 'OWNER') {
    return `Prepared ${payments} for signing. Nothing has been sent. The owners sign it once, in Batch payouts.`;
  }
  return `Prepared ${payments}. Nothing has been sent. Your owners have been told, and one of them starts the signatures in Batch payouts.`;
}
