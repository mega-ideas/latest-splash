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
 * Idempotency: the funding intent's id is the order's idempotency key (and
 * the sandbox's order reference is derived from it), so a retried create
 * makes the same order, never a second one.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

/** Who paid, as the partner reports it. Never the full account or card number. */
export type ReportedPayer = {
  kind: 'bank_account' | 'card';
  /** For a bank account: its fingerprint from bankAccountIdentity. For a card: the partner's card fingerprint. */
  fingerprint: string;
  holderName: string;
  last4: string;
};

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

const PROVIDERS: Record<FundingProviderId, { partner: PartnerId; methods: readonly FundingMethod[]; credentials: readonly string[]; enabledFlag: string; enabledByDefault: boolean }> = {
  halliday: { partner: 'halliday', methods: ['bank', 'card'], credentials: ['HALLIDAY_API_KEY', 'HALLIDAY_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_HALLIDAY_ENABLED', enabledByDefault: true },
  stripe: { partner: 'stripe', methods: ['card', 'bank'], credentials: ['STRIPE_SECRET_KEY', 'STRIPE_FUNDING_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_STRIPE_ENABLED', enabledByDefault: true },
  transfi: { partner: 'transfi', methods: ['bank', 'card'], credentials: ['TRANSFI_API_KEY', 'TRANSFI_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_TRANSFI_ENABLED', enabledByDefault: true },
  // In talks (D7): the adapter exists so the interface is whole; off by default.
  bridge: { partner: 'bridge', methods: ['bank'], credentials: ['BRIDGE_API_KEY', 'BRIDGE_WEBHOOK_SECRET'], enabledFlag: 'FUNDING_PROVIDER_BRIDGE_ENABLED', enabledByDefault: false },
};

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
  const payer = body.payer as Record<string, unknown> | undefined;
  const occurredAt = new Date(str('occurredAt'));
  return {
    eventId,
    providerRef,
    intentId,
    status: status as ProviderEvent['status'],
    ...(digest ? { suiDigest: digest } : {}),
    ...(payer && typeof payer === 'object'
      ? {
          payer: {
            kind: payer.kind === 'card' ? 'card' : 'bank_account',
            fingerprint: String(payer.fingerprint ?? ''),
            holderName: String(payer.holderName ?? ''),
            last4: String(payer.last4 ?? ''),
          },
        }
      : {}),
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date(0) : occurredAt,
  };
}

// ─── Sandbox ────────────────────────────────────────────────────────────────

/** The sandbox's webhook secret: FUNDING_SANDBOX_WEBHOOK_SECRET, or a fixed one. Outside production only. */
export function sandboxWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.FUNDING_SANDBOX_WEBHOOK_SECRET || 'splash-sandbox-funding-webhook';
}

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
      // Derived from the intent id: the same intent always names the same order.
      const providerRef = `sb_${id}_${createHash('sha256').update(intentId).digest('hex').slice(0, 20)}`;
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
