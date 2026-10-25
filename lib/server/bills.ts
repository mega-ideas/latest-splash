/**
 * Pay invoices (v2 brief 5.8): the server side of a supplier invoice, from
 * intake to the self-billed e-invoice. The routes in app/api/bills/* are thin
 * wrappers; everything they do is here, with its dependencies injected, so
 * tests drive it against a real (PGlite) database with nothing on a network.
 *
 * The invoice is untrusted data (lib/bills/extract.ts). What it says is a
 * proposal; a person confirms every field, the recipient is one the business
 * already verified (lib/bills/match.ts), and the payment goes to that
 * recipient as stored, for the amount the person confirmed.
 *
 * Approving and paying is the payment flow's (brief 5.4), reached through
 * lib/bills/payment-hook.ts. It is not wired on this branch, and then the
 * approve step refuses with PAYMENT_FLOW_NOT_WIRED and changes nothing.
 *
 * Who is paid is the recipient, not the name typed: the duplicate check and
 * its unique index (0058) are keyed on the recipient too, a recipient whose
 * name is unlike the confirmed supplier needs a written reason, a changed
 * supplier clears the match, and a recipient whose wallet is one of Splash's
 * own is never matched or paid. A step that checked the invoice and then
 * writes refuses when the invoice changed in between.
 *
 * Scope (WS2): the org is the caller's, from the session; every read and
 * write is scoped to it; another org's invoice is "not found".
 * Idempotency: intake by the client's key (unique per org) and by the
 * document's hash; the hand-off by the invoice id (one invoice, one intent);
 * settlement by the intent and the Sui digest (each unique); the e-invoice is
 * made once per invoice.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { UserRole } from '../agent/types.ts';
import { formatMicros, fromMicros, normalizeAmount, toMicros } from '../bills/amount.ts';
import { findDuplicates, invoiceNumberKey, payeeKey, type DuplicateCandidate } from '../bills/duplicates.ts';
import {
  BILL_CURRENCIES,
  COUNTRY_CODES,
  groundReading,
  parseBillText,
  readDate,
  type BillExtraction,
  type ModelReading,
} from '../bills/extract.ts';
import { BILL_STATUS_LABEL, billSteps, scheduleBlockers, type BillFacts } from '../bills/flow.ts';
import { maskDestination, matchRecipients, paymentDetailsDiffer, recipientBlock, recipientVerified, type RecipientLite } from '../bills/match.ts';
import { HANDOFF_CURRENCIES, type BillPaymentFlow } from '../bills/payment-hook.ts';
import { suiScanTxUrlOn, type SuiNetworkName } from '../explorer.ts';
import {
  MYINVOIS_PORTAL_URL,
  SELF_BILLED_CLASSIFICATIONS,
  buildSelfBilledInvoice,
  selfBilledProblems,
  type SelfBilledClassification,
  type SelfBilledInput,
} from '../myinvois/self-billed.ts';
import {
  insertBill,
  listBills,
  noEInvoiceYet,
  readBill,
  readBillByIntake,
  readBillByIntent,
  readOpenBillByDocument,
  eInvoiceStill,
  unchangedSince,
  updateBillIf,
  type BillRow,
  type BillsDb,
} from './bills-store.ts';

export type BillCaller = { orgId: string; userId: string; role: UserRole };
export type Answer = { status: number; body: Record<string, unknown> };

/** Who may bring in, check, match, schedule and send an invoice for approval. Viewers, auditors and developers read. */
export const BILL_WRITE_ROLES: readonly UserRole[] = ['OWNER', 'FINANCE_ADMIN', 'APPROVER', 'MAKER'];
export function mayWriteBills(role: UserRole): boolean {
  return BILL_WRITE_ROLES.includes(role);
}

export type BusinessFacts = {
  name: string;
  legalName: string | null;
  registrationNumber: string | null;
  addressLine1: string | null;
  addressCity: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
};

/** Zeke's reading of an invoice: field name to what it read, and the payment details it prints. Null when it read nothing. */
export type ModelReader = (input: { text?: string; pdfBase64?: string }) => Promise<ModelReading | null>;

export type BillDeps = {
  /** Null when this server has no model: the parser reads text alone, and a PDF is refused. */
  modelReader: ModelReader | null;
  /** The org's own recipients, and only those. */
  listRecipients: (orgId: string) => Promise<RecipientLite[]>;
  readBusiness: (orgId: string) => Promise<BusinessFacts | null>;
  paymentFlow: BillPaymentFlow;
  /** A USDC-only launch pays no bank recipient. */
  stablecoinOnly: () => boolean;
  /**
   * Splash's own addresses (the operator, the treasury, the fee recipient):
   * a supplier invoice is never paid to one. Throws when they cannot be
   * read, and then nothing is matched or handed off: an unreadable list is
   * not an empty one.
   */
  splashOwnedAddresses: () => Promise<string[]>;
  now?: () => Date;
};

const INTAKE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUI_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY_MS = 86_400_000;
const E_INVOICE_FRESH_MS = 72 * 3_600_000;

/** When the payment flow reports no network: the one this server runs on. */
function serverNetwork(): SuiNetworkName {
  return process.env.SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
}

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error, ...extra } });
const forbidden = (role: UserRole): Answer => refuse(403, `A ${role.toLowerCase().replace('_', ' ')} can read invoices but not change them.`, { code: 'role' });

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function entry(caller: { userId: string }, at: Date, action: string, note?: string) {
  return { at: at.toISOString(), by: caller.userId, action, ...(note ? { note } : {}) };
}

function candidate(row: BillRow): DuplicateCandidate {
  return {
    id: row.id,
    status: row.status,
    payeeKey: row.payeeKey,
    invoiceNumberKey: row.invoiceNumberKey,
    recipientId: row.recipientId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    invoiceDate: row.invoiceDate,
    createdAt: row.createdAt,
  };
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── The view the page reads ────────────────────────────────────────────────

export function billFacts(row: BillRow, ctx: { recipients: RecipientLite[]; others: BillRow[] }): BillFacts & { findings: ReturnType<typeof findDuplicates>; recipient: RecipientLite | null } {
  const findings = row.payeeKey || row.recipientId ? findDuplicates(candidate(row), ctx.others.map(candidate)) : [];
  const recipient = row.recipientId ? ctx.recipients.find((r) => r.id === row.recipientId) ?? null : null;
  const inReview = row.status === 'review';
  return {
    status: row.status,
    confirmed: row.confirmedAt !== null,
    sameNumber: inReview && findings.some((f) => f.kind === 'same_number'),
    sameAmount: inReview && findings.some((f) => f.kind === 'same_amount'),
    duplicateAcknowledged: row.duplicateAckAt !== null,
    recipientMatched: recipient !== null,
    recipientVerified: recipient !== null && recipientVerified(recipient),
    recipientOwnershipUnproven: recipient !== null && recipientBlock(recipient) === 'ownership_unproven',
    scheduled: row.scheduledFor !== null,
    foreignSupplier: row.payeeCountry !== null && row.payeeCountry !== 'MY',
    eInvoiceMade: row.myinvois !== null,
    findings,
    recipient,
  };
}

export function billView(row: BillRow, ctx: { recipients: RecipientLite[]; others: BillRow[] }, detail = false) {
  const { findings, recipient, ...facts } = billFacts(row, ctx);
  const payee = row.payeeName ?? row.extraction.fields.payee.value;
  return {
    id: row.id,
    status: row.status,
    statusLabel: BILL_STATUS_LABEL[row.status],
    documentName: row.documentName,
    ...(detail ? { documentText: row.documentText } : {}),
    extraction: row.extraction,
    payee,
    confirmed: row.confirmedAt ? {
      payee: row.payeeName,
      invoiceNumber: row.invoiceNumber,
      amount: row.amountMinor !== null ? fromMicros(row.amountMinor) : null,
      amountDisplay: row.amountMinor !== null && row.currency ? formatMicros(row.amountMinor, row.currency) : null,
      currency: row.currency,
      dueDate: row.dueDate,
      invoiceDate: row.invoiceDate,
      payeeCountry: row.payeeCountry,
      by: row.confirmedBy,
      at: row.confirmedAt.toISOString(),
    } : null,
    duplicates: findings,
    duplicateAck: row.duplicateAckAt ? { by: row.duplicateAckBy, reason: row.duplicateAckReason, at: row.duplicateAckAt.toISOString() } : null,
    recipient: recipient ? {
      id: recipient.id,
      name: recipient.name,
      country: recipient.country,
      payoutMethod: recipient.payoutMethod,
      verified: recipientVerified(recipient),
      blocked: recipientBlock(recipient),
      destination: maskDestination(recipient),
    } : null,
    recipientMissing: row.recipientId !== null && recipient === null,
    /** The recipient's name is not the confirmed supplier's, reduced. The reason a person gave is beside it. */
    recipientNameDiffers: recipient !== null && !nameMatches(row.payeeName ?? payee, recipient),
    matchReason: row.matchReason,
    /** USDC pays USD one for one; anything else needs a rate quote before it is handed off. */
    needsRateQuote: row.currency !== null && !HANDOFF_CURRENCIES.includes(row.currency),
    matches: row.status === 'review'
      ? matchRecipients(payee, ctx.recipients).slice(0, 5).map((m) => ({
        id: m.recipient.id,
        name: m.recipient.name,
        country: m.recipient.country,
        payoutMethod: m.recipient.payoutMethod,
        verified: m.verified,
        blocked: recipientBlock(m.recipient),
        exact: m.exact,
        destination: maskDestination(m.recipient),
      }))
      : [],
    /** Verified recipients the supplier's name does not suggest: choosing one needs a written reason. */
    otherRecipients: row.status === 'review'
      ? (() => {
        const suggested = new Set(matchRecipients(payee, ctx.recipients).map((m) => m.recipient.id));
        return ctx.recipients
          .filter((r) => recipientVerified(r) && !suggested.has(r.id))
          .slice(0, 20)
          .map((r) => ({ id: r.id, name: r.name, country: r.country, payoutMethod: r.payoutMethod, destination: maskDestination(r) }));
      })()
      : [],
    paymentDetailsDiffer: recipient ? paymentDetailsDiffer(row.extraction.paymentDetails, recipient) : false,
    facts,
    steps: billSteps(facts),
    blockers: row.status === 'review' ? scheduleBlockers(facts) : [],
    scheduledFor: row.scheduledFor,
    approval: row.paymentIntentId ? { paymentIntentId: row.paymentIntentId, requestedBy: row.approvalRequestedBy, at: row.approvalRequestedAt?.toISOString() ?? null } : null,
    paid: row.status === 'paid' && row.paidAt ? {
      at: row.paidAt.toISOString(),
      suiDigest: row.suiDigest,
      receiptNo: row.receiptNo,
      approvers: row.approvers ?? [],
      network: (row.suiNetwork as SuiNetworkName | null) ?? null,
      verifyUrl: row.suiDigest ? suiScanTxUrlOn((row.suiNetwork as SuiNetworkName | null) ?? serverNetwork(), row.suiDigest) : null,
    } : null,
    eInvoice: row.myinvois ? {
      sha256: row.myinvoisSha256,
      generatedAt: row.myinvoisGeneratedAt?.toISOString() ?? null,
      fileName: `${row.receiptNo ?? row.id}-self-billed.json`,
    } : null,
    history: row.history,
    createdAt: row.createdAt.toISOString(),
  };
}
export type BillView = ReturnType<typeof billView>;

/** The recipient carries the confirmed supplier's name, reduced: exact, not merely alike. */
function nameMatches(payee: string, recipient: RecipientLite): boolean {
  return matchRecipients(payee, [recipient]).some((m) => m.exact);
}

/** `0x` + 64 lower-case hex, or null: "0x5" and "0x00…05" are one address. */
function suiAddress(value: string): string | null {
  const m = /^(?:0x)?([0-9a-f]{1,64})$/i.exec(value.trim());
  return m ? `0x${m[1].toLowerCase().padStart(64, '0')}` : null;
}

/** True when this recipient's wallet is one of Splash's own; throws when they cannot be read. */
async function paysSplash(recipient: RecipientLite, deps: BillDeps): Promise<boolean> {
  if (!recipient.walletAddress) return false;
  const own = new Set((await deps.splashOwnedAddresses()).map(suiAddress).filter((a): a is string => a !== null));
  const wallet = suiAddress(recipient.walletAddress);
  return wallet !== null && own.has(wallet);
}

const SPLASH_ADDRESS = 'That recipient’s wallet is one of Splash’s own addresses, and a supplier is never paid there. Check the recipient’s details.';
const SPLASH_ADDRESSES_UNREAD = 'Splash could not check the recipient’s wallet against its own addresses just now, so nothing was changed. Try again shortly.';
const UNSCREENED = 'That recipient is not verified yet. Screening must come back clear first.';
const OWNERSHIP_UNPROVEN = 'The supplier has not proved it owns that wallet yet. A self-custody wallet is paid once the supplier signs the ownership proof.';

/** Why this recipient cannot be paid, as the answer a route gives; null when it can. */
function recipientRefusal(recipient: RecipientLite | undefined): Answer | null {
  if (!recipient) return refuse(409, 'The recipient is no longer in your list. Match the invoice again.', { code: 'recipient_unverified' });
  const block = recipientBlock(recipient);
  if (block === 'ownership_unproven') return refuse(409, OWNERSHIP_UNPROVEN, { code: 'ownership_unproven' });
  if (block === 'unscreened') return refuse(409, UNSCREENED, { code: 'recipient_unverified' });
  if (recipient.payoutMethod === 'WALLET' && !(recipient.walletAddress && suiAddress(recipient.walletAddress))) {
    return refuse(409, 'The recipient’s wallet on file is not a Sui address. Check it in Recipients.', { code: 'recipient_unverified' });
  }
  return null;
}

/**
 * The payment flow's idempotency key for this attempt at paying this
 * invoice: the same attempt at the same payment is the same key; a new
 * attempt (an intent closed or withdrawn) or a change to what is paid is a
 * new one (lib/bills/payment-hook.ts).
 */
export function billPaymentKey(row: Pick<BillRow, 'id' | 'paymentAttempt' | 'recipientId' | 'amountMinor' | 'currency' | 'scheduledFor'>): string {
  const payload = [row.id, row.paymentAttempt, row.recipientId, String(row.amountMinor), row.currency, row.scheduledFor].join('|');
  return `${row.id}:${row.paymentAttempt}:${sha256(payload).slice(0, 32)}`;
}

async function context(db: BillsDb, orgId: string, deps: BillDeps) {
  const [recipients, others] = await Promise.all([deps.listRecipients(orgId), listBills(db, orgId)]);
  return { recipients, others };
}

async function viewOf(db: BillsDb, row: BillRow, deps: BillDeps) {
  return billView(row, await context(db, row.orgId, deps), true);
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function handleBillList(db: BillsDb, caller: BillCaller, deps: BillDeps): Promise<Answer> {
  const { recipients, others } = await context(db, caller.orgId, deps);
  const business = await deps.readBusiness(caller.orgId);
  return {
    status: 200,
    body: {
      bills: others.map((row) => billView(row, { recipients, others })),
      business: business ? { name: business.legalName ?? business.name, country: business.addressCountry } : null,
      canWrite: mayWriteBills(caller.role),
      reader: deps.modelReader ? 'zeke' : 'parser',
      paymentFlowWired: deps.paymentFlow.wired,
      paymentFlowCancels: deps.paymentFlow.wired && typeof deps.paymentFlow.cancel === 'function',
    },
  };
}

export async function handleBillRead(db: BillsDb, caller: BillCaller, id: string, deps: BillDeps): Promise<Answer> {
  const row = await readBill(db, caller.orgId, id);
  if (!row) return refuse(404, 'Invoice not found.');
  return { status: 200, body: { bill: await viewOf(db, row, deps) } };
}

// ─── Intake ─────────────────────────────────────────────────────────────────

const intakeSchema = z.object({
  intakeKey: z.string().regex(INTAKE_KEY),
  documentName: z.string().trim().max(120).optional(),
  text: z.string().max(60_000).optional(),
  pdfBase64: z.string().max(7_000_000).regex(/^[A-Za-z0-9+/=\s]+$/).optional(),
});

export async function handleBillIntake(db: BillsDb, caller: BillCaller, body: unknown, deps: BillDeps): Promise<Answer> {
  if (!mayWriteBills(caller.role)) return forbidden(caller.role);
  const parsed = intakeSchema.safeParse(body);
  if (!parsed.success) return refuse(400, 'Send the invoice as text or a PDF, with an intake key.');
  const { intakeKey, documentName, pdfBase64 } = parsed.data;
  const text = parsed.data.text?.replace(/\r\n?/g, '\n').trim();
  if (!text && !pdfBase64) return refuse(400, 'The invoice is empty. Paste its text or attach the file.');
  const now = deps.now?.() ?? new Date();
  const documentSha256 = sha256(text ? `text:${text}` : `pdf:${pdfBase64!.replace(/\s/g, '')}`);

  const replay = await readBillByIntake(db, caller.orgId, intakeKey);
  if (replay) {
    return replay.documentSha256 === documentSha256
      ? { status: 200, body: { bill: await viewOf(db, replay, deps), replayed: true } }
      : refuse(409, 'That intake key was already used for a different invoice.', { code: 'intake_reused' });
  }
  const sameDocument = await readOpenBillByDocument(db, caller.orgId, documentSha256);
  if (sameDocument) {
    return { status: 200, body: { bill: await viewOf(db, sameDocument, deps), duplicate: 'same_document' } };
  }

  const business = await deps.readBusiness(caller.orgId);
  const buyerCountry = business?.addressCountry ?? null;
  let extraction: BillExtraction;
  if (pdfBase64) {
    if (!deps.modelReader) {
      return refuse(422, 'This server cannot read PDF invoices. Paste the invoice text instead.', { code: 'pdf_unreadable' });
    }
    let reading: Awaited<ReturnType<ModelReader>>;
    try {
      reading = await deps.modelReader({ pdfBase64: pdfBase64.replace(/\s/g, '') });
    } catch {
      return refuse(502, 'Zeke could not read this PDF. Paste the invoice text instead.', { code: 'pdf_unreadable' });
    }
    if (!reading) return refuse(422, 'Zeke could not read this PDF. Paste the invoice text instead.', { code: 'pdf_unreadable' });
    extraction = groundReading('', reading, parseBillText('', { buyerCountry }), 'model_pdf');
  } else {
    const parsedText = parseBillText(text!, { buyerCountry });
    let reading: Awaited<ReturnType<ModelReader>> = null;
    if (deps.modelReader) {
      // A failed model call is not a failed intake: the parser's reading stands.
      try { reading = await deps.modelReader({ text: text! }); } catch { reading = null; }
    }
    extraction = groundReading(text!, reading, parsedText, 'model');
  }

  const row = await insertBill(db, {
    orgId: caller.orgId,
    intakeKey,
    documentName: documentName || null,
    documentSha256,
    documentText: text ? text.slice(0, 20_000) : null,
    extraction,
    createdBy: caller.userId,
    at: now,
  });
  if (!row) {
    // Lost a race on the intake key or the document: answer with the winner.
    const winner = (await readBillByIntake(db, caller.orgId, intakeKey)) ?? (await readOpenBillByDocument(db, caller.orgId, documentSha256));
    if (!winner) return refuse(409, 'The invoice changed while it was being added. Try again.');
    if (winner.intakeKey === intakeKey && winner.documentSha256 !== documentSha256) {
      return refuse(409, 'That intake key was already used for a different invoice.', { code: 'intake_reused' });
    }
    return { status: 200, body: { bill: await viewOf(db, winner, deps), replayed: true } };
  }
  return { status: 201, body: { bill: await viewOf(db, row, deps) } };
}

// ─── Check, match, schedule, cancel ─────────────────────────────────────────

const confirmSchema = z.object({
  payee: z.string().trim().min(2).max(80),
  invoiceNumber: z.string().trim().min(1).max(40),
  amount: z.string().trim().min(1).max(30),
  currency: z.string().trim().toUpperCase(),
  dueDate: z.string().trim(),
  invoiceDate: z.string().trim().optional().or(z.literal('')),
  payeeCountry: z.string().trim().toUpperCase().length(2),
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), fields: confirmSchema }),
  z.object({ action: z.literal('acknowledge_duplicate'), reason: z.string().trim().min(8).max(300) }),
  z.object({ action: z.literal('match'), recipientId: z.string().trim().min(1).max(120), reason: z.string().trim().min(8).max(300).optional() }),
  z.object({ action: z.literal('schedule'), payOn: z.string().trim() }),
  z.object({ action: z.literal('unschedule') }),
  z.object({ action: z.literal('withdraw') }),
  z.object({ action: z.literal('cancel'), reason: z.string().trim().max(300).optional() }),
]);

function moved(result: Awaited<ReturnType<typeof updateBillIf>>, what: string): Answer | null {
  if (result.ok) return null;
  if (result.reason === 'not_found') return refuse(404, 'Invoice not found.');
  if (result.reason === 'unique') return refuse(409, 'This invoice number is already scheduled, waiting for approval or paid, from this supplier or to this recipient.', { code: 'duplicate_number' });
  return refuse(409, `This invoice is ${BILL_STATUS_LABEL[result.row!.status].toLowerCase()} now, so it cannot be ${what}.`, { code: 'status' });
}

/** As `moved`, and a write that met an invoice changed since it was read says so. */
function changed(result: Awaited<ReturnType<typeof updateBillIf>>, what: string): Answer | null {
  if (!result.ok && result.reason === 'status' && result.row?.status === 'review') {
    return refuse(409, `The invoice changed while it was being ${what}. Check it again.`, { code: 'changed' });
  }
  return moved(result, what);
}

export async function handleBillAction(db: BillsDb, caller: BillCaller, id: string, body: unknown, deps: BillDeps): Promise<Answer> {
  if (!mayWriteBills(caller.role)) return forbidden(caller.role);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return refuse(400, 'That is not a change this invoice takes.', { details: parsed.error.flatten().fieldErrors });
  const row = await readBill(db, caller.orgId, id);
  if (!row) return refuse(404, 'Invoice not found.');
  const now = deps.now?.() ?? new Date();
  const action = parsed.data;

  switch (action.action) {
    case 'confirm': {
      const f = action.fields;
      const amount = normalizeAmount(f.amount);
      const problems: Record<string, string> = {};
      if (!amount || amount === '0' || !/^\d+(\.\d{1,6})?$/.test(amount)) problems.amount = 'Enter the amount due, like 1250.00.';
      if (!BILL_CURRENCIES.includes(f.currency)) problems.currency = 'Choose the invoice’s currency.';
      const due = readDate(f.dueDate);
      if (!due) problems.dueDate = 'Enter the due date as YYYY-MM-DD.';
      const issued = f.invoiceDate ? readDate(f.invoiceDate) : null;
      if (f.invoiceDate && !issued) problems.invoiceDate = 'Enter the invoice date as YYYY-MM-DD, or leave it empty.';
      if (!(COUNTRY_CODES as readonly string[]).includes(f.payeeCountry)) problems.payeeCountry = 'Choose the supplier’s country.';
      if (!invoiceNumberKey(f.invoiceNumber)) problems.invoiceNumber = 'Enter the supplier’s invoice number.';
      if (!payeeKey(f.payee)) problems.payee = 'Enter the supplier’s name.';
      if (Object.keys(problems).length > 0) return refuse(422, 'Some fields need a second look.', { fields: problems });
      const amountMinor = toMicros(amount!);
      // Compared with the invoice as read, and written only onto that
      // invoice: one changed in between is checked again, so an answer given
      // for another amount never survives onto this one.
      const changedWhatMatters = row.amountMinor !== amountMinor || row.payeeKey !== payeeKey(f.payee) || row.currency !== f.currency;
      const result = await updateBillIf(db, caller.orgId, id, ['review'], {
        payeeName: f.payee,
        payeeKey: payeeKey(f.payee),
        invoiceNumber: f.invoiceNumber,
        invoiceNumberKey: invoiceNumberKey(f.invoiceNumber),
        amountMinor,
        currency: f.currency,
        dueDate: due!.iso,
        invoiceDate: issued?.iso ?? null,
        payeeCountry: f.payeeCountry,
        confirmedBy: caller.userId,
        confirmedAt: now,
        // A new amount or supplier needs its duplicate question asked again.
        ...(changedWhatMatters ? { duplicateAckBy: null, duplicateAckReason: null, duplicateAckAt: null } : {}),
        // Another supplier is another payee: the recipient is chosen again.
        ...(row.payeeKey !== null && row.payeeKey !== payeeKey(f.payee)
          ? { recipientId: null, matchedBy: null, matchedAt: null, matchReason: null }
          : {}),
      }, entry(caller, now, 'confirmed'), unchangedSince(row.updatedAt));
      return changed(result, 'confirmed') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
    case 'acknowledge_duplicate': {
      const facts = billFacts(row, await context(db, caller.orgId, deps));
      if (!facts.sameAmount) return refuse(409, 'There is no possible duplicate to answer for.');
      const result = await updateBillIf(db, caller.orgId, id, ['review'], {
        duplicateAckBy: caller.userId, duplicateAckReason: action.reason, duplicateAckAt: now,
      }, entry(caller, now, 'duplicate_acknowledged', action.reason), unchangedSince(row.updatedAt));
      return changed(result, 'answered for') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
    case 'match': {
      const recipients = await deps.listRecipients(caller.orgId);
      const recipient = recipients.find((r) => r.id === action.recipientId);
      // Another org's recipient and a missing one are the same answer.
      if (!recipient) return refuse(404, 'Recipient not found.');
      const cannotPay = recipientRefusal(recipient);
      if (cannotPay) return cannotPay;
      if (recipient.payoutMethod === 'BANK' && deps.stablecoinOnly()) {
        return refuse(403, 'Bank payouts are not open in this launch. Choose a recipient paid in USDC.', { code: 'launch_scope' });
      }
      let splash: boolean;
      try { splash = await paysSplash(recipient, deps); } catch { return refuse(503, SPLASH_ADDRESSES_UNREAD, { code: 'splash_addresses_unread' }); }
      if (splash) return refuse(409, SPLASH_ADDRESS, { code: 'splash_address' });
      if (!row.payeeName) return refuse(409, 'Check and confirm what Zeke read before choosing who is paid.', { code: 'not_confirmed' });
      // The name on the invoice picks candidates. Only the same name needs
      // no reason: a recipient whose name is merely close, or that the name
      // does not suggest at all, can still be the right one (a trading name,
      // an agent), and then a person says why, in words kept with the invoice.
      if (!nameMatches(row.payeeName, recipient) && !action.reason) {
        return refuse(409, `${recipient.name} is not the name of the supplier on this invoice. Say why this recipient is paid for it.`, { code: 'name_mismatch' });
      }
      const result = await updateBillIf(db, caller.orgId, id, ['review'], {
        recipientId: recipient.id, matchedBy: caller.userId, matchedAt: now, matchReason: action.reason ?? null,
      }, entry(caller, now, 'matched', action.reason ? `${recipient.id}: ${action.reason}` : recipient.id), unchangedSince(row.updatedAt));
      return changed(result, 'matched') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
    case 'schedule': {
      const ctx = await context(db, caller.orgId, deps);
      const facts = billFacts(row, ctx);
      if (row.status !== 'review') return refuse(409, `This invoice is ${BILL_STATUS_LABEL[row.status].toLowerCase()}, so it cannot be scheduled.`, { code: 'status' });
      const blockers = scheduleBlockers(facts);
      if (blockers.length > 0) return refuse(409, blockers[0], { code: 'blocked', blockers });
      if (facts.recipient?.payoutMethod === 'BANK' && deps.stablecoinOnly()) {
        return refuse(403, 'Bank payouts are not open in this launch. Choose a recipient paid in USDC.', { code: 'launch_scope' });
      }
      if (facts.recipient && !nameMatches(row.payeeName ?? '', facts.recipient) && !row.matchReason) {
        return refuse(409, 'Say why this recipient is paid for this supplier’s invoice, or choose another.', { code: 'name_mismatch' });
      }
      const day = readDate(action.payOn);
      const today = utcDay(now);
      const latest = utcDay(new Date(now.getTime() + 365 * DAY_MS));
      if (!day || day.iso < today || day.iso > latest) return refuse(422, 'Choose a payment date from today to a year from now.', { fields: { payOn: 'Choose a date from today.' } });
      // Only the invoice that was checked: one changed since it was read is
      // checked again, not scheduled as it was.
      const result = await updateBillIf(db, caller.orgId, id, ['review'], {
        status: 'scheduled', scheduledFor: day.iso, scheduledBy: caller.userId, scheduledAt: now,
      }, entry(caller, now, 'scheduled', day.iso), unchangedSince(row.updatedAt));
      return changed(result, 'scheduled') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
    case 'unschedule': {
      const result = await updateBillIf(db, caller.orgId, id, ['scheduled'], {
        status: 'review', scheduledFor: null, scheduledBy: null, scheduledAt: null,
        // Whatever is approved next is another attempt, with its own key.
        paymentAttempt: row.paymentAttempt + 1,
      }, entry(caller, now, 'unscheduled'));
      return moved(result, 'taken back to review') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
    case 'withdraw': {
      // Out of "approving": only through the payment flow, which drops the
      // intent first. Without that, the intent could still be signed while
      // the invoice said otherwise.
      if (row.status !== 'approving' || !row.paymentIntentId) {
        return refuse(409, `This invoice is ${BILL_STATUS_LABEL[row.status].toLowerCase()}, so there is no approval to withdraw.`, { code: 'status' });
      }
      if (!deps.paymentFlow.cancel) {
        return refuse(501, 'Withdrawing from approval is not connected to Transfer on this server yet. Ask the owners to refuse it in Transfer.', { code: 'PAYMENT_FLOW_NOT_WIRED' });
      }
      const cancelled = await deps.paymentFlow.cancel({ orgId: caller.orgId, billId: row.id, paymentIntentId: row.paymentIntentId, requestedBy: { userId: caller.userId, role: caller.role } });
      if (!cancelled.ok) return refuse(cancelled.status === 501 ? 501 : 409, cancelled.error, { code: 'withdraw_refused' });
      const result = await updateBillIf(db, caller.orgId, id, ['approving'], {
        status: 'scheduled', paymentIntentId: null, approvalRequestedBy: null, approvalRequestedAt: null,
        paymentAttempt: row.paymentAttempt + 1,
      }, entry(caller, now, 'approval_withdrawn', row.paymentIntentId));
      return moved(result, 'withdrawn from approval') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
    case 'cancel': {
      const result = await updateBillIf(db, caller.orgId, id, ['review', 'scheduled'], { status: 'cancelled' }, entry(caller, now, 'cancelled', action.reason));
      return moved(result, 'cancelled') ?? { status: 200, body: { bill: await viewOf(db, (result as { row: BillRow }).row, deps) } };
    }
  }
}

// ─── Approve: the hand-off to the payment flow ──────────────────────────────

export async function handleBillPay(db: BillsDb, caller: BillCaller, id: string, deps: BillDeps): Promise<Answer> {
  if (!mayWriteBills(caller.role)) return forbidden(caller.role);
  const row = await readBill(db, caller.orgId, id);
  if (!row) return refuse(404, 'Invoice not found.');
  // Sent already: the same intent, never a second hand-off.
  if (row.status === 'approving' || row.status === 'paid') {
    return { status: 200, body: { bill: await viewOf(db, row, deps), replayed: true } };
  }
  if (row.status !== 'scheduled') return refuse(409, 'Schedule the invoice before sending it for approval.', { code: 'status' });
  const recipients = await deps.listRecipients(caller.orgId);
  const recipient = recipients.find((r) => r.id === row.recipientId);
  // Checked again here: screening, the ownership proof and the name can all
  // change between the match and the approval.
  const cannotPay = recipientRefusal(recipient);
  if (cannotPay || !recipient) return cannotPay ?? refuse(409, 'The recipient is no longer in your list.', { code: 'recipient_unverified' });
  if (!nameMatches(row.payeeName ?? '', recipient) && !row.matchReason) {
    return refuse(409, 'Say why this recipient is paid for this supplier’s invoice, or choose another.', { code: 'name_mismatch' });
  }
  if (recipient.payoutMethod === 'BANK' && deps.stablecoinOnly()) {
    return refuse(403, 'Bank payouts are not open in this launch.', { code: 'launch_scope' });
  }
  // Checked again here, not only when it was scheduled: what is known about
  // the invoice, the recipient and Splash's addresses can change in between.
  let splash: boolean;
  try { splash = await paysSplash(recipient, deps); } catch { return refuse(503, SPLASH_ADDRESSES_UNREAD, { code: 'splash_addresses_unread' }); }
  if (splash) return refuse(409, SPLASH_ADDRESS, { code: 'splash_address' });
  const others = await listBills(db, caller.orgId);
  const twice = findDuplicates(candidate(row), others.map(candidate))
    .find((f) => f.kind === 'same_number' && ['scheduled', 'approving', 'paid'].includes(f.status));
  if (twice) {
    return refuse(409, 'This invoice number is already scheduled, waiting for approval or paid. Cancel one of the two.', { code: 'duplicate_number', billId: twice.billId });
  }
  if (!HANDOFF_CURRENCIES.includes(row.currency!)) {
    return refuse(422, `This invoice is in ${row.currency}. It is paid in USDC, so it needs a rate quote first, and Invoices does not quote rates. Pay it from Transfer, where the rate is quoted and shown.`, { code: 'fx_quote_needed' });
  }
  const handoff = await deps.paymentFlow.start({
    orgId: caller.orgId,
    idempotencyKey: billPaymentKey(row),
    billId: row.id,
    requestedBy: { userId: caller.userId, role: caller.role },
    recipientId: recipient.id,
    amountMicros: row.amountMinor!,
    currency: row.currency!,
    payOn: row.scheduledFor!,
    supplierInvoiceNumber: row.invoiceNumber!,
    payee: row.payeeName!,
    settlementAsset: 'USDC',
    feeRule: 'quote_in_transfer_shown_fee_is_max_fee',
  });
  if (!handoff.ok) {
    return { status: handoff.status, body: { error: handoff.error, code: handoff.code, bill: await viewOf(db, row, deps) } };
  }
  const now = deps.now?.() ?? new Date();
  // Only onto the invoice that was handed off: one changed while the flow
  // took its quote (taken back, given another amount, scheduled again) is
  // not marked approving on an intent that pays what it used to say.
  const result = await updateBillIf(db, caller.orgId, id, ['scheduled'], {
    status: 'approving',
    paymentIntentId: handoff.paymentIntentId,
    approvalRequestedBy: caller.userId,
    approvalRequestedAt: now,
  }, entry(caller, now, 'sent_for_approval', handoff.paymentIntentId), unchangedSince(row.updatedAt));
  if (!result.ok) {
    // Another request with the same key got there first: its intent is this one.
    if (result.row && (result.row.status === 'approving' || result.row.status === 'paid') && result.row.paymentIntentId === handoff.paymentIntentId) {
      return { status: 200, body: { bill: await viewOf(db, result.row, deps), replayed: true } };
    }
    // Otherwise the intent pays something this invoice no longer says: drop
    // it. Its key is spent either way, so a later approval gets a new one.
    if (deps.paymentFlow.cancel) {
      try {
        await deps.paymentFlow.cancel({ orgId: caller.orgId, billId: row.id, paymentIntentId: handoff.paymentIntentId, requestedBy: { userId: caller.userId, role: caller.role } });
      } catch {
        // The intent cannot be signed for this invoice: nothing records it as this invoice's.
      }
    }
    if (result.reason === 'unique') return refuse(409, 'That payment already belongs to another invoice.', { code: 'intent_used' });
    if (result.row && (result.row.status === 'approving' || result.row.status === 'paid')) {
      return { status: 200, body: { bill: await viewOf(db, result.row, deps), replayed: true } };
    }
    if (result.reason === 'status' && result.row && ['scheduled', 'review'].includes(result.row.status)) {
      return refuse(409, 'The invoice changed while it was being sent for approval. Check it again.', { code: 'changed', bill: await viewOf(db, result.row, deps) });
    }
    return moved(result, 'sent for approval')!;
  }
  return { status: 200, body: { bill: await viewOf(db, result.row, deps) } };
}

// ─── What the payment flow reports back ─────────────────────────────────────

export type SettlementResult =
  | { ok: true; replayed: boolean; bill: BillRow }
  | { ok: false; code: 'invalid' | 'not_found' | 'status' | 'digest_mismatch' | 'digest_used' };

/**
 * The payment for an invoice settled on Sui. Called by the payment flow
 * (server side, never from a client route) with the intent it was handed and
 * the digest it settled with. Idempotent: the same intent and digest again is
 * a replay; a different digest for a paid invoice is refused, and a paid
 * invoice never changes.
 */
export async function recordBillSettlement(
  db: BillsDb,
  input: { orgId: string; paymentIntentId: string; suiDigest: string; paidAt: Date; approvers: string[]; network?: SuiNetworkName },
): Promise<SettlementResult> {
  if (!SUI_DIGEST.test(input.suiDigest) || !input.paymentIntentId) return { ok: false, code: 'invalid' };
  if (input.network !== undefined && input.network !== 'testnet' && input.network !== 'mainnet') return { ok: false, code: 'invalid' };
  const row = await readBillByIntent(db, input.orgId, input.paymentIntentId);
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status === 'paid') {
    return row.suiDigest === input.suiDigest ? { ok: true, replayed: true, bill: row } : { ok: false, code: 'digest_mismatch' };
  }
  if (row.status !== 'approving') return { ok: false, code: 'status' };
  const receiptNo = `SPB-${utcDay(input.paidAt).replace(/-/g, '')}-${row.id.slice(5, 13).toUpperCase()}`;
  const result = await updateBillIf(db, input.orgId, row.id, ['approving'], {
    status: 'paid',
    suiDigest: input.suiDigest,
    // Where the digest is, so the receipt's link opens the right explorer.
    suiNetwork: input.network ?? serverNetwork(),
    paidAt: input.paidAt,
    receiptNo,
    approvers: input.approvers.slice(0, 20),
  }, { at: input.paidAt.toISOString(), by: 'payment-flow', action: 'paid', note: input.suiDigest });
  if (!result.ok) {
    if (result.reason === 'unique') return { ok: false, code: 'digest_used' };
    if (result.row?.status === 'paid') {
      return result.row.suiDigest === input.suiDigest ? { ok: true, replayed: true, bill: result.row } : { ok: false, code: 'digest_mismatch' };
    }
    return { ok: false, code: 'status' };
  }
  return { ok: true, replayed: false, bill: result.row };
}

/** The payment flow closed the intent without paying (cancelled, expired, refused): back to scheduled. */
export async function recordBillPaymentClosed(
  db: BillsDb,
  input: { orgId: string; paymentIntentId: string; reason: string; at: Date },
): Promise<{ ok: boolean; bill: BillRow | null }> {
  const row = await readBillByIntent(db, input.orgId, input.paymentIntentId);
  if (!row || row.status !== 'approving') return { ok: false, bill: row };
  const result = await updateBillIf(db, input.orgId, row.id, ['approving'], {
    status: 'scheduled', paymentIntentId: null, approvalRequestedBy: null, approvalRequestedAt: null,
    // The next approval is another attempt, with its own key: never answered with this closed intent.
    paymentAttempt: row.paymentAttempt + 1,
  }, { at: input.at.toISOString(), by: 'payment-flow', action: 'payment_closed', note: input.reason.slice(0, 200) });
  return { ok: result.ok, bill: result.row };
}

// ─── The self-billed e-invoice (MyInvois) ───────────────────────────────────

const eInvoiceSchema = z.object({
  buyerTin: z.string().trim().max(20),
  phone: z.string().trim().max(24),
  stateCode: z.string().trim().max(2),
  classification: z.enum(Object.keys(SELF_BILLED_CLASSIFICATIONS) as [SelfBilledClassification, ...SelfBilledClassification[]]),
  description: z.string().trim().max(200),
  exchangeRateToMyr: z.string().trim().max(20).optional(),
  sstNumber: z.string().trim().max(40).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  // Asked for only when the business record lacks them.
  registrationNumber: z.string().trim().max(40).optional(),
  addressLine: z.string().trim().max(150).optional(),
  city: z.string().trim().max(60).optional(),
  postcode: z.string().trim().max(12).optional(),
  refresh: z.boolean().optional(),
});

export function eInvoiceView(row: BillRow) {
  return {
    fileName: `${row.receiptNo ?? row.id}-self-billed.json`,
    sha256: row.myinvoisSha256,
    generatedAt: row.myinvoisGeneratedAt?.toISOString() ?? null,
    document: row.myinvois,
    portalUrl: MYINVOIS_PORTAL_URL,
  };
}

export async function handleBillEInvoice(db: BillsDb, caller: BillCaller, id: string, body: unknown, deps: BillDeps): Promise<Answer> {
  if (!mayWriteBills(caller.role)) return forbidden(caller.role);
  const row = await readBill(db, caller.orgId, id);
  if (!row) return refuse(404, 'Invoice not found.');
  if (row.status !== 'paid' || !row.receiptNo || !row.suiDigest) return refuse(409, 'The e-invoice is made once the invoice is paid.', { code: 'status' });
  if (row.payeeCountry === 'MY') return refuse(409, 'The supplier is in Malaysia, so it issues the e-invoice. A self-billed one is only for a foreign supplier.', { code: 'not_foreign' });
  const parsed = eInvoiceSchema.safeParse(body ?? {});
  if (!parsed.success) return refuse(400, 'Some e-invoice details are not in the right form.', { details: parsed.error.flatten().fieldErrors });
  const now = deps.now?.() ?? new Date();
  const fresh = row.myinvoisGeneratedAt && now.getTime() - row.myinvoisGeneratedAt.getTime() < E_INVOICE_FRESH_MS;
  if (row.myinvois && (!parsed.data.refresh || fresh)) {
    return { status: 200, body: { eInvoice: eInvoiceView(row), replayed: true } };
  }
  const business = await deps.readBusiness(caller.orgId);
  if (!business) return refuse(409, 'Your business record is missing.');
  if (business.addressCountry && business.addressCountry !== 'MY') {
    return refuse(409, 'A MyInvois e-invoice is for a business in Malaysia.', { code: 'not_malaysian' });
  }
  const amount = fromMicros(row.amountMinor!);
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) return refuse(422, 'The amount has more than two decimals, which an e-invoice cannot carry.');
  const b = parsed.data;
  const input: SelfBilledInput = {
    eInvoiceNumber: `SB-${row.receiptNo}`,
    issuedAt: now,
    buyer: {
      name: business.legalName ?? business.name,
      tin: b.buyerTin,
      registrationNumber: business.registrationNumber ?? b.registrationNumber ?? '',
      sstNumber: b.sstNumber,
      addressLine: business.addressLine1 ?? b.addressLine ?? '',
      city: business.addressCity ?? b.city ?? '',
      postcode: business.addressPostalCode ?? b.postcode,
      stateCode: b.stateCode,
      phone: b.phone,
      email: b.email || undefined,
    },
    supplier: { name: row.payeeName!, country: row.payeeCountry! },
    currency: row.currency!,
    exchangeRateToMyr: b.exchangeRateToMyr,
    amount,
    description: b.description,
    classification: b.classification,
    supplierInvoiceNumber: row.invoiceNumber!,
    paymentReference: row.suiDigest,
  };
  const problems = selfBilledProblems(input);
  if (problems.length > 0) return refuse(422, problems[0], { code: 'incomplete', problems });
  const document = buildSelfBilledInvoice(input);
  const result = await updateBillIf(db, caller.orgId, id, ['paid'], {
    myinvois: document,
    myinvoisSha256: sha256(JSON.stringify(document)),
    myinvoisGeneratedAt: now,
    myinvoisGeneratedBy: caller.userId,
  }, row.myinvois
    // The earlier file is replaced, and its hash stays in the history: a
    // file filed with MyInvois from it can still be told from this one.
    ? entry(caller, now, 'einvoice_remade', `Replaces the file with SHA-256 ${row.myinvoisSha256}`)
    : entry(caller, now, 'einvoice_made'),
  row.myinvois && row.myinvoisSha256 ? eInvoiceStill(row.myinvoisSha256) : noEInvoiceYet());
  if (!result.ok) {
    // Another request made it first: theirs is the one.
    const current = await readBill(db, caller.orgId, id);
    if (current?.myinvois) return { status: 200, body: { eInvoice: eInvoiceView(current), replayed: true } };
    return refuse(409, 'The invoice changed while the e-invoice was being made. Try again.');
  }
  return { status: 201, body: { eInvoice: eInvoiceView(result.row) } };
}

export async function readBillEInvoice(db: BillsDb, caller: BillCaller, id: string): Promise<Answer> {
  const row = await readBill(db, caller.orgId, id);
  if (!row || !row.myinvois) return refuse(404, 'No e-invoice has been made for this invoice.');
  return { status: 200, body: { eInvoice: eInvoiceView(row) } };
}
