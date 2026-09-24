import { formatMinor, MICRO_DECIMALS, parseMinor, sumMinor, USD_DECIMALS } from '@/lib/money';
import { formatUsdc, shortAddress } from '@/lib/payments/stablecoin-lane';
import type { StepUpPurpose } from '@/lib/server/step-up';

/**
 * What each step-up code approves — built on the server from the real record
 * or the exact payload that will be saved, never from a description the
 * client supplies. The same builder runs when the code is requested and when
 * the approved action happens, so the digests meet only if nothing changed.
 */

export interface StepUpSubject {
  subjectId: string;
  subject: unknown;
  /** Rides in the WhatsApp template's {{1}}; kept short. */
  label: string;
  /** Shown to the approver in full, in the message and on screen. */
  summary: string;
}

type Payload = Record<string, unknown>;

function withoutSecondFactor(payload: Payload): Payload {
  const copy = { ...payload };
  delete copy.totp;
  delete copy.stepUpCode;
  return copy;
}

/** A wallet transfer or an x402 payment, as quoted and reserved. */
export function stablecoinTransferSubject(
  row: {
    id: string;
    kind?: string;
    resource?: string | null;
    senderAddress: string;
    recipientAddress: string;
    principalMinor: bigint | string;
    feeMinor: bigint | string;
    feeAddress: string | null;
    coinType: string;
    network: string;
  },
  recipientName: string,
): StepUpSubject {
  const principal = BigInt(row.principalMinor);
  const fee = BigInt(row.feeMinor);
  if (row.kind === 'X402') {
    const host = safeHost(row.resource ?? '');
    return {
      subjectId: row.id,
      subject: {
        kind: 'x402-payment',
        outflowId: row.id,
        resource: row.resource ?? null,
        sender: row.senderAddress,
        payTo: row.recipientAddress,
        principalMinor: principal.toString(),
        coinType: row.coinType,
        network: row.network,
      },
      label: `${formatUsdc(principal)} USDC x402 to ${host}`,
      summary:
        `Pay ${formatUsdc(principal)} USDC over x402 to ${host} (${shortAddress(row.recipientAddress)}) on Sui mainnet ` +
        `for ${row.resource}. No Splash fee; it leaves ${shortAddress(row.senderAddress)}.`,
    };
  }
  return {
    subjectId: row.id,
    subject: {
      kind: 'stablecoin-transfer',
      outflowId: row.id,
      sender: row.senderAddress,
      recipient: row.recipientAddress,
      principalMinor: principal.toString(),
      feeMinor: fee.toString(),
      feeAddress: row.feeAddress,
      coinType: row.coinType,
      network: row.network,
    },
    label: `${formatUsdc(principal)} USDC to ${recipientName}`,
    summary:
      `Send ${formatUsdc(principal)} USDC to ${recipientName} (${shortAddress(row.recipientAddress)}) on Sui mainnet. ` +
      `Fee ${formatUsdc(fee)} USDC; ${formatUsdc(principal + fee)} USDC leaves ${shortAddress(row.senderAddress)}.`,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function settingsChangeSubject(ctx: { orgId: string; userId: string }, patch: Payload): StepUpSubject {
  const keys = Object.keys(patch).sort();
  const shown = keys.slice(0, 6).map((k) => `${k} → ${JSON.stringify(patch[k])}`).join(', ');
  return {
    subjectId: `settings:${ctx.orgId}:${ctx.userId}`,
    subject: { kind: 'settings-change', orgId: ctx.orgId, userId: ctx.userId, patch },
    label: 'workspace settings change',
    summary: `Change workspace settings: ${shown}${keys.length > 6 ? ` and ${keys.length - 6} more` : ''}.`,
  };
}

export function profileChangeSubject(ctx: { orgId: string; userId: string }, changes: Payload): StepUpSubject {
  const keys = Object.keys(changes).sort();
  return {
    subjectId: `profile:${ctx.userId}`,
    subject: { kind: 'profile-change', userId: ctx.userId, changes },
    label: 'profile change',
    summary: `Submit a profile change for review: ${keys.join(', ') || 'no fields'}.`,
  };
}

/**
 * The rows a batch run pays: a name, an address and an amount settlement can
 * pay — read the way settlement reads it, in micro-USD, and more than zero.
 * The rest are blocked. The authorize route and the approval binding below
 * both use this, so what an approval covers is exactly what the run pays.
 *
 * This was `parseFloat(amount) > 0` in the route, which accepted "1.2.3" as
 * 1.2 and left settlement to reject the whole run after it was approved.
 */
export function payableBatchRows<Row>(rows: readonly Row[]): Row[] {
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const { name, address, amount } = row as { name?: unknown; address?: unknown; amount?: unknown };
    if (!name || !address) return false;
    try {
      return parseMinor((amount ?? '0') as string, MICRO_DECIMALS, 'half-up') > 0n;
    } catch {
      return false;
    }
  });
}

/** The currency a batch pays out in, which also sets its corridor fee. */
export function batchTargetCurrency(payload: Payload): string {
  return typeof payload.targetCurrency === 'string' ? payload.targetCurrency : 'PHP';
}

/**
 * What a batch approval covers: each row the run pays (name, address and
 * amount, in order) and the payout currency. Blocked rows pay nothing and are
 * left out. Values are compared exactly as the route passes them to
 * settlement, without normalising, so a respelled address or amount needs a
 * new approval rather than being assumed equal.
 */
export function batchPayoutSubstance(payload: Payload) {
  const rows = Array.isArray(payload.rows) ? (payload.rows as unknown[]) : [];
  return {
    rows: payableBatchRows(rows).map((row) => {
      const { name, address, amount } = row as { name?: unknown; address?: unknown; amount?: unknown };
      return { name: name ?? null, address: address ?? null, amount: amount ?? null };
    }),
    targetCurrency: batchTargetCurrency(payload),
  };
}

/** What a Smart Treasury approval covers: which way the money moves, and how much. */
export function treasuryMoveSubstance(payload: Payload) {
  return { action: payload.action ?? null, amountUsd: payload.amountUsd ?? null };
}

export function batchPayoutSubject(ctx: { orgId: string; userId: string }, payload: Payload): StepUpSubject {
  const rows = Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>) : [];
  const targetCurrency = batchTargetCurrency(payload);
  // Exact, in cents: the summary an approver reads must not be off by a float.
  const cents = rows.map((r) => {
    try {
      return parseMinor(String(r.amount ?? '0').trim() || '0', USD_DECIMALS, 'half-up');
    } catch {
      return 0n;
    }
  });
  const total = formatMinor(sumMinor(cents), USD_DECIMALS);
  return {
    subjectId: `batch:${ctx.orgId}:${ctx.userId}`,
    subject: { kind: 'batch-payout', orgId: ctx.orgId, rows, targetCurrency },
    label: `batch of ${rows.length} payouts`,
    summary: `Authorize a batch payout: ${rows.length} payment${rows.length === 1 ? '' : 's'}, $${total} total, paid out in ${targetCurrency}.`,
  };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return value === undefined || value === null ? '' : String(value);
}

/**
 * What a payout approval covers: who is paid, to which account, how much, in
 * what currency, and from which source. Not the whole request body — the
 * transfer wizard adds a funding session, a quote and display state between
 * approving and sending, and none of those changes what the approver agreed
 * to. Change anything here and the approval no longer applies.
 */
export function fiatPaymentSubstance(payload: Payload) {
  const body = withoutSecondFactor(payload);
  const recipient = (body.recipient ?? {}) as Record<string, unknown>;
  const bank = (recipient.bank ?? {}) as Record<string, unknown>;
  const amount = (body.amount ?? {}) as Record<string, unknown>;
  const funding = (body.fundingSelection ?? null) as Record<string, unknown> | null;
  return {
    recipient: {
      name: text(recipient.name),
      country: text(recipient.country).toUpperCase(),
      bank: { swift: text(bank.swift), account: text(bank.account) },
      travelRule: recipient.travelRule ?? null,
    },
    travelRulePayment: body.travelRulePayment ?? null,
    amount: { value: text(amount.value), targetCurrency: text(amount.targetCurrency).toUpperCase() },
    deliveryTier: text(body.deliveryTier) || 'PAYOUT_ONLY',
    invoiceId: text(body.invoiceId) || null,
    funding: funding
      ? {
          source: text(funding.source),
          type: text(funding.type),
          provider: text(funding.provider) || null,
          asset: text(funding.asset) || null,
          rail: text(funding.rail) || null,
          sourceChain: text(funding.sourceChain) || null,
        }
      : null,
  };
}

export function fiatTransferSubject(ctx: { orgId: string; userId: string }, payload: Payload): StepUpSubject {
  const body = withoutSecondFactor(payload);
  const amount = (body.amount ?? {}) as { value?: unknown; targetCurrency?: unknown };
  const recipient = (body.recipient ?? {}) as { name?: unknown };
  return {
    subjectId: `fiat:${ctx.orgId}:${ctx.userId}`,
    subject: { kind: 'fiat-transfer', orgId: ctx.orgId, payment: fiatPaymentSubstance(payload) },
    label: `$${String(amount.value ?? '?')} payout`,
    summary: `Authorize a payout of $${String(amount.value ?? '?')} to ${String(recipient.name ?? 'the recipient')}, paid out in ${String(amount.targetCurrency ?? '?')}.`,
  };
}

/** The payload-based subjects, by purpose (stablecoin is built from its record). */
export function payloadSubject(
  purpose: Exclude<StepUpPurpose, 'STABLECOIN_TRANSFER'>,
  ctx: { orgId: string; userId: string },
  payload: Payload,
): StepUpSubject {
  switch (purpose) {
    case 'SETTINGS_CHANGE':
      return settingsChangeSubject(ctx, payload);
    case 'PROFILE_CHANGE':
      return profileChangeSubject(ctx, payload);
    case 'BATCH_PAYOUT':
      return batchPayoutSubject(ctx, payload);
    case 'FIAT_TRANSFER':
      return fiatTransferSubject(ctx, payload);
  }
}
