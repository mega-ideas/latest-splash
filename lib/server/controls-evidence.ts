/**
 * Gathering one payment's controls evidence (v2 §4.6) for ONE business.
 *
 * A payment is named by its on-chain intent id (a withdrawal or a supplier
 * payout, `withdrawals.intent_id`) or by its signing request (`wsr_…`, a
 * wallet payment, whose intent may not exist before it executes). Every read
 * takes the org: another business's intent id or request id reads as absent
 * (404), the same as one that does not exist (WS2).
 *
 * The chain is read, never written: the executed transaction's events give
 * the intent the chain created (under splash_core's original package id),
 * and the SettlementAnchored event the Walrus blob, the content hash and
 * the receipt. A chain that cannot be read leaves those fields empty and
 * says so in `gaps`; nothing is filled in from what the request said.
 *
 * The evidence is about the time of the payment: it was approved when the
 * signature that completed its quorum was taken (the signing layer checks
 * the screening at every signature, lib/server/payment-compliance-gate.ts).
 * Screenings after that are listed apart, a payment with no CLEAR before it
 * says so, and a KYB case changed since is named as changed.
 */
import { and, desc, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { kybCases, organizations, suppliers, withdrawals } from '../db/schema.ts';
import type { ControlsEvidence, EvidencePaymentKind } from '../compliance/controls-evidence.ts';
import { assertEvidenceClean, sanitizeIsoEvidence } from '../compliance/controls-evidence.ts';
import type { Pacs008Evidence } from '../payments/iso20022.ts';
import { createdIntentIds } from '../payouts/withdrawal-rules.ts';
import type { WalletAction, WalletTxDescription } from '../wallet/wallet-tx-describe.ts';
import { readCrossChainTransfer } from './cross-chain-transfers.ts';
import { CROSS_CHAIN_CHAINS, isCrossChainChain } from '../recipients/wallet-recipients.ts';
import { rowIsProviderAnswer, screeningsOf } from './kyt-screenings.ts';
import { isProductionRuntime } from './runtime-mode.ts';
import { readTravelRuleTransfer } from './travel-rule-transfers.ts';
import { recipientControlsAt } from './wallet-recipients.ts';
import { readSigningRequest, type DrizzleDb, type StoredRequest } from './wallet-signing-store.ts';
import type { WithdrawalChainTx } from './withdrawals.ts';
import { getWithdrawalRow, withdrawalBySigningRequest, type WithdrawalRow } from './withdrawals-store.ts';

export type EvidenceDeps = {
  db: DrizzleDb;
  orgId: string;
  now: () => Date;
  readTransaction: (digest: string) => Promise<WithdrawalChainTx | null>;
  /** splash_core's original package id; null when this server does not know it (the chain fields are then not read). */
  corePackageOriginalId: string | null;
  /** The runtime: in production a sandbox screening or Travel Rule message on file is named as not the provider's. Default: this process. */
  env?: NodeJS.ProcessEnv;
};

type Refusal = { ok: false; status: number; code: string; error: string };

const PAYMENT_PURPOSES = new Set(['wallet_payment', 'withdrawal', 'partner_payout']);
/** A request in one of these has had its quorum: its last signature is when it was approved. */
const APPROVED = new Set(['submitting', 'unknown', 'executed', 'failed']);
/** splash_core's payment kind for an exchange deposit address. */
const EXCHANGE_KIND = 2;

/** When the payment was approved: the latest signature of a request whose quorum was met. */
function approvedAtOf(request: StoredRequest | null): Date | null {
  if (!request || !APPROVED.has(request.status)) return null;
  const times = request.signers.map((s) => s.signedAt?.getTime() ?? 0).filter((t) => t > 0);
  return times.length ? new Date(Math.max(...times)) : request.createdAt;
}

function kindOf(description: WalletTxDescription | null | undefined): number | null {
  for (const a of description?.actions ?? []) {
    if (a.type === 'open_intent') return a.kind;
    if (a.type === 'pay_intent' && a.intent) return a.intent.kind;
  }
  return null;
}

/** vector<u8> in an event's JSON, as hex: a byte array, a 0x string, or base64. */
export function bytesHex(value: unknown): string | null {
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Buffer.from(value as number[]).toString('hex');
  if (typeof value !== 'string' || value === '') return null;
  if (/^0x[0-9a-fA-F]*$/.test(value)) return value.slice(2).toLowerCase();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return Buffer.from(value, 'base64').toString('hex');
  return null;
}

function eventTypeIs(eventType: string, pkg: string, tail: string): boolean {
  const [addr, ...rest] = eventType.split('::');
  try {
    return normalizeSuiAddress(addr) === normalizeSuiAddress(pkg) && rest.join('::') === tail;
  } catch {
    return false;
  }
}

/** What the executed transaction shows: the intent it created, and its settlement anchor. */
export function chainFacts(tx: WithdrawalChainTx, corePackageOriginalId: string, intentId: string | null) {
  const events = tx.events ?? [];
  const created = tx.success ? createdIntentIds(events, corePackageOriginalId) : [];
  const want = intentId ? normalizeSuiAddress(intentId) : created[0] ?? null;
  let anchor: { index: number; walrus: string | null; content: string | null } | null = null;
  events.forEach((e, index) => {
    if (anchor || !eventTypeIs(e.eventType, corePackageOriginalId, 'audit_anchor::SettlementAnchored')) return;
    const j = (e.json ?? {}) as { intent_id?: unknown; walrus_blob_id?: unknown; content_hash?: unknown };
    const id = typeof j.intent_id === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(j.intent_id) ? normalizeSuiAddress(j.intent_id) : null;
    if (!id || (want && id !== want)) return;
    anchor = { index, walrus: bytesHex(j.walrus_blob_id), content: bytesHex(j.content_hash) };
  });
  const a = anchor as { index: number; walrus: string | null; content: string | null } | null;
  return {
    success: tx.success,
    intentIdOnChain: want && created.includes(want) ? want : null,
    walrusBlobId: a?.walrus ?? null,
    contentHash: a?.content ?? null,
    receiptId: a ? `${tx.digest}#${a.index}` : null,
  };
}

/** The payment a wallet payment's bytes describe: where the USDC goes, how much, and the intent when it exists. */
export function paymentOfDescription(description: WalletTxDescription | null | undefined) {
  const actions: WalletAction[] = description?.actions ?? [];
  const open = actions.find((a) => a.type === 'open_intent');
  const pay = actions.find((a) => a.type === 'pay_intent');
  const send = actions.find((a) => a.type === 'send_funds');
  const approval = actions.find((a) => a.type === 'approve_payout');
  if (open && open.type === 'open_intent') {
    return { recipient: open.recipient, amountMinor: open.amountMinor, intentId: null as string | null, maxFeeMinor: pay && pay.type === 'pay_intent' ? pay.maxFeeMinor : null, approval };
  }
  if (pay && pay.type === 'pay_intent' && pay.intent) {
    return { recipient: pay.intent.recipient, amountMinor: pay.intent.amountMinor, intentId: pay.intent.intentId, maxFeeMinor: pay.maxFeeMinor, approval };
  }
  if (send && send.type === 'send_funds') return { recipient: send.recipient, amountMinor: send.amountMinor ?? '0', intentId: null, maxFeeMinor: null, approval };
  return null;
}

async function latestKyb(db: DrizzleDb, orgId: string) {
  const [kyb] = await db
    .select({ id: kybCases.id, state: kybCases.state, applicant: kybCases.sumsubApplicantId, updatedAt: kybCases.updatedAt })
    .from(kybCases)
    .where(eq(kybCases.orgId, orgId))
    .orderBy(desc(kybCases.updatedAt))
    .limit(1);
  const [org] = await db.select({ lifecycle: organizations.kybLifecycle }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return { kyb: kyb ?? null, lifecycle: org?.lifecycle ?? null };
}

async function withdrawalByIntent(db: DrizzleDb, orgId: string, intentId: string): Promise<WithdrawalRow | null> {
  const [row] = await db.select().from(withdrawals).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.intentId, intentId))).limit(1);
  return row ?? null;
}

/** Resolve a payment reference to this org's withdrawal row and/or signing request. */
async function resolvePayment(deps: EvidenceDeps, ref: string): Promise<{ row: WithdrawalRow | null; request: StoredRequest | null } | null> {
  const r = ref.trim();
  if (/^wsr_[0-9a-f-]{36}$/.test(r)) {
    const request = await readSigningRequest(deps.db, deps.orgId, r);
    if (!request || !PAYMENT_PURPOSES.has(request.purpose)) return null;
    return { request, row: await withdrawalBySigningRequest(deps.db, deps.orgId, r) };
  }
  if (/^0x[0-9a-fA-F]{1,64}$/.test(r)) {
    const row = await withdrawalByIntent(deps.db, deps.orgId, normalizeSuiAddress(r));
    if (!row) return null;
    const request = row.signingRequestId ? await readSigningRequest(deps.db, deps.orgId, row.signingRequestId) : null;
    return { row, request };
  }
  if (/^wdr_[0-9a-f-]{36}$/.test(r)) {
    const row = await getWithdrawalRow(deps.db, deps.orgId, r);
    if (!row) return null;
    const request = row.signingRequestId ? await readSigningRequest(deps.db, deps.orgId, row.signingRequestId) : null;
    return { row, request };
  }
  return null;
}

/**
 * Each partner fee as its own line, with only the fields a fee line has: the
 * quote's JSON is not passed through, so nothing else stored beside a fee
 * reaches the document.
 */
function partnerFeeLines(value: unknown): Array<{ partner: string | null; label: string | null; currency: string | null; amountMinor: string | null }> {
  if (!Array.isArray(value)) return [];
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 120) : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null);
  return value
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
    .map((f) => ({ partner: text(f.partner), label: text(f.label), currency: text(f.currency), amountMinor: text(f.amountMinor) }));
}

/** One payment's controls evidence, for this org only. */
export async function controlsEvidenceFor(deps: EvidenceDeps, ref: string, generatedBy: string): Promise<{ ok: true; evidence: ControlsEvidence } | Refusal> {
  const found = await resolvePayment(deps, ref);
  if (!found) return { ok: false, status: 404, code: 'not_found', error: 'No such payment.' };
  const { row, request } = found;
  const gaps: string[] = [];

  const summary = (request?.summary ?? null) as { description?: WalletTxDescription; spend?: { policyIds?: string[]; allowanceIds?: string[] } } | null;
  const described = paymentOfDescription(summary?.description);
  const kind: EvidencePaymentKind = row ? (row.kind === 'supplier_payout' ? 'supplier_payout' : 'withdrawal') : 'wallet_payment';
  const intentId = row?.intentId ?? described?.intentId ?? null;
  const paidTo = row?.depositAddress ?? described?.recipient ?? '';
  const amountMinor = row ? row.amountMinor.toString() : described?.amountMinor ?? '0';
  if (!row && !described) gaps.push('The signing request does not describe a payment Splash can read.');
  const digest = row?.suiDigest ?? request?.executedDigest ?? null;

  const { kyb, lifecycle } = await latestKyb(deps.db, deps.orgId);
  if (!kyb) gaps.push('The business has no KYB case on file.');
  else if (!kyb.applicant) gaps.push('The KYB case has no provider applicant reference.');

  const approvedAt = approvedAtOf(request);
  if (approvedAt && kyb && kyb.updatedAt.getTime() > approvedAt.getTime()) {
    gaps.push('The KYB case changed after the payment was approved; it is shown as it is now, not as it was then.');
  }

  const env = deps.env ?? process.env;
  const production = isProductionRuntime(env);
  const cct = intentId ? await readCrossChainTransfer(deps.db, deps.orgId, normalizeSuiAddress(intentId)) : null;

  type ScreeningRow = Awaited<ReturnType<typeof screeningsOf>>[number];
  // An unanswered attempt is placed by when it was asked.
  const at = (s: ScreeningRow) => (s.screenedAt ?? s.createdAt).getTime();
  const split = (rows: ScreeningRow[], subject: 'paid_address' | 'cross_chain_recipient' | 'cross_chain_recipient_owner') => {
    const view = (s: ScreeningRow) => ({
      subject,
      chain: s.chain,
      address: s.address,
      provider: s.provider,
      reference: s.reference,
      verdict: s.verdict,
      riskScore: s.riskScore,
      screenedAt: s.screenedAt ? s.screenedAt.toISOString() : null,
    });
    const before = approvedAt ? rows.filter((s) => at(s) <= approvedAt.getTime()) : rows;
    const after = approvedAt ? rows.filter((s) => at(s) > approvedAt.getTime()) : [];
    return { before, after: after.slice(0, 5).map(view), beforeView: before.slice(0, 5).map(view) };
  };
  /** The newest screening before approval was a CLEAR, and a provider's answer here. */
  const clearBefore = (before: ScreeningRow[]) => before[0]?.verdict === 'CLEAR' && rowIsProviderAnswer(before[0], env);
  const sandboxNote = (before: ScreeningRow[], what: string) => {
    if (production && before[0] && before[0].provider === 'sandbox') gaps.push(`The newest screening of ${what} on file is the sandbox's, not a provider's answer.`);
  };

  let screenings: ControlsEvidence['screenings'] = [];
  let screeningsAfterApproval: ControlsEvidence['screeningsAfterApproval'] = [];
  let screenedAsExchange = false;
  let paidBefore: ScreeningRow[] = [];
  if (paidTo) {
    let address = paidTo;
    try {
      address = normalizeSuiAddress(paidTo);
    } catch {
      /* kept as given */
    }
    const rows = await screeningsOf(deps.db, deps.orgId, 'SUI', address, 50);
    screenedAsExchange = rows.some((s) => s.subjectKind === 'exchange_recipient');
    const s = split(rows, 'paid_address');
    paidBefore = s.before;
    screenings = s.beforeView;
    screeningsAfterApproval = s.after;
  }
  // A cross-chain payment's recipient is its destination address, on its own chain (D5c).
  let destination: { chain: string; address: string } | null = null;
  let tokenOwner: string | null = null;
  if (cct) {
    const [saved] = cct.recipientId
      ? await deps.db.select({ address: suppliers.destinationAddress, tokenOwner: suppliers.destinationTokenOwner }).from(suppliers).where(and(eq(suppliers.id, cct.recipientId), eq(suppliers.orgId, deps.orgId))).limit(1)
      : [];
    tokenOwner = saved?.tokenOwner ?? null;
    const chain = isCrossChainChain(cct.destinationChain) ? CROSS_CHAIN_CHAINS[cct.destinationChain] : null;
    // Without the saved recipient, an EVM address is the mint recipient's last 20 bytes.
    const address = saved?.address ?? (chain && chain !== 'SOLANA' && /^0x0{24}[0-9a-f]{40}$/i.test(cct.mintRecipient) ? `0x${cct.mintRecipient.slice(-40).toLowerCase()}` : null);
    if (chain && address) destination = { chain, address };
  }
  if (cct) {
    if (!destination) gaps.push("The cross-chain recipient's address could not be read, so its screening is not shown.");
    else {
      const s = split(await screeningsOf(deps.db, deps.orgId, destination.chain, destination.address, 50), 'cross_chain_recipient');
      screenings = [...s.beforeView, ...screenings];
      screeningsAfterApproval = [...s.after, ...screeningsAfterApproval];
      sandboxNote(s.before, 'the cross-chain recipient');
      if (!clearBefore(s.before)) {
        gaps.push(
          approvedAt
            ? 'No CLEAR screening of the cross-chain recipient was the newest on file before the payment was approved.'
            : 'No CLEAR screening of the cross-chain recipient is the newest on file.',
        );
      }
      // On Solana the token account's owner wallet is screened as well (sanctions lists name wallets).
      if (destination.chain === 'SOLANA') {
        if (!tokenOwner) gaps.push("The wallet that owns the cross-chain recipient's token account is not on file, so it was not screened.");
        else {
          const o = split(await screeningsOf(deps.db, deps.orgId, 'SOLANA', tokenOwner, 50), 'cross_chain_recipient_owner');
          screenings = [...screenings.slice(0, s.beforeView.length), ...o.beforeView, ...screenings.slice(s.beforeView.length)];
          screeningsAfterApproval = [...screeningsAfterApproval.slice(0, s.after.length), ...o.after, ...screeningsAfterApproval.slice(s.after.length)];
          sandboxNote(o.before, "the wallet that owns the cross-chain recipient's token account");
          if (!clearBefore(o.before)) {
            gaps.push(
              approvedAt
                ? "No CLEAR screening of the wallet that owns the cross-chain recipient's token account was the newest on file before the payment was approved."
                : "No CLEAR screening of the wallet that owns the cross-chain recipient's token account is the newest on file.",
            );
          }
        }
      }
    }
  } else if (kind === 'wallet_payment') {
    sandboxNote(paidBefore, 'the recipient address');
    if (!clearBefore(paidBefore)) {
      gaps.push(
        approvedAt
          ? 'No CLEAR screening of the recipient address was the newest on file before the payment was approved.'
          : 'No CLEAR screening of the recipient address is the newest on file.',
      );
    }
  } else if (screenings.length === 0) {
    gaps.push("No KYT screening of the partner's deposit address is on file; the supplier's bank account is the partner's to screen.");
  }

  const tr = await readTravelRuleTransfer(deps.db, deps.orgId, intentId ?? request?.id ?? '');
  const travelRule = tr ? { provider: tr.provider, sandbox: tr.sandbox, reference: tr.providerRef, status: tr.status, exchange: tr.exchange } : null;
  const trSandboxHere = Boolean(tr?.sandbox) && production;
  if (trSandboxHere) gaps.push("The Travel Rule message on file is the sandbox's, not the provider's.");
  if (kind === 'wallet_payment' && (kindOf(summary?.description) === EXCHANGE_KIND || screenedAsExchange || tr) && !(!trSandboxHere && tr?.providerRef && ['submitted', 'awaiting_counterparty', 'approved'].includes(tr.status))) {
    gaps.push('This payment goes to an exchange, and no Travel Rule message accepted by the provider is on file for it.');
  }

  // The saved recipient's controls (v2 §4.7), and a cross-chain payment's receipt.
  const recipient: ControlsEvidence['recipient'] = kind === 'wallet_payment' && paidTo ? await recipientControlsAt(deps.db, deps.orgId, paidTo) : null;
  if (recipient && !recipient.approvedBy) gaps.push('No owner approved the recipient this payment went to.');
  const crossChain: ControlsEvidence['crossChain'] = cct
    ? {
        status: cct.status,
        destination: { chain: cct.destinationChain, domain: cct.destinationDomain, mintRecipient: cct.mintRecipient },
        amountMinor: cct.amountMinor.toString(),
        maxBridgeFeeMinor: cct.maxBridgeFeeMinor.toString(),
        burn: cct.burnDigest ? { suiDigest: cct.burnDigest, at: cct.burnedAt?.toISOString() ?? null } : null,
        attestation: cct.attestation ? { nonce: cct.messageNonce, at: cct.attestedAt?.toISOString() ?? null, sandbox: cct.sandbox } : null,
        mint: cct.mintTxHash ? { chain: cct.destinationChain, txHash: cct.mintTxHash, mintedMinor: cct.mintedAmountMinor?.toString() ?? null, at: cct.mintedAt?.toISOString() ?? null } : null,
      }
    : null;
  if (cct && cct.status !== 'minted') gaps.push('This cross-chain payment is not yet minted on its destination chain.');

  let approval: ControlsEvidence['approval'] = null;
  if (request) {
    const second = described?.approval && described.approval.type === 'approve_payout' ? { policy: described.approval.policy, payer: described.approval.payer, settleByMs: described.approval.settleByMs } : null;
    approval = {
      signingRequestId: request.id,
      purpose: request.purpose,
      status: request.status,
      threshold: request.threshold,
      signers: request.signers.map((s) => ({ userId: s.userId, address: s.address, weight: s.weight, signedAt: s.signedAt ? s.signedAt.toISOString() : null, declined: Boolean(s.declinedAt) })),
      spendingRule: summary?.spend && ((summary.spend.allowanceIds?.length ?? 0) > 0 || (summary.spend.policyIds?.length ?? 0) > 0)
        ? { allowanceIds: [...(summary.spend.allowanceIds ?? [])], policyIds: [...(summary.spend.policyIds ?? [])] }
        : null,
      secondApproval: second,
    };
  } else gaps.push('No signing request is on file for this payment.');

  const stored = (row?.iso20022 ?? null) as Pacs008Evidence | null;
  const iso = stored ? sanitizeIsoEvidence(stored) : null;
  if (row && !iso) gaps.push('This payout was written before its ISO 20022 copy was kept.');
  const q = (row?.quote ?? null) as { partnerFees?: unknown; sandbox?: boolean; splashFeeMinor?: string } | null;
  const quote = row
    ? {
        reference: row.quoteRef,
        expiresAt: row.quoteExpiresAt.toISOString(),
        currency: row.currency,
        rateMicro: row.rateMicro.toString(),
        receiveMinor: row.receiveMinor.toString(),
        partnerFees: partnerFeeLines(q?.partnerFees),
        splashFeeMinor: typeof q?.splashFeeMinor === 'string' ? q.splashFeeMinor : null,
        sandbox: q?.sandbox === true,
      }
    : null;
  const partner = row ? { route: row.partner, reference: row.partnerRef, bankRef: row.bankRef, creditorAccountLast4: iso ? `****${iso.creditorAccountLast4}` : null } : null;

  const chain: ControlsEvidence['chain'] = { suiDigest: digest, intentIdOnChain: null, walrusBlobId: null, contentHash: null, receiptId: null };
  if (digest && deps.corePackageOriginalId) {
    let tx: WithdrawalChainTx | null = null;
    try {
      tx = await deps.readTransaction(digest);
    } catch {
      tx = null;
    }
    if (!tx) gaps.push('The transaction could not be read from the chain just now; ask again for the on-chain fields.');
    else {
      const facts = chainFacts(tx, deps.corePackageOriginalId, intentId);
      if (!facts.success) gaps.push('The transaction failed on chain.');
      chain.intentIdOnChain = facts.intentIdOnChain;
      chain.walrusBlobId = facts.walrusBlobId;
      chain.contentHash = facts.contentHash;
      chain.receiptId = facts.receiptId;
      if (facts.success && !facts.receiptId) gaps.push('The transaction carries no settlement anchor for this intent.');
    }
  } else if (digest) gaps.push("This server does not know splash_core's package id, so the on-chain fields were not read.");
  else gaps.push('The payment has not been sent to the chain.');

  const evidence: ControlsEvidence = {
    schema: 'splash.controls-evidence.v1',
    payment: {
      ref: row?.id ?? request!.id,
      kind,
      status: row?.status ?? request!.status,
      intentId,
      asset: 'USDC',
      amountMinor,
      maxFeeMinor: row ? row.maxFeeMinor.toString() : described?.maxFeeMinor ?? null,
      paidTo,
      fromWallet: row?.walletAddress ?? request!.senderAddress,
      createdAt: (row?.createdAt ?? request!.createdAt).toISOString(),
    },
    approvedAt: approvedAt ? approvedAt.toISOString() : null,
    kyb: kyb ? { caseId: kyb.id, state: kyb.state, provider: kyb.applicant ? 'sumsub' : null, providerApplicantRef: kyb.applicant, lifecycle, updatedAt: kyb.updatedAt.toISOString() } : null,
    screenings,
    screeningsAfterApproval,
    travelRule,
    recipient,
    crossChain,
    approval,
    quote,
    partner,
    iso20022: iso,
    chain,
    gaps,
    generatedAt: deps.now().toISOString(),
    generatedBy,
  };
  assertEvidenceClean(evidence);
  return { ok: true, evidence };
}
