/**
 * Sumsub behind two interfaces (v2 §4.6, D8): KYB/KYC for the business, and
 * the Travel Rule for payments to exchange recipients (VASP-to-VASP data).
 *
 * Every adapter here has a labelled sandbox outside production, and in
 * production fails closed without its credentials: it throws
 * `ComplianceProviderUnavailable`, and nothing downstream sees a session, a
 * verdict or a Travel Rule reference that Sumsub did not give. Only the
 * runtime mode (`isProductionRuntime`) decides; `USE_MOCK_APIS` never brings a
 * sandbox into production.
 *
 * Who the applicant is: the business, `externalUserId = org:<orgId>`. That
 * string is the only part of an inbound webhook Splash controls, and the
 * webhook (lib/server/sumsub-webhook.ts) maps a verdict back to an org by it
 * and by nothing else in the payload.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { PARTNERS } from '../partners/signed-partners.ts';
import { isProductionRuntime } from '../server/runtime-mode.ts';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** A compliance provider that cannot answer here. Its `code` is what a route returns. */
export class ComplianceProviderUnavailable extends Error {
  readonly code: 'kyb_not_configured' | 'travel_rule_not_configured' | 'provider_error' | 'provider_conflict';
  readonly status: number;
  constructor(code: ComplianceProviderUnavailable['code'], message: string, status = code === 'provider_error' ? 502 : code === 'provider_conflict' ? 409 : 503) {
    super(message);
    this.name = 'ComplianceProviderUnavailable';
    this.code = code;
    this.status = status;
  }
}

// ─── The client ──────────────────────────────────────────────────────────────

export type SumsubConfig = { baseUrl: string; appToken: string; secretKey: string; levelName: string };

export function getSumsubConfig(env: NodeJS.ProcessEnv = process.env): SumsubConfig | null {
  const appToken = (env.SUMSUB_APP_TOKEN ?? '').trim();
  const secretKey = (env.SUMSUB_SECRET_KEY ?? '').trim();
  if (!appToken || !secretKey) return null;
  return {
    baseUrl: (env.SUMSUB_BASE_URL ?? '').trim() || 'https://api.sumsub.com',
    appToken,
    secretKey,
    levelName: (env.SUMSUB_LEVEL_NAME ?? '').trim() || 'splash-kyb',
  };
}

/** Sumsub's request signature: HMAC-SHA256 (hex) over ts + METHOD + path-with-query + body. */
export function sumsubSignature(secretKey: string, ts: string, method: string, pathWithQuery: string, body: string): string {
  return createHmac('sha256', secretKey).update(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`).digest('hex');
}

/** One signed request. A non-2xx answer throws with the status only: Sumsub's body may echo what was sent. */
export async function sumsubRequest<T>(
  config: SumsubConfig,
  method: 'POST' | 'GET',
  path: string,
  body: unknown,
  deps: { fetcher?: Fetcher; now?: () => Date } = {},
): Promise<{ status: number; body: T }> {
  const ts = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000).toString();
  const payload = body === undefined ? '' : JSON.stringify(body);
  const res = await (deps.fetcher ?? fetch)(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-App-Token': config.appToken,
      'X-App-Access-Sig': sumsubSignature(config.secretKey, ts, method, path, payload),
      'X-App-Access-Ts': ts,
    },
    body: payload || undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new ComplianceProviderUnavailable(res.status === 409 ? 'provider_conflict' : 'provider_error', `Sumsub answered ${res.status}.`);
  }
  return { status: res.status, body: (await res.json()) as T };
}

// ─── KYB / KYC ───────────────────────────────────────────────────────────────

export const kybExternalUserId = (orgId: string) => `org:${orgId}`;

export type KybSessionInput = { orgId: string; kybCaseId: string; businessName: string; registrationNumber: string };

export type KybSession = {
  provider: 'sumsub' | 'sandbox';
  /** True only for the labelled sandbox, never in production. */
  sandbox: boolean;
  applicantId: string | null;
  externalUserId: string;
  levelName: string;
  accessToken: string;
  expiresAt: string;
};

export interface KybProvider {
  id: 'sumsub' | 'sandbox';
  sandbox: boolean;
  createSession(input: KybSessionInput): Promise<KybSession>;
}

const KYB_TOKEN_TTL_SECONDS = 600;

function sumsubKyb(config: SumsubConfig, deps: { fetcher?: Fetcher; now?: () => Date }): KybProvider {
  return {
    id: 'sumsub',
    sandbox: false,
    async createSession(input) {
      const externalUserId = kybExternalUserId(input.orgId);
      let applicantId: string | null = null;
      try {
        const created = await sumsubRequest<{ id?: unknown }>(config, 'POST', `/resources/applicants?levelName=${encodeURIComponent(config.levelName)}`, {
          externalUserId,
          type: 'company',
          fixedInfo: { companyInfo: { companyName: input.businessName, registrationNumber: input.registrationNumber } },
        }, deps);
        applicantId = typeof created.body.id === 'string' && created.body.id ? created.body.id : null;
      } catch (error) {
        // 409: the applicant exists already (a resumed verification). Anything else is a failure.
        if (!(error instanceof ComplianceProviderUnavailable && error.code === 'provider_conflict')) throw error;
      }
      const token = await sumsubRequest<{ token?: unknown }>(
        config,
        'POST',
        `/resources/accessTokens?userId=${encodeURIComponent(externalUserId)}&levelName=${encodeURIComponent(config.levelName)}&ttlInSecs=${KYB_TOKEN_TTL_SECONDS}`,
        undefined,
        deps,
      );
      if (typeof token.body.token !== 'string' || !token.body.token) throw new ComplianceProviderUnavailable('provider_error', 'Sumsub gave no access token.');
      const now = deps.now?.() ?? new Date();
      return {
        provider: 'sumsub',
        sandbox: false,
        applicantId,
        externalUserId,
        levelName: config.levelName,
        accessToken: token.body.token,
        expiresAt: new Date(now.getTime() + KYB_TOKEN_TTL_SECONDS * 1000).toISOString(),
      };
    },
  };
}

/** The sandbox: a labelled session with no applicant at Sumsub. It never decides a verdict. */
function sandboxKyb(now?: () => Date): KybProvider {
  return {
    id: 'sandbox',
    sandbox: true,
    async createSession(input) {
      const at = now?.() ?? new Date();
      return {
        provider: 'sandbox',
        sandbox: true,
        applicantId: null,
        externalUserId: kybExternalUserId(input.orgId),
        levelName: 'sandbox',
        accessToken: `sandbox_${createHash('sha256').update(`${input.orgId}:${input.kybCaseId}:${at.getTime()}`).digest('hex').slice(0, 24)}`,
        expiresAt: new Date(at.getTime() + KYB_TOKEN_TTL_SECONDS * 1000).toISOString(),
      };
    },
  };
}

/** Sumsub when configured; the sandbox outside production; otherwise a refusal. */
export function kybProviderFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetcher?: Fetcher; now?: () => Date } = {}): KybProvider {
  const config = getSumsubConfig(env);
  if (config) return sumsubKyb(config, deps);
  if (isProductionRuntime(env)) throw new ComplianceProviderUnavailable('kyb_not_configured', 'Business verification is not configured on this server.');
  return sandboxKyb(deps.now);
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * How old a webhook may be. Sumsub retries a failed delivery for about a day
 * (5 minutes, 1 hour, 5 hours, 18 hours), so the window is two days; within
 * it a replay is caught by the delivery's digest, kept once
 * (lib/server/sumsub-webhook.ts). A webhook dated more than five minutes
 * ahead is refused too.
 */
export const SUMSUB_WEBHOOK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const SUMSUB_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

export type VerifiedSumsubWebhook = { ok: true; payload: Record<string, unknown>; replayKey: string; createdAt: Date };
export type RefusedSumsubWebhook = { ok: false; status: 400 | 403; reason: 'unsigned' | 'bad_signature' | 'unknown_algorithm' | 'bad_body' | 'undated' | 'stale' | 'future' };

/** Sumsub's `createdAtMs` ("2026-10-25 08:00:00.123", UTC) or `createdAt` ("2026-10-25 08:00:00+0000"). */
export function sumsubWebhookDate(payload: Record<string, unknown>): Date | null {
  for (const key of ['createdAtMs', 'createdAt']) {
    const raw = payload[key];
    if (typeof raw !== 'string') continue;
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
    if (!m) continue;
    const zone = !m[3] || m[3] === 'Z' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`;
    const d = new Date(`${m[1]}T${m[2]}${zone}`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Verify before reading: the HMAC over the raw body with the webhook secret,
 * in the algorithm Sumsub names (SHA-512, SHA-256, or its SHA-1 default; any
 * other name is refused), then the body, then its date inside the window.
 * Unconfigured verifies as false.
 */
export function verifySumsubWebhook(input: { raw: string; digest: string | null; alg: string | null; secret: string | undefined; now: Date }): VerifiedSumsubWebhook | RefusedSumsubWebhook {
  const secret = (input.secret ?? '').trim();
  if (!secret || !input.digest) return { ok: false, status: 403, reason: 'unsigned' };
  // Sumsub names the algorithm; without the header it is its old default, SHA-1.
  const alg = (input.alg ?? '').trim();
  const algorithm = alg === 'HMAC_SHA512_HEX' ? 'sha512' : alg === 'HMAC_SHA256_HEX' ? 'sha256' : alg === '' || alg === 'HMAC_SHA1_HEX' ? 'sha1' : null;
  if (!algorithm) return { ok: false, status: 403, reason: 'unknown_algorithm' };
  const expected = Buffer.from(createHmac(algorithm, secret).update(input.raw, 'utf8').digest('hex'));
  const given = Buffer.from(input.digest.trim().toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 403, reason: 'bad_signature' };
  let payload: unknown;
  try {
    payload = JSON.parse(input.raw);
  } catch {
    return { ok: false, status: 400, reason: 'bad_body' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, status: 400, reason: 'bad_body' };
  const createdAt = sumsubWebhookDate(payload as Record<string, unknown>);
  if (!createdAt) return { ok: false, status: 400, reason: 'undated' };
  const age = input.now.getTime() - createdAt.getTime();
  if (age > SUMSUB_WEBHOOK_MAX_AGE_MS) return { ok: false, status: 400, reason: 'stale' };
  if (age < -SUMSUB_WEBHOOK_MAX_SKEW_MS) return { ok: false, status: 400, reason: 'future' };
  return { ok: true, payload: payload as Record<string, unknown>, replayKey: createHash('sha256').update(input.raw, 'utf8').digest('hex'), createdAt };
}

/** The org a webhook is about, from the one field Splash set: `externalUserId = org:<orgId>`. */
export function orgFromSumsubPayload(payload: Record<string, unknown>): string | null {
  const external = payload.externalUserId;
  if (typeof external !== 'string' || !external.startsWith('org:')) return null;
  const orgId = external.slice(4);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(orgId) ? orgId : null;
}

/**
 * What a KYB webhook decides. Only a completed review is a verdict: GREEN is
 * the provider's approval, RED with a FINAL rejection is a rejection. A RED
 * the applicant may retry is not a rejection (the business is asked for more,
 * and stays where it is), and anything else is progress.
 */
export function kybDecision(payload: Record<string, unknown>): { next: 'KYB_PROVIDER_APPROVED' | 'REJECTED' | null; reason: string } {
  if (payload.type !== 'applicantReviewed') return { next: null, reason: 'not a verdict' };
  const review = (payload.reviewResult ?? {}) as { reviewAnswer?: unknown; reviewRejectType?: unknown };
  if (review.reviewAnswer === 'GREEN') return { next: 'KYB_PROVIDER_APPROVED', reason: 'GREEN' };
  if (review.reviewAnswer === 'RED') {
    return review.reviewRejectType === 'FINAL' ? { next: 'REJECTED', reason: 'RED FINAL' } : { next: null, reason: 'RED, may retry' };
  }
  return { next: null, reason: 'not decisive' };
}

// ─── Travel Rule (VASP to VASP) ─────────────────────────────────────────────

/** Sumsub's states for a Travel Rule transfer, as Splash keeps them. */
export type TravelRuleStatus = 'submitted' | 'awaiting_counterparty' | 'on_hold' | 'approved' | 'rejected';

const TR_RANK: Record<TravelRuleStatus, number> = { submitted: 0, awaiting_counterparty: 1, on_hold: 1, approved: 2, rejected: 2 };

/** Forward only: a final status never changes, and a later step never goes back to an earlier one. */
export function travelRuleAdvances(from: TravelRuleStatus, to: TravelRuleStatus): boolean {
  if (from === to) return false;
  if (TR_RANK[from] === 2) return false;
  return TR_RANK[to] >= TR_RANK[from];
}

/** The exchanges a wallet recipient may hold its deposit address at (D5a). */
export const TRAVEL_RULE_EXCHANGES = ['hata', 'pdax', 'tokocrypto', 'bitkub'] as const;
export type TravelRuleExchange = (typeof TRAVEL_RULE_EXCHANGES)[number];
export const isTravelRuleExchange = (v: unknown): v is TravelRuleExchange => typeof v === 'string' && (TRAVEL_RULE_EXCHANGES as readonly string[]).includes(v);

/** ISO 3166 alpha-2 to alpha-3, for the countries Splash pays to and from. Anything else is refused, not guessed. */
const ALPHA3: Record<string, string> = {
  MY: 'MYS', PH: 'PHL', ID: 'IDN', TH: 'THA', SG: 'SGP', VN: 'VNM', HK: 'HKG', CN: 'CHN', JP: 'JPN', KR: 'KOR', IN: 'IND',
  AU: 'AUS', NZ: 'NZL', AE: 'ARE', GB: 'GBR', US: 'USA', CA: 'CAN', DE: 'DEU', FR: 'FRA', NL: 'NLD', CH: 'CHE', TW: 'TWN', BN: 'BRN',
};

export function alpha3(country: string): string {
  const code = ALPHA3[country.trim().toUpperCase()];
  if (!code) throw new ComplianceProviderUnavailable('provider_error', `Splash does not send Travel Rule data for country ${country.trim().toUpperCase() || '(none)'}.`, 422);
  return code;
}

export type TravelRuleParty = {
  legalName: string;
  registrationNumber: string | null;
  /** ISO 3166 alpha-2. */
  country: string;
  town?: string | null;
  street?: string | null;
  postCode?: string | null;
};

export type TravelRuleTransferInput = {
  /** The on-chain intent id: Sumsub's txnId, so a retry names the same transfer. */
  intentId: string;
  orgId: string;
  /** The business's Sumsub applicant (its KYB case). */
  applicantId: string;
  at: Date;
  /** USDC, 6 decimals. */
  amountMinor: bigint;
  originator: TravelRuleParty & { walletAddress: string };
  beneficiary: TravelRuleParty & { exchange: TravelRuleExchange; depositAddress: string };
  purpose: string | null;
};

const decimal6 = (minor: bigint) => {
  const s = minor.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0';
};

function sumsubAddress(p: TravelRuleParty) {
  return {
    country: alpha3(p.country),
    ...(p.town ? { town: p.town } : {}),
    ...(p.street ? { street: p.street } : {}),
    ...(p.postCode ? { postCode: p.postCode } : {}),
  };
}

/**
 * The outbound transfer as Sumsub's Travel Rule API takes it: the paying
 * business (the applicant, its own self-hosted business wallet) and the
 * supplier at its exchange (the counterparty, the exchange's deposit
 * address), USDC on Sui. The exchange is named to Sumsub, which routes the
 * message to it; that is not copy, so it does not depend on SIGNED_PARTNERS.
 */
export function sumsubTravelRuleBody(input: TravelRuleTransferInput) {
  const amount = decimal6(input.amountMinor);
  const iso = input.at.toISOString();
  return {
    txnId: input.intentId,
    type: 'travelRule',
    txnDate: `${iso.slice(0, 10)} ${iso.slice(11, 19)}+0000`,
    applicant: {
      type: 'company',
      externalUserId: kybExternalUserId(input.orgId),
      fullName: input.originator.legalName,
      ...(input.originator.registrationNumber ? { registrationNumber: input.originator.registrationNumber } : {}),
      residenceCountry: alpha3(input.originator.country),
      address: sumsubAddress(input.originator),
      paymentMethod: { type: 'unhostedWallet', accountId: input.originator.walletAddress },
    },
    counterparty: {
      type: 'company',
      externalUserId: `supplier:${input.beneficiary.exchange}:${input.beneficiary.depositAddress}`.slice(0, 120),
      fullName: input.beneficiary.legalName,
      ...(input.beneficiary.registrationNumber ? { registrationNumber: input.beneficiary.registrationNumber } : {}),
      residenceCountry: alpha3(input.beneficiary.country),
      address: sumsubAddress(input.beneficiary),
      paymentMethod: { type: 'crypto', accountId: input.beneficiary.depositAddress },
      institutionInfo: { name: PARTNERS[input.beneficiary.exchange].name },
    },
    info: {
      direction: 'out',
      amount: Number(amount),
      currencyCode: 'USDC',
      currencyType: 'crypto',
      cryptoParams: { cryptoChain: 'SUI' },
      ...(input.purpose ? { paymentDetails: input.purpose } : {}),
    },
  };
}

/** Sumsub's review of a Travel Rule transfer, as one of Splash's statuses. */
export function travelRuleStatusOf(review: unknown): TravelRuleStatus {
  const r = (review ?? {}) as { reviewStatus?: unknown; reviewResult?: { reviewAnswer?: unknown } };
  if (r.reviewStatus === 'completed') {
    if (r.reviewResult?.reviewAnswer === 'GREEN') return 'approved';
    if (r.reviewResult?.reviewAnswer === 'RED') return 'rejected';
  }
  if (r.reviewStatus === 'onHold') return 'on_hold';
  if (r.reviewStatus === 'awaitingUser' || r.reviewStatus === 'awaitingCounterparty') return 'awaiting_counterparty';
  return 'submitted';
}

export type TravelRuleSubmission = { provider: 'sumsub' | 'sandbox'; sandbox: boolean; reference: string; status: TravelRuleStatus };

export interface TravelRuleProvider {
  id: 'sumsub' | 'sandbox';
  sandbox: boolean;
  submitOutbound(input: TravelRuleTransferInput): Promise<TravelRuleSubmission>;
}

function sumsubTravelRule(config: SumsubConfig, deps: { fetcher?: Fetcher; now?: () => Date }): TravelRuleProvider {
  return {
    id: 'sumsub',
    sandbox: false,
    async submitOutbound(input) {
      const body = sumsubTravelRuleBody(input);
      const res = await sumsubRequest<{ id?: unknown; data?: { txnId?: unknown }; review?: unknown }>(
        config,
        'POST',
        `/resources/applicants/${encodeURIComponent(input.applicantId)}/kyt/txns/-/data`,
        body,
        deps,
      );
      const id = typeof res.body.id === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(res.body.id) ? res.body.id : null;
      // Sumsub's answer must name the transfer it took: no id, or another txnId, is no submission.
      if (!id) throw new ComplianceProviderUnavailable('provider_error', 'Sumsub did not name the Travel Rule transfer.');
      if (res.body.data?.txnId !== undefined && res.body.data.txnId !== input.intentId) {
        throw new ComplianceProviderUnavailable('provider_error', 'Sumsub named another transfer.');
      }
      return { provider: 'sumsub', sandbox: false, reference: id, status: travelRuleStatusOf(res.body.review) };
    },
  };
}

/** The sandbox: a labelled reference derived from the intent id, status submitted. Never in production. */
function sandboxTravelRule(): TravelRuleProvider {
  return {
    id: 'sandbox',
    sandbox: true,
    async submitOutbound(input) {
      sumsubTravelRuleBody(input); // the same checks as the real request (countries)
      return { provider: 'sandbox', sandbox: true, reference: `sandbox_tr_${createHash('sha256').update(input.intentId).digest('hex').slice(0, 24)}`, status: 'submitted' };
    },
  };
}

/** Sumsub when configured and switched on; the sandbox outside production; otherwise a refusal. */
export function travelRuleProviderFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetcher?: Fetcher; now?: () => Date } = {}): TravelRuleProvider {
  const config = getSumsubConfig(env);
  if (config && env.SUMSUB_TRAVEL_RULE_ENABLED === 'true') return sumsubTravelRule(config, deps);
  if (isProductionRuntime(env)) {
    throw new ComplianceProviderUnavailable('travel_rule_not_configured', 'The Travel Rule message to exchanges is not configured on this server.');
  }
  return sandboxTravelRule();
}

/**
 * A Travel Rule webhook's event: Sumsub's transfer id, the txnId Splash gave
 * it (the intent id), and the status it moves to. Null for anything else.
 */
export function travelRuleEventOf(payload: Record<string, unknown>): { reference: string; txnId: string | null; status: TravelRuleStatus } | null {
  const type = payload.type;
  const status: TravelRuleStatus | null =
    type === 'applicantKytTxnApproved' ? 'approved'
      : type === 'applicantKytTxnRejected' ? 'rejected'
        : type === 'applicantKytOnHold' ? 'on_hold'
          : type === 'applicantKytTxnAwaitingUser' ? 'awaiting_counterparty'
            : null;
  if (!status) return null;
  const reference = typeof payload.kytTxnId === 'string' ? payload.kytTxnId : null;
  if (!reference) return null;
  const txnId = typeof payload.kytDataTxnId === 'string' ? payload.kytDataTxnId : null;
  return { reference, txnId, status };
}
