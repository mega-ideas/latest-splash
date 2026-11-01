/**
 * Zeke reads a payout sheet (v2 Phase 3).
 *
 * A person attaches a CSV, a spreadsheet or pastes rows. This is what comes
 * back: a plain table the person checks, row by row, before anything is made.
 *
 *   1. The sheet is read by the server, by fixed rules (lib/batch/ingest.ts).
 *      The file is data; a model may only help name the columns.
 *   2. Every row goes through the SAME review Batch payouts uses
 *      (`reviewBatch`): a recipient this business saved and Splash has
 *      screened, the fee from the schedule on chain, duplicates, the wallet's
 *      own balance. A row whose recipient is not a verified recipient cannot
 *      be paid until it is verified.
 *   3. For a staff member, each row is also judged by the person's spending
 *      rule, with the function Transfer uses (`approvalPlan`). A batch is
 *      signed by the owners whatever the rule says, so this marks the rows;
 *      it does not move them.
 *
 * Nothing is stored and nothing is asked of anyone here. Preparing is the
 * wallet batch flow's own `createBatch`, called by the person's Prepare button
 * with the rows this returns: an owner's batch becomes one signing request for
 * the owners, a staff member's waits for an owner. Zeke never sends, never
 * approves, and its words say so (lib/agent/sheet-copy.ts).
 *
 * Every read takes the business from the caller (the session), never from the
 * sheet: another business's recipients read as absent.
 */
import { ZEKE_LIMITATION_TEXT } from '../agent/oxwal.ts';
import { SHEET_COPY } from '../agent/sheet-copy.ts';
import { ingestSheet, safeFileName, toSheetRows, type ColumnMapper, type IngestInput } from '../batch/ingest.ts';
import { PROBLEM_TEXT } from '../batch/sheet.ts';
import { formatUsdc } from '../fees/copy.ts';
import { approvalPlan, approvalReasonLines, type PlanPayee, type PolicyFacts, type StaffRuleFacts } from '../transfer/plan.ts';
import { reviewBatch, type BatchDeps, type RowReview } from './wallet-batches.ts';
import { readStaffRule } from './spend-rules.ts';
import { TRANSFER_SETTLE_WINDOW_MS } from './wallet-transfers.ts';

export type SheetFlag = {
  code: string;
  /** blocked: the batch cannot be made with this row. confirm: the person must say yes. owners: this row goes to the owners, as the rule says. note: for information. */
  severity: 'blocked' | 'confirm' | 'owners' | 'note';
  text: string;
  /** The reason in the review's own words, when it adds to the fixed text. */
  detail?: string;
};

export type SheetCardRow = {
  line: number;
  /** As cleaned: what was written, without links, formulas or hidden characters. */
  recipient: string;
  amount: string;
  currency: string;
  reference: string;
  state: 'ready' | 'confirm' | 'blocked';
  payee: { name: string; masked: string; kind: 'splash_business' | 'self_custody'; country: string | null } | null;
  feeMinor: string | null;
  flags: SheetFlag[];
};

export type SheetCard = {
  fileName: string | null;
  source: 'file' | 'pasted';
  mappedBy: 'headers' | 'positions' | 'assistant';
  ignoredColumns: string[];
  rows: SheetCardRow[];
  readyCount: number;
  confirmCount: number;
  blockedCount: number;
  totalMinor: string;
  feeMinor: string;
  /** Exactly the fee shown: it goes back with the batch as its bound. */
  maxFeeMinor: string;
  totalDebitMinor: string;
  balance: { state: 'ok'; usdcMinor: string; shortByMinor: string; heldMinor: string } | { state: 'unknown' };
  /** No row is blocked, the wallet covers it, and there is at least one row. Rows to check still need the person's yes. */
  ready: boolean;
  needsConfirmation: boolean;
  notes: SheetFlag[];
  /** An owner's batch goes straight to the owners' signatures; a staff member's waits for an owner to start them. */
  goesTo: 'owners_sign' | 'owners_start';
  /** Zeke's limit, said before anything is prepared. */
  limit: string;
  /** Exactly what goes on to the wallet batch flow. */
  sheet: Array<{ recipient: string; amount: string; reference: string }>;
};

export type SheetFailure = { ok: false; status: number; code: string; error: string };

export type StaffFacts = { rule: StaffRuleFacts | null; policy: PolicyFacts | null; runningTotals: Record<string, string> };
export type RuleFactsReader = () => Promise<StaffFacts | null>;

const PROBLEM_CODES = new Set(Object.keys(PROBLEM_TEXT));
const OWN_TEXT_CODES = new Set(['duplicate_row', 'own_wallet', 'splash_controlled_address', 'not_payable_in_a_batch', 'use_payout_route', 'too_many_rows', 'empty_sheet']);

/** The business's own chain client for spending rules, read for this person. Null when there is none or it cannot be read: no rule is ever made up. */
export async function liveRuleFacts(deps: BatchDeps, actor: { userId: string }): Promise<StaffFacts | null> {
  const sc = typeof deps.spend === 'function' ? await deps.spend() : (deps.spend ?? null);
  if (!sc || sc.orgId !== deps.orgId) return null;
  try {
    const read = await readStaffRule(sc, { addresses: await deps.requesterAddresses(actor.userId) });
    return read.ok ? read.read.facts : null;
  } catch {
    return null;
  }
}

const usdc = (minor: string | bigint) => `${formatUsdc(BigInt(minor))} USDC`;

function reviewFlags(rv: RowReview): SheetFlag[] {
  if (rv.ok) return [];
  const code = rv.code ?? 'row_error';
  if (PROBLEM_CODES.has(code)) return [{ code, severity: 'blocked', text: rv.error ?? PROBLEM_TEXT[code as keyof typeof PROBLEM_TEXT] }];
  if (OWN_TEXT_CODES.has(code)) return [{ code, severity: 'blocked', text: rv.error ?? 'This row cannot be paid.' }];
  // A recipient that is not saved, not found, ambiguous, not screened clear, or whose wallet is not proven: not a verified recipient.
  return [{ code: 'not_verified', severity: 'blocked', text: SHEET_COPY.not_verified, ...(rv.error ? { detail: rv.error } : {}) }];
}

export async function readSheetForZeke(
  deps: BatchDeps,
  actor: { userId: string; role: string },
  input: IngestInput,
  opts: { source: 'file' | 'pasted'; fileName?: string | null; mapColumns?: ColumnMapper | null; ruleFacts?: RuleFactsReader | null },
): Promise<{ ok: true; card: SheetCard } | SheetFailure> {
  if (actor.role !== 'OWNER' && actor.role !== 'MAKER' && actor.role !== 'APPROVER') {
    return { ok: false, status: 403, code: 'cannot_pay', error: 'Viewers can look at payments but cannot make them.' };
  }
  const read = await ingestSheet(input, { mapColumns: opts.mapColumns ?? null });
  if (!read.ok) return { ok: false, status: read.code === 'too_large' ? 413 : 422, code: read.code, error: read.error };

  const sheet = toSheetRows(read.rows);
  const reviewed = await reviewBatch(deps, actor, sheet);
  if (!reviewed.ok) return { ok: false, status: reviewed.status, code: reviewed.code, error: reviewed.error };
  const { review } = reviewed;

  const owner = actor.role === 'OWNER';
  const facts = owner ? null : opts.ruleFacts === undefined ? await liveRuleFacts(deps, actor) : opts.ruleFacts ? await opts.ruleFacts() : null;
  const notes: SheetFlag[] = [];
  if (!owner) {
    notes.push({ code: 'staff_batch', severity: 'note', text: SHEET_COPY.staff_batch });
    if (!facts) notes.push({ code: 'rule_unavailable', severity: 'note', text: SHEET_COPY.rule_unavailable });
  }

  const nowMs = deps.now().getTime();
  let spenderMinor = 0n;
  const rows: SheetCardRow[] = read.rows.map((ing, i) => {
    const rv = review.rows[i];
    const flags: SheetFlag[] = [];
    for (const n of ing.notes) flags.push({ code: n.code, severity: 'note', text: n.text });
    for (const p of ing.problems) flags.push({ code: p.code, severity: 'blocked', text: p.text });
    // A row the cells already refuse has its reasons; the review adds the recipient's.
    if (ing.problems.length === 0) flags.push(...reviewFlags(rv));
    if (rv.ok) {
      if (rv.duplicateOf) flags.push({ code: 'repeat_of_earlier_batch', severity: 'confirm', text: SHEET_COPY.repeat_of_earlier_batch });
      if (rv.newPayee && rv.payee) {
        flags.push({ code: 'new_payee', severity: 'confirm', text: SHEET_COPY.new_payee, detail: `${rv.payee.name}${rv.payee.country ? `, ${rv.payee.country}` : ''}` });
      }
      if (facts && rv.payee) {
        const amountMinor = BigInt(rv.amountMinor as string);
        const feeMinor = BigInt(rv.feeMinor as string);
        const payee: PlanPayee = rv.payee.kind === 'splash_business' ? { kind: 'splash_business', address: rv.payee.address } : { kind: 'wallet', wallet: 'self_custody', address: rv.payee.address };
        const counted = facts.runningTotals[rv.payee.address.toLowerCase()];
        const inFlight = { spenderMinor, recipientMinor: 0n };
        const plan = approvalPlan({
          role: actor.role,
          amountMinor,
          feeMinor,
          payee,
          rule: facts.rule,
          policy: facts.policy,
          runningTotalMinor: counted ? BigInt(counted) : 0n,
          asset: 'USDC',
          nowMs: BigInt(nowMs),
          settleByMs: BigInt(nowMs + TRANSFER_SETTLE_WINDOW_MS),
          inFlight,
        });
        if (plan.route === 'staff_rule') {
          spenderMinor += amountMinor + feeMinor;
          flags.push({ code: 'inside_rule', severity: 'note', text: SHEET_COPY.inside_rule });
        } else if (plan.route === 'ask_owners') {
          const lines = approvalReasonLines(plan, { rule: facts.rule, policy: facts.policy, amountMinor, feeMinor, inFlight, nowMs });
          plan.reasons.forEach((reason, at) => flags.push({ code: `rule_${reason}`, severity: 'owners', text: lines[at] ?? reason }));
        }
      }
    }
    const state: SheetCardRow['state'] = flags.some((f) => f.severity === 'blocked') || !rv.ok ? 'blocked' : flags.some((f) => f.severity === 'confirm') ? 'confirm' : 'ready';
    return {
      line: ing.line,
      recipient: ing.recipient,
      amount: ing.amount,
      currency: ing.currency,
      reference: ing.reference,
      state,
      payee: rv.ok && rv.payee ? { name: rv.payee.name, masked: rv.payee.masked, kind: rv.payee.kind, country: rv.payee.country } : null,
      feeMinor: rv.feeMinor,
      flags,
    };
  });

  let short = false;
  if (review.balance.state === 'ok' && BigInt(review.balance.shortByMinor) > 0n) {
    short = true;
    notes.push({ code: 'short_of_funds', severity: 'blocked', text: SHEET_COPY.short_of_funds, detail: `Short by ${usdc(review.balance.shortByMinor)}.` });
  } else if (review.balance.state === 'unknown') {
    notes.push({ code: 'balance_unknown', severity: 'note', text: SHEET_COPY.balance_unknown });
  }
  if (read.mappedBy === 'assistant') notes.push({ code: 'mapped_by_assistant', severity: 'note', text: SHEET_COPY.mapped_by_assistant });

  const blockedCount = rows.filter((r) => r.state === 'blocked').length;
  const confirmCount = rows.filter((r) => r.state === 'confirm').length;
  const card: SheetCard = {
    fileName: safeFileName(opts.fileName),
    source: opts.source,
    mappedBy: read.mappedBy,
    ignoredColumns: read.ignoredColumns,
    rows,
    readyCount: rows.filter((r) => r.state === 'ready').length,
    confirmCount,
    blockedCount,
    totalMinor: review.totalMinor,
    feeMinor: review.feeMinor,
    maxFeeMinor: review.maxFeeMinor,
    totalDebitMinor: review.totalDebitMinor,
    balance: review.balance,
    ready: blockedCount === 0 && rows.length > 0 && !short,
    needsConfirmation: confirmCount > 0,
    notes,
    goesTo: owner ? 'owners_sign' : 'owners_start',
    limit: ZEKE_LIMITATION_TEXT.BATCH,
    sheet: sheet.map((r) => ({ recipient: r.recipient, amount: r.amount, reference: r.reference })),
  };
  return { ok: true, card };
}

/**
 * The rows alone, for the Batch payouts page: the same reader and the same
 * rules, without the review (the page runs its own on the next step). Rows
 * that are wrong are passed on as they are so the review can say why.
 */
export async function readSheetRows(
  actor: { role: string },
  input: IngestInput,
  opts: { mapColumns?: ColumnMapper | null },
): Promise<
  | { ok: true; rows: Array<{ line: number; recipient: string; amount: string; reference: string }>; notes: Array<{ line: number; text: string }>; mappedBy: SheetCard['mappedBy']; ignoredColumns: string[] }
  | SheetFailure
> {
  if (actor.role !== 'OWNER' && actor.role !== 'MAKER' && actor.role !== 'APPROVER') {
    return { ok: false, status: 403, code: 'cannot_pay', error: 'Viewers can look at payments but cannot make them.' };
  }
  const read = await ingestSheet(input, { mapColumns: opts.mapColumns ?? null });
  if (!read.ok) return { ok: false, status: read.code === 'too_large' ? 413 : 422, code: read.code, error: read.error };
  return {
    ok: true,
    rows: toSheetRows(read.rows),
    notes: read.rows.flatMap((r) => r.notes.map((n) => ({ line: r.line, text: `Row ${r.line}: ${n.text}` }))),
    mappedBy: read.mappedBy,
    ignoredColumns: read.ignoredColumns,
  };
}
