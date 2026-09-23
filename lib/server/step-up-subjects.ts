import { formatMinor, parseMinor, sumMinor, USD_DECIMALS } from '@/lib/money';
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

export function batchPayoutSubject(ctx: { orgId: string; userId: string }, payload: Payload): StepUpSubject {
  const rows = Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>) : [];
  const targetCurrency = typeof payload.targetCurrency === 'string' ? payload.targetCurrency : 'PHP';
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

export function fiatTransferSubject(ctx: { orgId: string; userId: string }, payload: Payload): StepUpSubject {
  const body = withoutSecondFactor(payload);
  const amount = (body.amount ?? {}) as { value?: unknown; targetCurrency?: unknown };
  const recipient = (body.recipient ?? {}) as { name?: unknown };
  return {
    subjectId: `fiat:${ctx.orgId}:${ctx.userId}`,
    subject: { kind: 'fiat-transfer', orgId: ctx.orgId, body },
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
