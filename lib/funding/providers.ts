/**
 * Funding partners behind one interface (v2 §4.3, D7): Halliday, Stripe and
 * TransFi, with Bridge stubbed while it is in talks.
 *
 * A partner takes the business's bank transfer or card payment and delivers
 * USDC on Sui to the business wallet. Splash never receives the money and
 * never holds it: the order names the wallet as the delivery address, and
 * what arrives is read from the chain, not from the partner's word.
 *
 * Every adapter has two implementations:
 *   sandbox  outside production only. Deterministic quotes and orders, and
 *            webhooks signed with a sandbox secret. Labelled `sandbox: true`
 *            on everything it returns.
 *   live     production. Without the partner's credentials it refuses
 *            (`provider_not_configured`). With them it still refuses
 *            (`provider_not_connected`): no partner's API is wired yet, and
 *            an adapter that guessed at one would be fabricating quotes and
 *            references. Nothing a sandbox makes is reachable here.
 *
 * Fees: a partner's fee is the partner's, from the partner's quote, shown as
 * its own line and never marked up. Splash adds no line to a top-up.
 *
 * Idempotency: the funding intent's id is the order's idempotency key (the
 * sandbox's order reference is an HMAC of it under a per-process key, so it
 * cannot be worked out from the id), so a retried create makes the same
 * order, never a second one.
 *
 * Deliveries: a partner delivers from its own Sui addresses
 * (`providerDeliveryAddresses`); a transfer from anywhere else is not the
 * partner's, whatever a webhook says.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { normalizeSuiAddress } from '@mysten/sui/utils';

import { isProductionRuntime } from '../server/runtime-mode.ts';
import type { PartnerId } from '../partners/signed-partners.ts';

export const FUNDING_PROVIDER_IDS = ['halliday', 'stripe', 'transfi', 'bridge'] as const;
export type FundingProviderId = (typeof FUNDING_PROVIDER_IDS)[number];
export type FundingMethod = 'bank' | 'card';

export function isFundingProviderId(value: unknown): value is FundingProviderId {
  return typeof value === 'string' && (FUNDING_PROVIDER_IDS as readonly string[]).includes(value);
}

export type FeeLine = {
  /** Who charges it. Never Splash. */
  payee: 'provider' | 'route' | 'circle' | 'network';
  label: string;
  amountMinor: bigint;
};

export type ProviderQuote = {
  provider: FundingProviderId;
  method: FundingMethod;
  /** USDC (minor units) the partner delivers to the wallet. */
  deliverMinor: bigint;
  /** What the business pays the partner, in USD cents, fee included. */
  payUsdCents: bigint;
  lines: FeeLine[];
  quoteRef: string;
  expiresAt: Date;
  sandbox: boolean;
};

export type ProviderNextAction =
  | { kind: 'redirect'; url: string }
  | { kind: 'bank_transfer'; reference: string; note: string };

export type ProviderOrder = {
  providerRef: string;
  next: ProviderNextAction;
  sandbox: boolean;
};

/**
 * Who paid, as the partner reports it (the payer-matching contract, per
 * partner, docs/v2/phase2-funding.md):
 *   bank_account  the paying account itself (country, bank code, number) as
 *                 the partner received it. Splash turns it into its keyed
 *                 fingerprint on receipt and keeps neither the number nor
 *                 the webhook body.
 *   card          the partner's own card fingerprint and last four digits,
 *                 the same values the business added the card with.
 */
export type ReportedPayer =
  | { kind: 'bank_account'; country: string; bankCode: string; accountNumber: string; holderName: string; last4: string }
  | { kind: 'card'; fingerprint: string; holderName: string; last4: string };

export type ProviderEvent = {
  eventId: string;
  providerRef: string;
  /** Echoed back by the partner: the funding intent id. */
  intentId: string;
  status: 'pending' | 'delivered' | 'failed';
  /** The Sui transaction that delivered USDC, on `delivered`. */
  suiDigest?: string;
  payer?: ReportedPayer;
  occurredAt: Date;
};

export class FundingProviderUnavailable extends Error {
  readonly code: 'provider_not_configured' | 'provider_not_connected' | 'provider_disabled' | 'method_not_offered';
  readonly status = 503;
  constructor(message: string, code: FundingProviderUnavailable['code']) {
    super(message);
    this.name = 'FundingProviderUnavailable';
    this.code = code;
  }
}

export class WebhookRejected extends Error {
  readonly code: string;
  constructor(message: string, code = 'bad_signature') {
    super(message);
    this.name = 'WebhookRejected';
    this.code = code;
  }
}

export interface FundingProviderAdapter {
  id: FundingProviderId;
  partner: PartnerId;
  methods: readonly FundingMethod[];
  mode: 'sandbox' | 'live';
  quote(input: { method: FundingMethod; deliverMinor: bigint; walletAddress: string; now: Date }): Promise<ProviderQuote>;
  createOrder(input: { intentId: string; method: FundingMethod; deliverMinor: bigint; walletAddress: string; quoteRef: string; now: Date }): Promise<ProviderOrder>;
  /** Verify a webhook's signature and freshness, then parse it. Throws WebhookRejected. */
  verifyWebhook(input: { rawBody: string; signature: string | null; now: Date }): ProviderEvent;
}

const PROVIDERS: Record<FundingProviderId, { partner: PartnerId; methods: readonly FundingMethod[]; credentials: readonly string[]; enabledFlag: string; enabledByDefault: boolean; sendersEnv: string }> = {
  halliday: { partner: 'halliday', methods: ['bank', 'card'], credentials: ['HALLIDAY_API_KEY', 'HALLIDAY_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_HALLIDAY_ENABLED', enabledByDefault: true, sendersEnv: 'FUNDING_PROVIDER_HALLIDAY_SUI_SENDERS' },
  stripe: { partner: 'stripe', methods: ['card', 'bank'], credentials: ['STRIPE_SECRET_KEY', 'STRIPE_FUNDING_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_STRIPE_ENABLED', enabledByDefault: true, sendersEnv: 'FUNDING_PROVIDER_STRIPE_SUI_SENDERS' },
  transfi: { partner: 'transfi', methods: ['bank', 'card'], credentials: ['TRANSFI_API_KEY', 'TRANSFI_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_TRANSFI_ENABLED', enabledByDefault: true, sendersEnv: 'FUNDING_PROVIDER_TRANSFI_SUI_SENDERS' },
  // In talks (D7): the adapter exists so the interface is whole; off by default.
  bridge: { partner: 'bridge', methods: ['bank'], credentials: ['BRIDGE_API_KEY', 'BRIDGE_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_BRIDGE_ENABLED', enabledByDefault: false, sendersEnv: 'FUNDING_PROVIDER_BRIDGE_SUI_SENDERS' },
};

/**
 * The Sui addresses a partner delivers USDC from (FUNDING_PROVIDER_<ID>_SUI_SENDERS,
 * comma-separated, from the partner's own documentation or contract). A
 * delivery is the partner's only when the transaction's sender is one of
 * them; with none configured, nothing is the partner's (fails closed).
 */
export function providerDeliveryAddresses(id: FundingProviderId, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[PROVIDERS[id].sendersEnv] ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => /^0x[0-9a-fA-F]{1,64}$/.test(a))
    .map((a) => normalizeSuiAddress(a));
}

function flag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const v = (env[key] ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  return v === 'true';
}

export function providerEnabled(id: FundingProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = PROVIDERS[id];
  return flag(env, p.enabledFlag, p.enabledByDefault);
}

export function providerFacts(id: FundingProviderId) {
  return PROVIDERS[id];
}

// ─── Signed webhooks: `t=<unix seconds>,v1=<hex hmac>` over `${t}.${body}` ──

/** A webhook older or newer than this is refused, so a captured one cannot be replayed later. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function signWebhook(rawBody: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const mac = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

export function verifySignedWebhook(rawBody: string, header: string | null, secret: string, now: Date): void {
  if (!secret) throw new WebhookRejected('No webhook secret is configured, so no webhook is accepted.', 'no_secret');
  if (!header) throw new WebhookRejected('The webhook is not signed.');
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) throw new WebhookRejected('The webhook signature is malformed.');
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookRejected('The webhook is outside the replay window.', 'stale');
  }
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected('The webhook signature does not match.');
}

function parseEvent(id: FundingProviderId, rawBody: string): ProviderEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new WebhookRejected('The webhook body is not JSON.', 'bad_body');
  }
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const status = str('status');
  if (!['pending', 'delivered', 'failed'].includes(status)) throw new WebhookRejected(`Unknown ${id} event status.`, 'unknown_event');
  const eventId = str('eventId');
  const providerRef = str('providerRef');
  const intentId = str('intentId');
  if (!/^[A-Za-z0-9_.:-]{6,128}$/.test(eventId) || !/^[A-Za-z0-9_.:-]{6,128}$/.test(providerRef) || !/^fi_[0-9a-f-]{36}$/.test(intentId)) {
    throw new WebhookRejected('The webhook is missing its event, order or intent id.', 'bad_body');
  }
  const digest = str('suiDigest');
  const raw = body.payer as Record<string, unknown> | undefined;
  const occurredAt = new Date(str('occurredAt'));
  let payer: ReportedPayer | undefined;
  if (raw && typeof raw === 'object') {
    const field = (k: string) => String(raw[k] ?? '');
    payer = raw.kind === 'card'
      ? { kind: 'card', fingerprint: field('fingerprint'), holderName: field('holderName'), last4: field('last4') }
      : { kind: 'bank_account', country: field('country'), bankCode: field('bankCode'), accountNumber: field('accountNumber'), holderName: field('holderName'), last4: field('last4') };
  }
  return {
    eventId,
    providerRef,
    intentId,
    status: status as ProviderEvent['status'],
    ...(digest ? { suiDigest: digest } : {}),
    ...(payer ? { payer } : {}),
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date(0) : occurredAt,
  };
}

// ─── Sandbox ────────────────────────────────────────────────────────────────

/** The least length of the sandbox webhook secret: 32 characters, random. */
export const SANDBOX_WEBHOOK_SECRET_MIN_LENGTH = 32;

/**
 * The sandbox's webhook secret, or '' (no sandbox webhook is accepted).
 * Only when FUNDING_SANDBOX_WEBHOOKS_ENABLED is true and
 * FUNDING_SANDBOX_WEBHOOK_SECRET is a random value of at least 32
 * characters. There is no fallback: no string in the repository signs
 * anything, on any deployment. Outside production only (the live adapter
 * never reads it).
 */
export function sandboxWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FUNDING_SANDBOX_WEBHOOKS_ENABLED ?? '').trim().toLowerCase() !== 'true') return '';
  const secret = (env.FUNDING_SANDBOX_WEBHOOK_SECRET ?? '').trim();
  return secret.length >= SANDBOX_WEBHOOK_SECRET_MIN_LENGTH ? secret : '';
}

/**
 * The key the sandbox's order references are made with: random per process,
 * so a reference cannot be worked out from an intent id (a webhook must name
 * both). The intent stores the reference it got.
 */
const SANDBOX_ORDER_KEY = randomBytes(32);

/** The sandbox's fixed order fee: one USDC, whatever the size. A sandbox number, never a partner's. */
const SANDBOX_ORDER_FEE_MINOR = 1_000_000n;
const QUOTE_TTL_MS = 5 * 60 * 1000;

function sandboxAdapter(id: FundingProviderId, env: NodeJS.ProcessEnv): FundingProviderAdapter {
  const facts = PROVIDERS[id];
  const assertMethod = (method: FundingMethod) => {
    if (!facts.methods.includes(method)) throw new FundingProviderUnavailable(`This partner does not take ${method} payments.`, 'method_not_offered');
  };
  return {
    id,
    partner: facts.partner,
    methods: facts.methods,
    mode: 'sandbox',
    async quote({ method, deliverMinor, walletAddress, now }) {
      assertMethod(method);
      const fee = SANDBOX_ORDER_FEE_MINOR;
      // 1 USDC = 100 cents; the sandbox prices USDC at a dollar.
      const payUsdCents = (deliverMinor + fee + 9_999n) / 10_000n;
      const quoteRef = `sbq_${createHash('sha256').update(`${id}:${method}:${deliverMinor}:${walletAddress}:${Math.floor(now.getTime() / QUOTE_TTL_MS)}`).digest('hex').slice(0, 24)}`;
      return {
        provider: id,
        method,
        deliverMinor,
        payUsdCents,
        lines: [{ payee: 'provider', label: 'Partner fee (sandbox)', amountMinor: fee }],
        quoteRef,
        expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
        sandbox: true,
      };
    },
    async createOrder({ intentId, method }) {
      assertMethod(method);
      // Keyed by the intent id under a key nobody outside this process knows:
      // the same intent names the same order, and the reference cannot be
      // worked out from the intent id.
      const providerRef = `sb_${id}_${createHmac('sha256', SANDBOX_ORDER_KEY).update(intentId).digest('hex').slice(0, 24)}`;
      const next: ProviderNextAction = method === 'card'
        ? { kind: 'redirect', url: `/dashboard/wallet?sandbox-checkout=${encodeURIComponent(providerRef)}` }
        : { kind: 'bank_transfer', reference: providerRef, note: 'Sandbox: no bank transfer is made. Nothing arrives until a sandbox delivery is recorded.' };
      return { providerRef, next, sandbox: true };
    },
    verifyWebhook({ rawBody, signature, now }) {
      verifySignedWebhook(rawBody, signature, sandboxWebhookSecret(env), now);
      return parseEvent(id, rawBody);
    },
  };
}

// ─── Live: fails closed ─────────────────────────────────────────────────────

function liveAdapter(id: FundingProviderId, env: NodeJS.ProcessEnv): FundingProviderAdapter {
  const facts = PROVIDERS[id];
  const missing = facts.credentials.filter((k) => !(env[k] ?? '').trim());
  const refuse = (): never => {
    if (missing.length > 0) {
      throw new FundingProviderUnavailable(`This funding partner is not set up on this server (${missing.join(', ')} not set). Nothing was created.`, 'provider_not_configured');
    }
    throw new FundingProviderUnavailable('This funding partner is not connected yet. Nothing was created.', 'provider_not_connected');
  };
  return {
    id,
    partner: facts.partner,
    methods: facts.methods,
    mode: 'live',
    async quote() {
      return refuse();
    },
    async createOrder() {
      return refuse();
    },
    verifyWebhook() {
      // No partner webhook is accepted until its API is wired: a webhook can
      // only ever move an order's status, and there is no live order.
      return refuse();
    },
  };
}

/**
 * The adapter this server uses for a partner: the sandbox outside
 * production, the live adapter in production. Throws when the partner is
 * switched off.
 */
export function fundingProvider(id: FundingProviderId, env: NodeJS.ProcessEnv = process.env): FundingProviderAdapter {
  if (!providerEnabled(id, env)) throw new FundingProviderUnavailable('This funding partner is switched off on this server.', 'provider_disabled');
  return isProductionRuntime(env) ? liveAdapter(id, env) : sandboxAdapter(id, env);
}
