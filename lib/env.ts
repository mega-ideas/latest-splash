/**
 * The environment contract.
 *
 * Every variable the application reads is declared here, once, with its
 * shape and its development default. `validateEnvAtBoot()` runs from
 * instrumentation.ts before the first request is served: in production a
 * missing or malformed key refuses to start and names every problem at once;
 * in development the documented defaults apply and the app runs.
 *
 * Why this exists. There were 146 distinct keys read across app/, lib/ and
 * components/ through three different patterns — `process.env.X`, an aliased
 * `env.X`, and string-keyed lookups such as `process.env[FIELD_TO_ENV[f]]` —
 * with no validation anywhere. Seal's loader alone throws on twelve
 * conditions, all at request time, so two machines with different .env.local
 * files both started cleanly and then diverged on whichever route one of them
 * happened to hit first. Loud failure at boot beats silent divergence at
 * request time.
 *
 * Two rules keep it true:
 *
 *   1. Any new `process.env` read is added here in the same commit.
 *      scripts/check-env-reads.mjs enforces it under `npm run lint`: a key
 *      read anywhere that is not declared below fails the build.
 *   2. Configuration that must match between machines is a committed file,
 *      not an env var. The Seal server list moves to config/seal.<env>.json;
 *      only secrets stay here.
 *
 * Existing read sites keep working unchanged — this file validates the same
 * names they read. New code should read `getEnv()` instead, which returns the
 * coerced, typed values.
 *
 * What is required in production, and why. Unconditionally: the things the
 * app cannot run safely without — session secrets (and not the demo values
 * .env.example ships), the database, the published package, an https app
 * URL, and the cron secret. Conditionally, decided by the flags themselves:
 * settlement keys when settlement is live, vendor keys when their feature is
 * on or mocks are off. Development requires nothing and defaults everything,
 * which is what a fresh clone needs to boot.
 */
import { DEFAULT_COPILOT_MODEL } from './ai/model.ts';
import { z } from 'zod';

/* ── Shapes ───────────────────────────────────────────────────────────── */

const OBJECT_ID = /^0x[a-fA-F0-9]{64}$/;
const SUI_ADDRESS = OBJECT_ID;
/** bech32 secret key as printed by `sui keytool`; the SDK decodes it. */
const SUI_PRIVKEY = /^suiprivkey1[a-z0-9]{50,}$/;
/** `0x…::module::Type` — a Move type tag. `0x2::sui::SUI` is the dev stand-in. */
const COIN_TYPE = /^0x[a-fA-F0-9]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

const str = z.string().trim();
const optional = str.optional();
/** Empty string counts as unset, which is how `.env.example` ships blanks. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <Out>(schema: z.ZodType<Out, unknown>) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <Out extends string | number | boolean>(schema: z.ZodType<Out, unknown>, def: Out) =>
  z.preprocess(blankToUndefined, schema.default(def));

const objectId = opt(str.regex(OBJECT_ID, 'must be a canonical 0x + 64 hex Sui object ID'));
const suiAddress = opt(str.regex(SUI_ADDRESS, 'must be a 0x + 64 hex Sui address'));
const privkey = opt(str.regex(SUI_PRIVKEY, 'must be a suiprivkey1… secret key'));
const coinType = opt(str.regex(COIN_TYPE, 'must be a Move type tag like 0x…::module::Type'));
const url = opt(str.url());
const httpsUrl = opt(str.url().refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), 'must be https (or http://localhost)'));
const int = (def: number, min = 0) => withDefault(z.coerce.number().int().min(min), def);
const num = (def: number) => withDefault(z.coerce.number(), def);
/** The code tests `=== 'true'`; anything else is false. */
/** A key that moved into config/seal.<env>.json. Unset is the only valid
 *  state; a value means a stale .env.local or host panel, and boot names it. */
/** A key whose feature was removed. Unset is the only valid state. */
const removedFromEnv = z.preprocess(
  blankToUndefined,
  z.undefined({ error: 'no longer used — accounts are rows in `users`; remove it from .env.local and from the host' }),
);

const renamedAnchorCap = z.preprocess(
  blankToUndefined,
  z.undefined({ error: 'renamed to SPLASH_ANCHOR_CAP_ID with the Phase 6 cap split — set that instead, and remove this from .env.local and from the host' }),
);

const movedToSealFile = z.preprocess(
  blankToUndefined,
  z.undefined({ error: 'moved to config/seal.<env>.json — remove it from .env.local and from the host' }),
);

const flag = (def: 'true' | 'false' = 'false') =>
  withDefault(z.enum(['true', 'false']), def).transform((v) => v === 'true');

/* ── The schema ───────────────────────────────────────────────────────── */

export const envSchema = z.object({
  NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),

  /* Sui network and the published contracts. lib/sui.ts and
     lib/server/contract-config.ts (FIELD_TO_ENV, as the fallback behind
     data/contract-config.json). */
  SUI_NETWORK: withDefault(z.enum(['testnet', 'mainnet']), 'testnet'),
  NEXT_PUBLIC_SUI_NETWORK: opt(z.enum(['testnet', 'mainnet'])),
  SUI_RPC_URL: url,
  SPLASH_PACKAGE_ID: objectId,
  SPLASH_CORE_PACKAGE_ID: objectId,
  SPLASH_CUSTODY_PACKAGE_ID: objectId,
  SPLASH_PAYOUT_DELEGATION_ID: objectId,
  SPLASH_TREASURY_ID: objectId,
  SPLASH_ADMIN_CAP_ID: objectId,
  /** Phase 6 split the money authority out of `AdminCap`. This is the cap that
   *  can take value out of a custodial object, and the ONLY one — it belongs on
   *  the cold 2-of-3 and must never be online. */
  SPLASH_TREASURY_CAP_ID: objectId,
  SPLASH_ANCHOR_CAP_ID: objectId,
  /** Phase 7 break-glass. The shared CapRegistry holding the live generation
   *  for each revocable capability. Every call that USES an AnchorCap or a
   *  ComplianceCap passes it, so a revoked capability stops working on chain
   *  rather than being rejected by convention off it. */
  SPLASH_CAP_REGISTRY_ID: objectId,
  /** Renamed with the Phase 6 cap split (`AttestationCap` -> `AnchorCap`).
   *  Declared must-be-unset rather than silently ignored: a stale object id
   *  under the old name would point at a capability type that no longer
   *  exists, and a key that governs nothing but still reads like a control
   *  is worse than no key. */
  SPLASH_ATTESTATION_CAP_ID: renamedAnchorCap,
  SPLASH_PEG_STATE_ID: objectId,
  SPLASH_COMPLIANCE_CONFIG_ID: objectId,
  SPLASH_COMPLIANCE_CAP_ID: objectId,
  SPLASH_BUSINESS_ACCOUNT_ID: objectId,
  SPLASH_TRANSFER_COIN_ID: objectId,
  SPLASH_SETTLEMENT_REGISTRY_ID: objectId,
  SPLASH_TEST_RECIPIENT_ADDRESS: suiAddress,
  SPLASH_SMART_TREASURY_SUI_ID: objectId,
  SPLASH_USDC_TREASURY_ID: objectId,
  SPLASH_USDY_TREASURY_ID: objectId,
  DEEPBOOK_POOL_ID: objectId,
  DEEPBOOK_QUOTE_TYPE: coinType,
  USDC_TYPE: coinType,
  USDT_TYPE: coinType,
  USDY_TYPE: coinType,
  USDSUI_TYPE: coinType,
  USDT_BUFFER_ID: objectId,
  TREASURY_ADDRESS: suiAddress,
  OPERATOR_SUI_ADDRESS: suiAddress,
  MIN_USDC_FLOAT_MICRO: int(0),
  SPLASH_SETTLEMENT_COIN_TYPE: coinType,
  SPLASH_PEG_USDC_DEVIATION_PPM: int(0),
  SPLASH_PEG_USDT_DEVIATION_PPM: int(0),

  /* Settlement. lib/server/sui-settlement.ts, lib/sui/gas.ts. */
  SUI_SETTLEMENT_MODE: withDefault(z.enum(['auto', 'live', 'simulate']), 'auto'),
  SUI_BATCH_SETTLEMENT_MODE: optional,
  OPERATOR_SUI_PRIVATE_KEY: privkey,
  SUI_SPONSOR_PRIVATE_KEY: privkey,
  ENOKI_API_KEY: optional,
  SUI_PEG_UPDATE_GAS_BUDGET: int(10_000_000, 1),
  SUI_RECORD_SETTLEMENT_GAS_BUDGET: int(10_000_000, 1),
  SUI_COMPOSED_GAS_BUDGET: int(30_000_000, 1),
  SUI_AUDIT_ANCHOR_GAS_BUDGET: int(20_000_000, 1),
  SUI_KYB_VERIFY_GAS_BUDGET: int(20_000_000, 1),
  USE_MOCK_APIS: flag('false'),

  /* 0xWal chain composition. lib/chain/compose.ts, lib/agent/oxwal.ts. */
  OXWAL_CHAIN_MODE: withDefault(z.enum(['mock', 'live']), 'mock'),
  OXWAL_SUI_SENDER: suiAddress,
  OXWAL_GAS_BUDGET: opt(z.coerce.number().int().min(1)),
  OXWAL_FORCE_LOCAL: flag('false'),
  OXWAL_OPERATOR_ROLE: withDefault(str, 'APPROVER'),

  /* Seal. The committee, threshold, package and policy live in a committed
     file — config/seal.<NODE_ENV>.json — loaded and validated by
     lib/server/seal-config.ts, which validateEnvAtBoot() runs so its twelve
     checks happen at boot. The seven keys below MOVED into that file: each
     is declared here only so that, if one is still set, boot fails and
     names it. Two sources for one setting is how Seal diverged. */
  SEAL_CONFIG_FILE: optional,
  SEAL_KEY_SERVER_ENDPOINTS: movedToSealFile,
  SEAL_KEY_SERVER_URLS: movedToSealFile,
  SEAL_KEY_SERVER_MODE: movedToSealFile,
  SEAL_THRESHOLD: movedToSealFile,
  SEAL_PACKAGE_ID: movedToSealFile,
  SEAL_POLICY_OBJECT_ID: movedToSealFile,
  SEAL_APPROVE_TARGET: movedToSealFile,
  /* What stays in env: operational and sensitive, not shared config. */
  SEAL_HEALTH_TIMEOUT_MS: int(10_000, 1),
  SEAL_ALERT_WEBHOOK_URL: httpsUrl,

  /* Walrus. lib/server/walrus.ts. Mocked when USE_MOCK_APIS or unset. */
  WALRUS_PUBLISHER_URL: url,
  WALRUS_AGGREGATOR_URL: url,

  /* Storage and data directory. */
  DATABASE_URL: opt(str.regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL')),
  DATABASE_POOL_MAX: int(10, 1),
  REDIS_URL: url,
  REDIS_TIMEOUT_MS: int(500, 1),
  SPLASH_DATA_DIR: optional,

  /* Sessions and staff auth. lib/server/customer-auth.ts, admin-auth.ts.
     The demo values are refused in production below. */
  CUSTOMER_SESSION_SECRET: optional,
  /* Removed with the single-credential login. Accounts are rows in `users`
     with a scrypt hash, so these two governed nothing after that — and a
     password sitting in an environment file that no longer decides anything
     is worse than none, because it reads as a control. Declared so a stale
     value fails boot by name. */
  CUSTOMER_EMAIL: removedFromEnv,
  CUSTOMER_PASSWORD: removedFromEnv,
  CUSTOMER_ORGANIZATION: optional,
  CUSTOMER_SELF_SIGNUP_ENABLED: flag('false'),
  CUSTOMER_RECOVERY_EMAIL: opt(str.email()),
  /* Email delivery. lib/auth/email-transport.ts. Verification links and
     password resets go through it, and a membership grant requires a
     verified mailbox, so without delivery nobody can be granted anything.
     `console` prints the link to the server log and is development only. */
  EMAIL_TRANSPORT: withDefault(z.enum(['console', 'resend']), 'console'),
  EMAIL_API_KEY: optional,
  EMAIL_FROM: opt(str.email()),
  ADMIN_SESSION_SECRET: optional,
  ADMIN_EMAIL: opt(str.email()),
  ADMIN_PASSWORD: optional,
  SPLASH_TOTP_SECRET: optional,
  KILLED_ENTITY_DOMAINS: optional,
  CRON_SECRET: optional,
  ALLOWED_ORIGINS: optional,
  NEXT_PUBLIC_APP_URL: withDefault(str.url(), 'http://localhost:3000'),
  NEXT_PUBLIC_SUPPORT_EMAIL: opt(str.email()),

  /* zkLogin. lib/auth/zklogin.ts, app/api/auth/zklogin/route.ts. The client
     ID is part of address derivation: it is decided once per environment and
     never rotated after users exist. */
  FEATURE_ZKLOGIN: flag('false'),
  ZKLOGIN_GOOGLE_CLIENT_ID: optional,
  ZKLOGIN_MICROSOFT_CLIENT_ID: optional,
  ZKLOGIN_USER_SALT: optional,

  /**
   * WebAuthn relying-party id. A credential is bound to it and the browser
   * will not offer it on any other host, so a passkey enrolled on localhost
   * cannot be used on v1.splashz.xyz. Decided once per environment; changing
   * it after anyone has enrolled orphans every existing credential.
   *
   * Deliberately configuration rather than derived from the request Host —
   * an attacker who could influence that header could otherwise enrol a
   * credential under an rpId they control.
   */
  PASSKEY_RP_ID: optional,

  /* KYB and compliance. lib/compliance/*. */
  FEATURE_KYB_GATE: flag('false'),
  SUMSUB_APP_TOKEN: optional,
  SUMSUB_SECRET_KEY: optional,
  SUMSUB_LEVEL_NAME: withDefault(str, 'splash-kyb'),
  SUMSUB_BASE_URL: withDefault(str.url(), 'https://api.sumsub.com'),
  DEFAULT_KYC_TIER: int(1, 0),
  KYB_TIER1_MAX_USD: int(50_000),
  KYB_TIER2_MAX_USD: int(250_000),
  KYB_TIER3_MAX_USD: int(1_000_000),
  AML_REVIEW_THRESHOLD_USD: int(10_000),
  RAIL_MAX_ACH_USD: int(1_000_000),
  RAIL_MAX_WIRE_USD: int(1_000_000),
  RAIL_MAX_FPX_USD: int(250_000),
  RAIL_MAX_AIRWALLEX_USD: int(1_000_000),
  MIN_SETTLEMENT_USD: opt(z.coerce.number().min(0)),
  LEGAL_APPROVED: flag('false'),

  /* Quotes, fees, corridors. lib/server/quote.ts, pdax.ts, operations.ts. */
  PLATFORM_FEE_BPS: opt(z.coerce.number().int().min(0).max(200)),
  FIXED_FEE_CENTS: int(450),
  FIXED_FEE_SEN: opt(z.coerce.number().int().min(0)),
  QUOTE_TTL_SECONDS: int(30, 1),
  FUNDING_DISCOUNT_BPS: int(20),
  PHP_PER_USDC: num(56.5),
  MYR_TO_USD_RATE: opt(z.coerce.number().positive()),
  FALLBACK_MYR_USD_RATE: opt(z.coerce.number().positive()),
  RATE_HOLD_HOURS: int(48, 1),
  NEXT_PUBLIC_DEMO_MODE: flag('false'),
  NEXT_PUBLIC_STORED_BALANCE_CORRIDORS: optional,
  STORED_BALANCE_CORRIDORS: optional,
  SWEEP_ACCOUNT_ENABLED: withDefault(z.enum(['true', 'false']), 'true').transform((v) => v !== 'false'),
  TREASURY_EXECUTION_ENABLED: flag('false'),
  COMPOSED_TREASURY_ALLOCATION_BPS: int(100, 0),
  MAYBANK_INTERCOMPANY_ENABLED: flag('true'),

  /* Funding rails and providers. lib/server/funding-*.ts, stripe.ts,
     airwallex.ts, lib/funding/registry.ts. */
  CARD_FUNDING_ENABLED: flag('false'),
  FEATURE_DUAL_FUNDING: flag('true'),
  CARD_FUNDING_SURCHARGE_BPS: int(290),
  STRIPE_SECRET_KEY: optional,
  AIRWALLEX_API_KEY: optional,
  FUNDING_WEBHOOK_SECRET: optional,
  FUNDING_DEPOSIT_DERIVATION_SECRET: optional,
  FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON: opt(str.refine((s) => { try { return typeof JSON.parse(s) === 'object'; } catch { return false; } }, 'must be a JSON object')),
  FUNDING_DEX_QUOTES_JSON: opt(str.refine((s) => { try { JSON.parse(s); return true; } catch { return false; } }, 'must be valid JSON')),
  FUNDING_SELF_CUSTODY_STAGED_LIMIT_USD: int(10_000),
  FUNDING_ASSET_USDC_ENABLED: flag('true'),
  FUNDING_ASSET_USDT_ENABLED: flag('false'),
  FUNDING_ASSET_USDSUI_ENABLED: flag('true'),
  FUNDING_RAIL_SUI_NATIVE_ENABLED: flag('true'),
  FUNDING_RAIL_CCTP_ENABLED: flag('true'),
  FUNDING_CCTP_ETHEREUM_ENABLED: flag('false'),
  FUNDING_CCTP_BASE_ENABLED: flag('false'),
  FUNDING_CCTP_ARBITRUM_ENABLED: flag('false'),
  FUNDING_CCTP_SOLANA_ENABLED: flag('false'),
  FUNDING_PROVIDER_STRIPE_ENABLED: flag('true'),
  FUNDING_PROVIDER_AIRWALLEX_ENABLED: flag('true'),
  USDC_AVAILABLE_MICRO: opt(z.coerce.number().int().min(0)),
  USDT_AVAILABLE_MICRO: opt(z.coerce.number().int().min(0)),
  USDT_BUFFER_AGE_MS: int(0),

  /* Payout and settlement partners. Mocked when USE_MOCK_APIS or unset. */
  PDAX_API_BASE_URL: url,
  PDAX_API_KEY: optional,
  LABUAN_API_BASE_URL: withDefault(str.url(), 'https://settlement.splash-labuan.internal'),
  LABUAN_API_KEY: optional,
  LABUAN_OTC_MIN_USD: int(10_000),
  DEEPBOOK_INDEXER_URL: url,
  DEEPBOOK_STABLE_PAIR: optional,
  DEEPBOOK_TIMEOUT_MS: int(2_500, 1),
  DEEPBOOK_PEG_TOLERANCE_BPS: int(100, 0),

  /* Treasury and yield. lib/server/usdy.ts, treasury.ts, copilot.ts. */
  USDY_NET_APY_PCT: opt(z.coerce.number()),
  USDY_NAV_STALE_MS: int(6 * 60 * 60 * 1000, 1),
  USDY_REDEMPTION_USD: opt(z.coerce.number().min(0)),
  USDY_REDEMPTION_AS_OF: optional,
  USDY_SWAP_SLIPPAGE_BPS: int(30, 0),
  USDY_SWAP_VENUE: withDefault(z.enum(['cetus', 'aftermath']), 'cetus'),
  USDY_WITHDRAWAL_DAYS: int(2, 0),
  SPLASH_PROMO_APY_PCT: opt(z.coerce.number()),
  SPLASH_PROMO_UNTIL: optional,
  OPERATING_BUFFER_USD: int(5_000),
  BATCH_SAVED_BPS_PER_ROW: int(6),
  SPLASH_BUSINESS_TIMEZONE: withDefault(str, 'Asia/Singapore'),
  PROOF_TX_1: optional,
  PROOF_TX_2: optional,

  /* Copilot and memory. */
  ANTHROPIC_API_KEY: optional,
  /** Overrides lib/ai/model.ts. The old default here was a model id that does
   *  not exist, so every call threw and fell back to canned text. */
  ANTHROPIC_MODEL: withDefault(str, DEFAULT_COPILOT_MODEL),

  // WhatsApp approvals, through Twilio. All three are needed together —
  // `whatsappConfigured()` is false unless every one is set, because a
  // half-configured sender fails at the moment an approval is requested.
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  /** The WhatsApp-enabled sender, E.164. */
  TWILIO_WHATSAPP_FROM: optional,
  /** The URL Twilio was configured to call. Twilio signs the URL it was
   *  given, which behind a proxy is not the URL the request arrives at — so
   *  signature verification uses this when set, and the request URL when not. */
  TWILIO_WEBHOOK_URL: optional,

  /** Signs Sumsub's inbound webhooks. Without it the KYB verdict endpoint
   *  refuses every request, which is the correct direction: an unverified
   *  webhook could launder an unchecked business into the state a human
   *  signs off on the basis that a provider already checked it. */
  SUMSUB_WEBHOOK_SECRET: optional,
  MEMWAL_PRIVATE_KEY: optional,
  MEMWAL_ACCOUNT_ID: objectId,
  MEMWAL_SERVER_URL: url,
  MEMWAL_NAMESPACE: optional,
});

export type Env = z.infer<typeof envSchema>;

/** Every declared key. scripts/check-env-reads.mjs compares reads to this. */
export const ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);

/** Keys read by dynamic name. lib/auth/totp.ts reads
 *  `SPLASH_TOTP_SECRET_${ACCOUNT}` for per-tenant secrets; lib/chain/compose.ts
 *  reads `OXWAL_MOVE_TARGET_${KIND}` for per-proposal-kind Move targets. */
export const ENV_KEY_PREFIXES: readonly string[] = ['SPLASH_TOTP_SECRET_', 'OXWAL_MOVE_TARGET_'];

/* ── Production rules ─────────────────────────────────────────────────── */

/** The values .env.example ships for local demo. Never acceptable in prod. */
const DEMO_VALUES: Partial<Record<keyof Env, string[]>> = {
  ADMIN_PASSWORD: ['splash-admin-demo'],
};

type Issue = { key: string; message: string };

function productionIssues(env: Env): Issue[] {
  const issues: Issue[] = [];
  const need = (key: keyof Env, why: string) => {
    if (env[key] === undefined || env[key] === '') issues.push({ key, message: `required in production — ${why}` });
  };
  const notDemo = (key: keyof Env) => {
    const v = env[key];
    if (typeof v === 'string' && DEMO_VALUES[key]?.includes(v)) {
      issues.push({ key, message: `is the demo value from .env.example; set a real one` });
    }
  };

  /* Unconditional: what the app cannot run safely without. */
  need('CUSTOMER_SESSION_SECRET', 'sessions would be signed with nothing');
  need('ADMIN_SESSION_SECRET', 'staff sessions would be signed with nothing, and lib/server/seal.ts falls back to a hard-coded dev key');
  need('CRON_SECRET', 'every /api/cron route would accept any caller');
  need('DATABASE_URL', 'authority and persistence require Postgres');
  need('SPLASH_PACKAGE_ID', 'nothing can be composed against 0x0');
  notDemo('ADMIN_PASSWORD');
  if (!env.NEXT_PUBLIC_APP_URL.startsWith('https://')) {
    issues.push({ key: 'NEXT_PUBLIC_APP_URL', message: 'must be https in production' });
  }
  if (env.USDC_TYPE === '0x2::sui::SUI') {
    issues.push({ key: 'USDC_TYPE', message: 'is the development stand-in (native SUI); set the real USDC coin type' });
  }

  /* Email: a grant requires a verified mailbox, and verification is a link
     delivered to it. `console` only prints the link to the server log, so a
     production deployment on it can never verify anyone — and therefore
     never grant anyone anything. */
  if (env.EMAIL_TRANSPORT === 'console') {
    issues.push({
      key: 'EMAIL_TRANSPORT',
      message: 'is `console`, which only prints verification links to the server log; set `resend` — no account can be verified, and so none granted access, without delivery',
    });
  }
  if (env.EMAIL_TRANSPORT === 'resend') {
    need('EMAIL_API_KEY', 'EMAIL_TRANSPORT=resend');
    need('EMAIL_FROM', 'EMAIL_TRANSPORT=resend — the sender address');
  }

  /* Settlement: keys are required when settlement can actually move value.
     'auto' with mocks off resolves to live at runtime. */
  const settlementLive = env.SUI_SETTLEMENT_MODE === 'live' || (env.SUI_SETTLEMENT_MODE === 'auto' && !env.USE_MOCK_APIS);
  if (settlementLive) {
    need('OPERATOR_SUI_PRIVATE_KEY', `SUI_SETTLEMENT_MODE=${env.SUI_SETTLEMENT_MODE} with mocks off means real signing`);
    need('OPERATOR_SUI_ADDRESS', 'the signer must be named so it can be checked against the key');
    need('SPLASH_TREASURY_ID', 'settlement records against the treasury object');
    need('USDC_TYPE', 'settlement needs the real coin type');
  }
  if (env.TREASURY_EXECUTION_ENABLED) {
    need('OPERATOR_SUI_PRIVATE_KEY', 'TREASURY_EXECUTION_ENABLED moves treasury funds');
  }
  if (env.OXWAL_CHAIN_MODE === 'live') {
    need('OXWAL_SUI_SENDER', 'OXWAL_CHAIN_MODE=live composes real transactions');
  }

  /* Vendors: required when their feature is on. Mocks and demo mode make
     them optional, which is a posture decision recorded by those flags. */
  const vendorsLive = !env.USE_MOCK_APIS && !env.NEXT_PUBLIC_DEMO_MODE;
  if (vendorsLive) {
    need('PDAX_API_KEY', 'PHP payout is live (USE_MOCK_APIS and NEXT_PUBLIC_DEMO_MODE are both off)');
    need('WALRUS_PUBLISHER_URL', 'audit proofs are live');
    need('WALRUS_AGGREGATOR_URL', 'audit proofs are live');
    need('ENOKI_API_KEY', 'sponsored transactions are live');
  }
  if (env.CARD_FUNDING_ENABLED || (vendorsLive && env.FUNDING_PROVIDER_STRIPE_ENABLED)) {
    need('STRIPE_SECRET_KEY', env.CARD_FUNDING_ENABLED ? 'CARD_FUNDING_ENABLED=true' : 'Stripe funding is enabled and mocks are off');
  }
  if (vendorsLive && env.FUNDING_PROVIDER_AIRWALLEX_ENABLED) need('AIRWALLEX_API_KEY', 'Airwallex funding is enabled and mocks are off');
  if (env.FEATURE_KYB_GATE) {
    need('SUMSUB_APP_TOKEN', 'FEATURE_KYB_GATE=true');
    need('SUMSUB_SECRET_KEY', 'FEATURE_KYB_GATE=true');
  }
  if (env.FEATURE_ZKLOGIN) {
    need('ZKLOGIN_GOOGLE_CLIENT_ID', 'FEATURE_ZKLOGIN=true — and it is part of address derivation, so decide it once per environment');
    need('ZKLOGIN_USER_SALT', 'FEATURE_ZKLOGIN=true');
  }
  if ((env.MEMWAL_PRIVATE_KEY === undefined) !== (env.MEMWAL_ACCOUNT_ID === undefined)) {
    issues.push({ key: 'MEMWAL_PRIVATE_KEY', message: 'MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID must be set together or not at all' });
  }

  return issues;
}

/* ── Entry points ─────────────────────────────────────────────────────── */

export class EnvValidationError extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[], mode: string) {
    super(
      `Environment is invalid for NODE_ENV=${mode} — ${issues.length} problem${issues.length === 1 ? '' : 's'}:\n` +
        issues.map((i) => `  ${i.key}: ${i.message}`).join('\n') +
        '\n\nEvery variable is declared in lib/env.ts. Run `npm run doctor` for a full table.',
    );
    this.issues = issues;
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate a raw environment. Pure: takes the object, returns the typed env
 * or throws EnvValidationError naming every problem. Tests call this with
 * literal objects; the boot path calls it with process.env.
 */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  const mode = raw.NODE_ENV ?? 'development';
  const issues: Issue[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({ key: issue.path.map(String).join('.') || '(root)', message: issue.message });
    }
  }
  if (mode === 'production' && result.success) {
    issues.push(...productionIssues(result.data));
  }
  if (issues.length) throw new EnvValidationError(issues, mode);
  return result.data as Env;
}

let cached: Env | undefined;

/** The validated environment. Memoised; first call validates. */
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}

/**
 * Boot-time check. Called from instrumentation.ts before anything else so a
 * bad environment refuses to start rather than failing on the first request
 * that happens to touch the bad key. Also runs the Seal loader, whose twelve
 * request-time throws become boot-time ones.
 */
export async function validateEnvAtBoot(): Promise<Env> {
  const env = getEnv();
  const { getSealConfig } = await import('./server/seal-config.ts');
  try {
    getSealConfig();
  } catch (error) {
    throw new EnvValidationError(
      [{ key: 'SEAL_*', message: error instanceof Error ? error.message : String(error) }],
      env.NODE_ENV,
    );
  }
  return env;
}
