import { MICRO_DECIMALS, MIST_DECIMALS, formatMinor, parseMinor, sumMinor } from '../money.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction } from '@mysten/sui/transactions';

import { assertCommitmentBytes } from '@/lib/evidence/commitment';
import {
  CONTRACT_MAX_FEE_BPS,
  FALLBACK_FEE_BPS,
  getCorridorFeeBps,
} from '@/lib/fx/corridors';
import { batchGasBudgetMist, checkBatchSize } from '@/lib/policy/batch-limits';
import {
  checkPoolAllowed,
  parsePoolWhitelist,
  type PoolWhitelistVerdict,
} from '@/lib/policy/deepbook-whitelist';
import { getContractConfig, type ContractConfigField } from '@/lib/server/contract-config';
import { resolvePegAttestation } from '@/lib/server/peg-attestation';
import { suiClient } from '@/lib/sui';

const execFileAsync = promisify(execFile);

// ── Settlement mode / CLI availability ──────────────────────────────────────
// Production prefers the server-side SDK signer because serverless instances do
// not have persistent Sui CLI keystores. A fully configured CLI is retained as
// a local/operator fallback. Simulation must be explicit, or auto + mock APIs.
type SettlementExecution = 'sdk' | 'cli' | 'simulate';
type CliReadiness = { ready: true; address: string } | { ready: false; reason: string };

let cachedOperatorKeypair: Ed25519Keypair | Secp256k1Keypair | null | undefined;
let cachedCliReadiness: CliReadiness | null = null;

function settlementMode(): 'auto' | 'live' | 'simulate' {
  const mode = (process.env.SUI_SETTLEMENT_MODE ?? 'auto').trim().toLowerCase();
  if (mode === 'auto' || mode === 'live' || mode === 'simulate') return mode;
  throw new Error(`Invalid SUI_SETTLEMENT_MODE "${mode}". Use auto, live, or simulate.`);
}

// Batch-only settlement override. `settle_batch` requires live DeepBook order-book
// depth (peg_monitor::assert_deepbook_liquidity), which testnet pools rarely have,
// so a real batch can abort mid-demo. Setting SUI_BATCH_SETTLEMENT_MODE=simulate
// keeps batch on a labelled SIM_ receipt while single transfers, treasury, and the
// composed proof flow still settle for real. Returns null → fall through to the
// global mode.
function batchExecutionOverride(): SettlementExecution | null {
  const mode = (process.env.SUI_BATCH_SETTLEMENT_MODE ?? '').trim().toLowerCase();
  return mode === 'simulate' ? 'simulate' : null;
}

function configuredOperatorAddress(): string {
  return (getContractConfig().operatorAddress ?? '').trim();
}

export function getOperatorKeypair(): Ed25519Keypair | Secp256k1Keypair | null {
  if (cachedOperatorKeypair !== undefined) return cachedOperatorKeypair;

  const encoded = (
    process.env.OPERATOR_SUI_PRIVATE_KEY ??
    process.env.SUI_SPONSOR_PRIVATE_KEY ??
    ''
  ).trim();

  if (!encoded) {
    cachedOperatorKeypair = null;
    return null;
  }

  try {
    const parsed = decodeSuiPrivateKey(encoded);
    let keypair: Ed25519Keypair | Secp256k1Keypair;
    if (parsed.scheme === 'ED25519') {
      keypair = Ed25519Keypair.fromSecretKey(parsed.secretKey);
    } else if (parsed.scheme === 'Secp256k1') {
      keypair = Secp256k1Keypair.fromSecretKey(parsed.secretKey);
    } else {
      throw new Error(`unsupported key scheme ${parsed.scheme}; Splash supports ED25519 and Secp256k1`);
    }

    const signerAddress = keypair.toSuiAddress();
    const expectedAddress = configuredOperatorAddress();
    if (expectedAddress && signerAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('OPERATOR_SUI_PRIVATE_KEY does not match OPERATOR_SUI_ADDRESS');
    }

    cachedOperatorKeypair = keypair;
    return keypair;
  } catch (error) {
    throw new Error(`Invalid OPERATOR_SUI_PRIVATE_KEY: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCliGasCoins(stdout: string): OperatorGasCoin[] {
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) throw new Error(`'sui client gas --json' returned no JSON. stdout: ${stdout.substring(0, 200)}`);
  const coins = JSON.parse(stdout.slice(jsonStart)) as Array<{ gasCoinId: string; mistBalance: number | string }>;
  return coins
    .map((coin) => ({ id: coin.gasCoinId, balance: toMist(coin.mistBalance) }))
    .filter((coin) => coin.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

async function getCliReadiness(): Promise<CliReadiness> {
  if (cachedCliReadiness) return cachedCliReadiness;

  try {
    await execFileAsync('sui', ['--version'], { windowsHide: true, timeout: 5000 });
    const { stdout: addressOutput } = await execFileAsync('sui', ['client', 'active-address'], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 5000,
    });
    const address = addressOutput.trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(address)) {
      throw new Error('the Sui CLI has no active managed address');
    }

    const expectedAddress = configuredOperatorAddress();
    if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('the Sui CLI active address does not match OPERATOR_SUI_ADDRESS');
    }

    const { stdout: gasOutput } = await execFileAsync('sui', ['client', 'gas', '--json'], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024 * 5,
    });
    if (parseCliGasCoins(gasOutput).length === 0) {
      throw new Error('the Sui CLI active address has no funded gas coins');
    }

    cachedCliReadiness = { ready: true, address };
  } catch (error) {
    const commandError = error as { message?: string; stdout?: string; stderr?: string };
    const combined = `${commandError.stdout ?? ''}\n${commandError.stderr ?? ''}\n${commandError.message ?? ''}`;
    // Sui testnet fullnodes are gRPC-only (JSON-RPC retired; the v1.76.0 line
    // ships the gRPC RPC Store). CLIs that still speak JSON-RPC get an opaque
    // 404/"Request rejected" from the node — name the real cause instead.
    const jsonRpcRetired = /request rejected|404|405|jsonrpc|json-rpc/i.test(combined);
    cachedCliReadiness = {
      ready: false,
      reason: jsonRpcRetired
        ? 'the local sui CLI predates the fullnode JSON-RPC retirement (testnet is gRPC-only as of the v1.76.0 line) — upgrade the Sui CLI, or set OPERATOR_SUI_PRIVATE_KEY so settlement uses the gRPC SDK path'
        : humanizeSuiError(commandError.stdout ?? commandError.message, commandError.stderr ?? ''),
    };
  }
  return cachedCliReadiness;
}

async function resolveSettlementExecution(): Promise<SettlementExecution> {
  const mode = settlementMode();
  if (mode === 'simulate') return 'simulate';
  if (getOperatorKeypair()) return 'sdk';

  const cli = await getCliReadiness();
  if (cli.ready) return 'cli';

  if (mode === 'auto' && process.env.USE_MOCK_APIS === 'true') return 'simulate';

  throw new Error(
    `Real Sui settlement is not configured: ${cli.reason}. ` +
    'Set OPERATOR_SUI_PRIVATE_KEY to the funded ED25519 operator key in the production environment, ' +
    'or configure a persistent funded Sui CLI keystore. Use SUI_SETTLEMENT_MODE=simulate only for an explicitly labeled demo.',
  );
}

function simulatedDigest(seed: string): string {
  const stamp = Date.now().toString(36);
  const tail = createHash('sha256').update(`${seed}:${stamp}`).digest('hex').slice(0, 40);
  return `SIM_${stamp}${tail}`;
}

/** Successful settlement shape returned when the real CLI can't run. */
function simulatedSettlement(seed: string) {
  const cfg = getContractConfig();
  return {
    digest: simulatedDigest(seed),
    packageId: (cfg.packageId ?? '').trim() || 'simulated',
    treasuryId: (cfg.treasuryId ?? '').trim() || 'simulated',
  };
}

function configIdOrThrow(field: ContractConfigField, envKey: string): string {
  const value = (getContractConfig()[field] ?? '').trim();
  if (!value) throw new Error(`${envKey} is not configured. Set it in admin → Contract config (or in .env.local) and try again.`);
  return requireSuiObjectId(value, envKey);
}

function optionalConfigId(field: ContractConfigField): string {
  const value = (getContractConfig()[field] ?? '').trim();
  return value ? requireSuiObjectId(value, field) : '';
}

/**
 * Object id for the AnchorCap-gated calls — audit anchors, receipts, and
 * peg updates.
 *
 * The capability split (spec §5) moves those three off the money-authority
 * `AdminCap` and onto a hot `AnchorCap`, so a stolen server key can write
 * attestations but cannot move a coin. The package currently deployed on
 * testnet is IMMUTABLE and still expects an `AdminCap` in that argument
 * position, so:
 *
 *   - `SPLASH_ANCHOR_CAP_ID` set   → post-republish, pass the new cap.
 *   - unset                             → pass the AdminCap id, exactly as
 *                                         today, so the live deployment keeps
 *                                         working until Sebastian republishes.
 *
 * The argument position is identical in both ABIs, so this is a pure object-id
 * swap with no PTB restructuring.
 */
/**
 * Pre-flight for batch settlement: the shared SettlementPool must already hold
 * enough SUI, because `settle_sui_batch` splits every recipient's net + fee
 * straight out of `pool.balance`. An unfunded pool is the single most common
 * batch failure and otherwise surfaces as an opaque mid-PTB MoveAbort.
 *
 * Best-effort: a read failure must not block settlement — the chain remains the
 * authority, this only turns a knowable failure into a readable one.
 */
async function assertSettlementPoolFunded(
  poolId: string,
  rows: Array<{ amount?: string }>,
): Promise<void> {
  // Each row is a decimal string. Parsing to a double and rounding to micro
  // per row, then summing the doubles, is how a hundred-row batch ends up a
  // unit short of the sum the ledger computed from the same rows.
  const requiredMicro = sumMinor(rows.map((row) => parseMinor(row.amount ?? '0', MICRO_DECIMALS, 'half-up')));
  if (requiredMicro <= 0n) return;

  let balance: bigint;
  try {
    const res = await suiClient.core.getObject({ objectId: poolId, include: { json: true } });
    const json = (res as { object?: { json?: { balance?: string } } }).object?.json;
    if (!json || json.balance === undefined) return;
    balance = BigInt(json.balance);
  } catch {
    return;
  }

  if (balance < requiredMicro) {
    throw new Error(
      `SettlementPool ${poolId.slice(0, 12)}… holds ${formatMinor(balance, MIST_DECIMALS)} SUI but this batch needs ` +
      `${formatMinor(requiredMicro, MIST_DECIMALS)} SUI. Batch payouts are paid FROM the pool, not from the operator wallet — ` +
      'fund it first: node --use-system-ca --env-file=.env.local scripts/fund-settlement-pool.mjs <SUI>',
    );
  }
}

/**
 * The shared `CapRegistry` (Phase 7). Required by every call that USES a
 * revocable capability.
 *
 * Deliberately throwing rather than optional: without it the PTB cannot be
 * built at all, which is the correct failure. An "optional registry" would mean
 * a code path where a revoked capability still works, and that path would be
 * the one running in production the day someone needs the revocation.
 */
function capRegistryObjectId(): string {
  return configIdOrThrow('capRegistryId', 'SPLASH_CAP_REGISTRY_ID');
}

/**
 * The attestation capability — and ONLY the attestation capability.
 *
 * A-12 fix. This used to fall back to `adminCapId`, which is why the S-10 cap
 * split was written but not in effect: with `SPLASH_ANCHOR_CAP_ID` unset
 * (as `.env.example` shipped it), every attestation silently re-armed the hot
 * server with the money authority. The fallback was convenient precisely
 * because it made the split invisible, which is what made it the bug.
 *
 * `AnchorCap` exists because `update_peg` fires roughly every 30 seconds —
 * ~2,880 signatures a day from an internet-facing host. Letting `AdminCap` serve
 * that role puts the key that can drain the pool on the machine that signs most
 * often. It now throws instead.
 */
function anchorCapObjectId(): string {
  return configIdOrThrow('anchorCapId', 'SPLASH_ANCHOR_CAP_ID');
}

/**
 * Resolve the fee in bps to pass to settlement.move. Always clamped to
 * CONTRACT_MAX_FEE_BPS so the on-chain E_FEE_EXCEEDED assertion will pass.
 */
function resolveFeeBps(input: { feeBps?: number; targetCurrency?: string }): number {
  const explicit = input.feeBps;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return Math.min(Math.floor(explicit), CONTRACT_MAX_FEE_BPS);
  }
  if (input.targetCurrency) {
    return getCorridorFeeBps(input.targetCurrency);
  }
  return FALLBACK_FEE_BPS;
}

/**
 * Abort code → human message. Update this every time a contract gains a new
 * abort code; the SECURITY.md pre-deploy gate (#20) requires drift = 0.
 * Code-range conventions (loose):
 *   1–99    business_account
 *   100–199 settlement
 *   300–399 peg_monitor
 *   400–499 payment_intent
 *   500–599 audit_anchor
 *   600–699 dual_treasury
 *   700–799 smart_treasury
 *   800–899 receipt_v2
 */
const ABORT_CODES: Record<number, string> = {
  // ── business_account ──────────────────────────────────────────────────────
  1: 'E_ALREADY_VERIFIED — BusinessAccount is already KYB-verified on-chain.',
  2: 'E_EMPTY_SSM_NUMBER — BusinessAccount application submitted without a registration number.',
  3: 'E_EMPTY_KYB_CID — BusinessAccount application submitted without a KYB document CID.',

  // ── settlement ───────────────────────────────────────────────────────────
  100: 'E_NOT_VERIFIED — BusinessAccount is not KYB-verified. Call verify_business with AdminCap first.',
  101: 'E_INSUFFICIENT_FUNDS — Coin value too small (fee > payment). Send a larger coin.',
  102: 'E_EMPTY_BATCH — Empty payments vector. Add at least one payment.',
  103: 'E_FEE_EXCEEDED — fee_bps passed to settle_payment/settle_batch is above MAX_FEE_BPS (200). Check the corridor fee in lib/fx/corridors.ts.',
  104: 'E_INVALID_RECIPIENT — settlement recipient is the zero address.',
  105: 'E_INVALID_AMOUNT — settlement amount or deposit coin value is zero.',
  106: 'E_NOT_ACCOUNT_OWNER — BusinessAccount object was transferred away from its recorded owner; verified status is not transferable (audit S-01).',
  108: 'E_BATCH_TOO_LARGE — settle_batch exceeded MAX_BATCH_ROWS (256). Above roughly 1,023 rows Sui’s per-transaction event and command ceilings make the call unexecutable at any gas budget; 256 keeps it well inside them.',
  109: 'E_INSUFFICIENT_CREDIT — the tenant has not funded enough credit in the SettlementPool for this run. Credits are per-tenant (audit A-11): fund with settlement::deposit_for, not a bare deposit.',
  110: 'E_NOT_ACCOUNT_OWNER — grant_delegation must be signed by the BusinessAccount owner.',
  111: 'E_NOT_VERIFIED — cannot grant a payout delegation from an unverified BusinessAccount.',
  112: 'E_DELEGATION_EXPIRED — the payout delegation has passed its TTL (max 30 days). The tenant must re-grant.',
  113: 'E_DELEGATION_REVOKED — this delegation was revoked by its owner or by an admin.',
  114: 'E_TTL_TOO_LONG — delegation TTL exceeds the 30-day maximum.',
  115: 'E_INVALID_OPERATOR — the delegation was granted to a different operator address than the one signing.',
  116: 'E_WRONG_DELEGATION — the delegation is bound to a different SettlementPool.',
  117: 'E_EPOCH_INVALIDATED — revoke_all_delegations was called; every delegation minted before it is dead. Tenants must re-grant.',
  118: 'E_CREDIT_INVARIANT — pool balance and the sum of tenant credits diverged. Settlement refused rather than paying out of an unbacked pool. Investigate before retrying.',
  119: 'E_FEE_RECIPIENT_FIXED — set_fee_recipient requires the pool to be paused first, so a redirect cannot be slipped between two normal sweeps.',
  107: 'E_BELOW_MINIMUM — the settlement (or batch total) is below the on-chain minimum in ComplianceConfig.min_settlement_amount. Raise the amount, or change the floor with scripts/set-compliance-config.mjs --min-settlement <minor units>.',

  // ── peg_monitor ──────────────────────────────────────────────────────────
  300: 'E_PEG_BROKEN_USDC — USDC deviation > 30 bps. Update peg with valid data.',
  301: 'E_PEG_BROKEN_USDT — USDT deviation > 30 bps. Update peg with valid data.',
  302: 'E_PEG_STALE — Peg price update is older than 60 seconds OR no real update_peg has fired since init. The app refreshes it automatically; verify SPLASH_ADMIN_CAP_ID and SPLASH_PEG_STATE_ID if this appears.',
  303: 'E_TIMESTAMP_REGRESSION — peg_monitor::update_peg called with a Clock timestamp older than the stored one. Indicates a clock bug or replay.',
  304: 'E_INSUFFICIENT_DEPTH — DeepBook cannot fill this settlement amount inside the configured depth window. Common causes, in order: (1) the batch total is BELOW the pool\’s minSize (SUI/DBUSDC testnet minSize = 1 SUI — anything smaller returns a zero quote); (2) the SettlementPool is underfunded (fund it with scripts/fund-settlement-pool.mjs); (3) the book genuinely lacks depth in the [mid*(1-slippage), mid] band. NOTE: the package deployed on testnet still carries the pre-S-11 guard, which requires a PERFECT fill (remaining_base == 0) — unsatisfiable on a lot-quantized book, so batch cannot settle live until the fixed contract is published.',
  305: 'E_SLIPPAGE_EXCEEDED — DeepBook amount-sized execution price exceeds the configured slippage limit.',
  306: 'E_INVALID_MARKET_PRICE — DeepBook returned an invalid zero mid-price.',
  // ── splash_meter (900-block) ─────────────────────────────────────────────
  900: 'E_ZERO_AMOUNT — spend meter charged with a zero amount.',
  901: 'E_PER_TX_CAP — this single settlement exceeds the per-transaction ceiling. Split the run, or the multisig can propose a higher limit with 48h notice.',
  902: 'E_WINDOW_CAP — the run exceeds the settlement ceiling for this window. It clears as the 24h window advances, or the multisig can propose a higher limit with 48h notice (audit A-11).',
  903: 'E_METER_PAUSED — a guardian paused this meter. Only the cold AdminCap can resume.',
  904: 'E_NOT_A_RELAX — propose_relax was called with a value that is not an increase.',
  905: 'E_RELAX_TOO_LARGE — a limit may rise at most 4x per step, each step with its own 48h notice.',
  906: 'E_NOT_A_TIGHTEN — tighten was called with a value that would raise a limit. Raises need propose_relax and 48h.',
  907: 'E_NO_PENDING — no queued relaxation to apply or cancel.',
  908: 'E_RELAX_NOT_DUE — the 48h notice period has not elapsed.',
  909: 'E_INVALID_LIMITS — limits must be non-zero and per-tx must not exceed the window cap.',
  910: 'E_ABOVE_BOOTSTRAP — cannot restore above the limits fixed at the key ceremony.',
  911: 'E_NOT_PAUSED — unpause called on a meter that is not paused.',
  920: 'E_WRONG_METER — this GuardianCap watches a different pool.',
  921: 'E_INVALID_HOLDER — guardian holder cannot be the zero address.',

  350: 'E_INVALID_CONFIG — Compliance threshold is outside its bounded safety range.',
  351: 'E_INVALID_CAP — ComplianceCap does not own authority for this ComplianceConfig.',
  352: 'E_SETTLEMENT_PAUSED — Settlement has been paused by the compliance operator.',
  353: 'E_POOL_NOT_ALLOWED — the DeepBook pool passed to the liquidity guard is not on ComplianceConfig.allowed_deepbook_pools (audit S-12). Add it with scripts/set-compliance-config.mjs --allow-pool <id>, and check DEEPBOOK_POOL_ID points at the venue you whitelisted.',
  354: 'E_TOO_MANY_POOLS — the DeepBook whitelist is already at compliance_config::max_allowed_pools(). Remove a venue before adding another.',
  355: 'E_POOL_LIST_EMPTY — refused to leave the DeepBook whitelist empty (that would abort every settlement). Add the replacement venue first, then remove the old one; use compliance_config::pause for an intentional halt.',
  356: 'E_NOT_A_TIGHTENING — compliance_config::tighten was passed a value that loosens a control. ComplianceCap is subtractive by type; relaxations are AdminCap (admin_set_parameters) from the cold multisig.',

  // ── payment_intent ───────────────────────────────────────────────────────
  400: 'E_NOT_PENDING — payment_intent confirm/cancel called on an intent that is not in STATUS_PENDING.',
  401: 'E_EXPIRED — payment_intent::confirm_payment_intent called past intent.expires_at.',
  402: 'E_INSUFFICIENT_PAYMENT — coin value below intent.amount_usd on confirm.',
  403: 'E_NOT_YET_EXPIRED — payment_intent::cancel_payment_intent called before intent.expires_at.',
  404: 'E_UNAUTHORIZED — payment_intent action attempted by an address other than intent.sender.',
  405: 'E_INVALID_AMOUNT — payment_intent::create_payment_intent called with amount_usd = 0.',
  406: 'E_INVALID_RECIPIENT — payment_intent recipient is the zero address.',
  407: 'E_EMPTY_TARGET_CURRENCY — payment_intent target currency is empty.',
  408: 'E_INVALID_FX_RATE — payment_intent FX rate must be greater than zero.',
  409: 'E_EMPTY_BENEFICIARY_REF — payment_intent::create called without a verified counterparty reference hash.',
  410: 'E_EMPTY_CURRENCY — payment_intent::create called without a currency tag.',
  411: 'E_EMPTY_CORRIDOR — payment_intent::create called without a corridor tag.',
  413: 'E_UNAUTHORIZED_RECEIPT_CONSUMER — a module other than audit_anchor tried to unpack a SettleReceipt. Only the anchoring path can construct the witness, which is what makes “every settlement is anchored” a type-system guarantee.',
  414: 'E_WRONG_SETTLEMENT_ASSET — the coin type offered does not match the asset the intent was opened in. The intent binds its settlement asset at creation; check SPLASH_SETTLEMENT_COIN_TYPE and how the payment coin is sourced.',
  412: 'E_STILL_PENDING — payment_intent::delete_finalized called on a pending intent; confirm or cancel it first.',

  // ── audit_anchor ─────────────────────────────────────────────────────────
  500: 'E_EMPTY_HASH — audit_anchor::anchor_audit_hash called with an empty audit_hash string.',
  501: 'E_EMPTY_ANCHOR — audit_anchor::anchor_audit_hash called with an empty anchor_id.',
  502: 'E_EMPTY_BLOB — audit_anchor::anchor called with an empty Walrus blob id.',

  // ── dual_treasury ────────────────────────────────────────────────────────
  600: 'E_USDT_TTL_EXCEEDED — USDT settlement attempted past USDT_MAX_HOLD_MS (30 minutes). Sweep expected.',
  601: 'E_USDT_BUFFER_EMPTY — dual_treasury::emergency_sweep called with zero balance.',
  602: 'E_USDT_SWEEP_TOO_EARLY — emergency_sweep called before USDT_SWEEP_TRIGGER_MS (27 minutes).',
  603: 'E_USDT_INSUFFICIENT_KYC_TIER — settle_usdt called with a kyc_tier below the buffer’s STORED min_kyc_tier. The threshold used to be a caller-supplied parameter next to kyc_tier, which made the gate caller-versus-caller (audit A-11).',
  604: 'E_USDT_INSUFFICIENT_BALANCE — settle_usdt requested more than the buffer holds.',
  605: 'E_USDT_ACTIVE_BUFFER — deposit attempted while the USDT buffer still holds an active intake.',
  606: 'E_USDT_ZERO_AMOUNT — dual_treasury deposit or settlement amount is zero.',
  607: 'E_USDT_INVALID_RECIPIENT — dual_treasury recipient is the zero address.',
  608: 'E_USDT_REQUIRES_PAUSE — lowering the buffer’s stored KYC floor requires the buffer to be paused first.',

  // ── smart_treasury ───────────────────────────────────────────────────────
  700: 'E_INSUFFICIENT_BALANCE — smart_treasury::withdraw requested more than the treasury holds.',
  701: 'E_ZERO_AMOUNT — smart_treasury deposit/withdraw called with amount = 0.',
  702: 'E_RECIPIENT_INVALID — smart_treasury::withdraw recipient is the zero address.',
  703: 'E_OPERATING_FLOOR — the withdrawal would breach the treasury operating floor. The floor is STORED on the treasury (audit A-11); allocate, which took it as a caller-supplied argument, is deleted.',
  704: 'E_RECIPIENT_NOT_ALLOWED — smart_treasury withdrawal destination is not on the treasury allowlist. Add it with allow_recipient (AdminCap).',
  705: 'E_REQUIRES_PAUSE — lowering the treasury operating floor requires the treasury to be paused first, so a floor reduction cannot be slipped between two normal withdrawals.',
  706: 'E_LAST_RECIPIENT — refused to empty the withdrawal allowlist; that bricks the treasury rather than securing it. Use the pause switch.',

  // ── business_account (Phase 6 authority) ─────────────────────────────────
  4: 'E_INVALID_HOLDER — business_account::rotate_anchor_cap called with holder = 0x0.',
  5: 'E_NOT_VERIFIED_YET — revoke_verification called on an account that was never verified.',
  20: 'E_NOT_AN_OWNER — the signer is not an owner of this business account. Membership is read from the account’s own `owners` set on every call; being a Splash admin does not substitute.',
  21: 'E_NOT_AN_APPROVER — the signer is not in this account’s approver set. Owners are not approvers by default: separation of duties is set membership, not seniority.',
  22: 'E_FROZEN — the account is stopped. Two independent flags: an owner freeze, which any owner can lift, and a compliance freeze, which only the AdminCap can. Membership cannot change while either is set.',
  23: 'E_NOT_FROZEN — unfreeze called on an account that is not frozen by that authority. An owner cannot clear a compliance freeze by lifting their own.',
  24: 'E_LAST_OWNER — refused to remove the only owner. An account with no owners has no path back except a recovery party, which is optional.',
  25: 'E_ALREADY_A_MEMBER — that address is already an owner or approver, or a pending recovery has already been performed by the owners themselves.',
  26: 'E_NOT_A_MEMBER — that address is not in the set you are removing it from.',
  27: 'E_NOT_RECOVERY_PARTY — only the nominated recovery party can request, execute or cancel a recovery.',
  28: 'E_INVALID_ADDRESS — an owner, approver, recovery party or maker was given as 0x0.',
  29: 'E_SELF_APPROVAL — the approver is the maker. Four eyes is enforced on chain: whoever initiated a payment cannot release it.',
  30: 'E_STALE_AUTHORITY — the approval was minted under an authority set that has since changed. Every membership change, freeze, recovery and KYB withdrawal bumps the account’s authority epoch, so a revoked approver’s approval is dead even though the object still exists — and re-granting the same address does not revive it. Ask for a fresh approval.',
  31: 'E_WRONG_ACCOUNT — the approval belongs to a different business account than the one passed.',
  32: 'E_APPROVAL_EXPIRED — the approval is past its fifteen-minute TTL.',
  33: 'E_AMOUNT_MISMATCH — the approval’s amount does not match the intent’s, or an approval was requested for zero.',
  34: 'E_TOO_MANY_MEMBERS — the owner or approver set is at its cap (16). An unbounded set is a gas cliff and an object-size risk.',
  35: 'E_RECOVERY_IS_INSIDER — the recovery party cannot also be an owner or approver. A recovery party drawn from the same people is not a recovery path.',
  36: 'E_NOT_VERIFIED — the business account is not KYB-verified, so no payout can be approved or released from it.',
  37: 'E_NO_RECOVERY_PARTY — no recovery party has been nominated on this account.',
  38: 'E_RECOVERY_PENDING — a recovery is already running. It cannot be replaced, and the nominee cannot be changed mid-notice.',
  39: 'E_NO_PENDING_RECOVERY — there is no recovery to cancel or execute; an owner may already have cancelled it.',
  40: 'E_RECOVERY_NOT_DUE — the 72-hour recovery notice has not elapsed. The delay is what makes it a defence rather than a countdown: any owner can cancel during it.',
  41: 'E_WRONG_INTENT — the approval was minted for a different payment intent.',
  42: 'E_OVER_PER_TRANSFER_CAP — the payout is larger than this account’s tier allows in a single transfer. Tier 3 permits 20,000, Tier 2 permits 200,000, Tier 1 permits 1,000,000 (USD, six-decimal minor units). Split the payment or request a tier increase.',
  43: 'E_BELOW_MINIMUM — the payout is under the 99 USD platform floor. Below that the fixed costs of settling, anchoring and screening exceed the payment, and the partners’ own corridor minimums start there.',
  44: 'E_UNKNOWN_TIER — a tier other than 1, 2 or 3, or a limit-increase request that is not actually an increase (tier numbers descend as limits rise).',

  415: 'E_APPROVAL_REQUIRED — this intent is bound to a business account, so it settles only through confirm_with_approval. confirm_payment_intent would bypass the approver, the freeze flags and the 24h ceiling.',
  416: 'E_NOT_ACCOUNT_BOUND — confirm_with_approval or approve_payout called on an intent that is not bound to any business account.',
  417: 'E_WRONG_BUSINESS_ACCOUNT — the account passed is not the account the intent was opened against.',
  418: 'E_NOT_A_MEMBER — the signer is neither an owner nor an approver of the account, so cannot open an intent in its name.',
  419: 'E_ACCOUNT_NOT_PAYABLE — the account is frozen or not KYB-verified.',
  420: 'E_BAD_COMMITMENT — the commitment passed to payment_intent::create* is not 32 bytes. It is blake2b256(tag || bcs(payload) || salt), computed by lib/evidence/commitment.ts; see docs/commitments.md.',

  // ── cap_registry (break-glass revocation) ────────────────────────────────
  210: 'E_STALE_GENERATION — the capability presented is from a superseded generation. It was revoked by a break-glass rotation and is permanently dead; a replacement was minted to whoever the rotation named. Check the CapabilityRevoked event and update the configured object id.',
  211: 'E_UNKNOWN_KIND — cap_registry was asked about a capability kind it does not track. Only AnchorCap (0) and ComplianceCap (1) carry generations.',
  212: 'E_INVALID_HOLDER — a break-glass rotation named 0x0 as the new holder, which would mint the replacement capability to nobody and leave the kind unusable.',
  213: 'E_NOTHING_ARMED — break-glass execute called with nothing armed, or armed for a different capability. Revocation is two transactions: arm, then execute within ninety seconds.',
  214: 'E_ARM_EXPIRED — the ninety-second commit window closed before the second transaction landed. Nothing was revoked; arm again. The window is deliberately short — it makes revocation two deliberate steps without giving a thief a useful cancellation period.',
  215: 'E_ALREADY_ARMED — a break-glass is already armed and has not yet expired. Execute it, cancel it, or wait ninety seconds.',

  // ── daily_limit (per-account 24h ceiling) ────────────────────────────────
  200: 'E_ZERO_AMOUNT — daily_limit::charge called with a zero payout.',
  201: 'E_CAP_EXCEEDED — the payout would push this business account past one of its rolling ceilings (24h or 30-day), or a ceiling was lowered below what it has already spent inside the window. Read business_account::daily_remaining and monthly_remaining before retrying; the allowance returns as the window slides.',
  202: 'E_INVALID_CAP — business_account::set_daily_cap called with zero. A zero ceiling is a brick, not a limit.',

  // ── receipt_v2 ───────────────────────────────────────────────────────────
  800: 'E_EMPTY_RECEIPT_ID — receipt_v2::create_receipt called with empty receipt_id.',
  801: 'E_EMPTY_TX_DIGEST — receipt_v2::create_receipt called with empty tx_digest.',
  802: 'E_RECEIPT_ZERO_AMOUNT — receipt_v2::create_receipt called with amount_usd = 0.',
  803: 'E_RECEIPT_INVALID_RECIPIENT — receipt_v2::create_receipt called with recipient = 0x0.',
  804: 'E_BAD_COMMITMENT — receipt_v2::create_receipt called with a commitment that is not 32 bytes.',
};

/** The modules ABORT_CODES actually describes. Anything else is a dependency. */
const OUR_MODULES = new Set([
  'settlement',
  'business_account',
  'peg_monitor',
  'compliance_config',
  'payment_intent',
  'audit_anchor',
  'dual_treasury',
  'smart_treasury',
  'receipt_v2',
]);

/**
 * Aborts raised by our DEPENDENCIES, keyed by the module they come from.
 *
 * These matter because settlement calls into DeepBook on the hot path, and
 * DeepBook's own codes are small integers (1-21) that overlap nothing of ours
 * today — but nothing stops a future dependency from aborting with, say, 100,
 * which our table would confidently mislabel as `E_NOT_VERIFIED`. So the code
 * table is only consulted when the abort actually came from a splash module
 * (splash_core or splash_custody).
 */
const DEPENDENCY_ABORT_CODES: Record<string, Record<number, string>> = {
  book: {
    1: 'deepbook::book::EInvalidAmountIn — the liquidity guard asked DeepBook to quote a zero (or otherwise invalid) size.',
    2: 'deepbook::book::EEmptyOrderbook — the whitelisted DeepBook pool has no live bid or no live ask, so mid_price is undefined. Settlement is correctly blocked; it will clear again once the book has two sides. Check the pool on an explorer before changing any risk parameter.',
    3: 'deepbook::book::EInvalidPriceRange — level2 range queried with price_low > price_high. Check max_slippage_bps in ComplianceConfig.',
    5: 'deepbook::book::EOrderBelowMinimumSize — the quoted size is below the pool minSize.',
    6: 'deepbook::book::EOrderInvalidLotSize — the quoted size is not a multiple of the pool lot size.',
  },
  pool: {
    11: 'deepbook::pool::EPackageVersionDisabled — the deployed DeepBook package version was disabled. The pinned pool id may need to move to a currently-supported pool.',
    14: 'deepbook::pool::EPoolNotRegistered — DEEPBOOK_POOL_ID is not a registered pool on this network.',
  },
};

function humanizeSuiError(rawError: string | undefined | null, stderr: string): string {
  const error = [rawError, stderr].filter(Boolean).join('\n') || 'Unknown Sui error';
  if (/No managed addresses|no active managed address/i.test(error)) {
    return 'The Sui CLI has no managed operator address. Configure OPERATOR_SUI_PRIVATE_KEY for server-side settlement, or create and fund a persistent CLI address.';
  }
  const abortMatch = error.match(/MoveAbort\([^)]*?,\s*(\d+)\)/) ?? error.match(/with code\s+(\d+)/i);
  if (abortMatch) {
    const code = Number.parseInt(abortMatch[1], 10);
    const fnMatch = error.match(/function_name:\s*Some\("([^"]+)"\)/) ?? error.match(/within function\s+'([^']+)'/i);
    const fnName = fnMatch?.[1] ?? '';
    // `ModuleId { address: 0x…, name: Identifier("peg_monitor") }` in the CLI /
    // SDK rendering, and `name: peg_monitor` in some node responses.
    const moduleMatch =
      error.match(/name:\s*Identifier\("([^"]+)"\)/) ?? error.match(/\bname:\s*([a-z_][a-z0-9_]*)/i);
    const moduleName = moduleMatch?.[1] ?? '';

    const dependency = DEPENDENCY_ABORT_CODES[moduleName]?.[code];
    if (dependency) return `${dependency}${fnName ? ` (in ${fnName})` : ''}`;

    // Only claim to know the code if it came from our own package. An abort from
    // a dependency module gets reported verbatim rather than mislabelled.
    const ours = OUR_MODULES.has(moduleName);
    const human = ours || !moduleName ? ABORT_CODES[code] : undefined;
    if (human) {
      const caveat = moduleName ? '' : ' (module unknown — verify this is a splash_core/splash_custody abort)';
      return `${human}${fnName ? ` (in ${fnName})` : ''}${caveat}`;
    }
    const from = moduleName ? ` from module '${moduleName}'` : '';
    return `MoveAbort code ${code}${from}${fnName ? ` in ${fnName}` : ''} — ${error}`;
  }
  if (/InsufficientGas/i.test(error)) return 'InsufficientGas — increase --gas-budget.';
  if (/ObjectNotFound/i.test(error)) return `ObjectNotFound — one of the configured object IDs does not exist on the network. Verify .env.local.`;
  if (/ObjectID hex string must start with 0x/i.test(error)) return 'Invalid Sui object ID — one of the configured IDs is missing the 0x prefix. Check SPLASH_PACKAGE_ID, SPLASH_TREASURY_ID, SPLASH_PEG_STATE_ID, SPLASH_BUSINESS_ACCOUNT_ID, SPLASH_TRANSFER_COIN_ID, and SPLASH_ADMIN_CAP_ID in .env.local.';
  return error;
}

async function runSuiCommand(args: string[], maxBuffer = 1024 * 1024 * 10) {
  try {
    return await execFileAsync('sui', args, {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer,
    });
  } catch (error) {
    const commandError = error as { message?: string; stdout?: string; stderr?: string };
    throw new Error(humanizeSuiError(commandError.stdout ?? commandError.message, commandError.stderr ?? ''));
  }
}

type OperatorGasCoin = { id: string; balance: bigint };

type SuiExecutionError = {
  message: string;
  MoveAbort?: { abortCode: string; location?: { module?: string; functionName?: string } } | null;
};

/**
 * Render the gRPC Core API's structured ExecutionError into the legacy
 * JSON-RPC error string format so humanizeSuiError's MoveAbort/ABORT_CODES
 * matching keeps working unchanged.
 */
function describeExecutionError(error: SuiExecutionError | null | undefined): string {
  if (!error) return 'Unknown Sui error';
  const abort = error.MoveAbort;
  if (abort) {
    const fnName = abort.location?.functionName;
    const location = [abort.location?.module, fnName].filter(Boolean).join('::') || 'unknown';
    const fnSuffix = fnName ? ` function_name: Some("${fnName}")` : '';
    return `MoveAbort(${location}, ${abort.abortCode})${fnSuffix} — ${error.message}`;
  }
  return error.message;
}

/** Transport-level failures worth one bounded retry. Testnet v1.76.0 nodes
 *  rebuild their gRPC RPC Store on upgrade and delay HTTP availability while
 *  reindexing, so a briefly unreachable fullnode is an expected state — not a
 *  settlement failure. Move aborts / on-chain failures are NEVER retried. */
function isTransientTransportError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  return /UNAVAILABLE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket|502|503|504|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(message);
}

async function executeSdkTransaction(tx: Transaction) {
  const signer = getOperatorKeypair();
  if (!signer) throw new Error('OPERATOR_SUI_PRIVATE_KEY is required for SDK settlement.');

  // Re-submitting the SAME signed bytes is idempotent on Sui (same digest), so
  // a bounded retry on transport errors cannot double-settle.
  const attemptExecute = () => suiClient.signAndExecuteTransaction({
    signer,
    transaction: tx,
    include: {
      effects: true,
      events: true,
    },
  });
  const attempts = 3;
  let result: Awaited<ReturnType<typeof attemptExecute>> | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      result = await attemptExecute();
      break;
    } catch (error) {
      if (attempt === attempts || !isTransientTransportError(error)) throw error;
      const delayMs = attempt * 750;
      console.warn(`[sui-settlement] transient transport error (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms:`, error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!result) throw new Error('Sui execution did not return a result.');

  const executed = result.Transaction ?? result.FailedTransaction;
  if (result.$kind !== 'Transaction' || !executed.status.success) {
    throw new Error(humanizeSuiError(describeExecutionError(executed.status.error), ''));
  }

  // Wait for the tx to be indexed so any objects it created/changed are
  // visible to follow-up transactions in the same flow (composed payments).
  try { await suiClient.waitForTransaction({ digest: executed.digest }); } catch {}

  // Normalize to the legacy JSON-RPC result shape the downstream settlement
  // flows (resultEvents, composed payments, anchors) were written against.
  return {
    digest: executed.digest,
    events: (executed.events ?? []).map((event) => ({
      type: event.eventType,
      parsedJson: event.json,
    })),
    objectChanges: (executed.effects?.changedObjects ?? []) as unknown[],
  };
}

type SuiEventView = {
  type: string;
  data: Record<string, unknown>;
};

export type ComposedAction = {
  kind: 'paid' | 'allocated' | 'anchored';
  label: string;
  eventType: string;
  data: Record<string, unknown>;
};

export type ComposedSettlementResult = {
  digest: string;
  intentId: string;
  intentCreateDigest: string;
  auditAnchorObjectId: string | null;
  smartTreasuryId: string | null;
  events: SuiEventView[];
  objectChanges: unknown[];
  composedActions: ComposedAction[];
  demo: boolean;
};

function resultEvents(result: Awaited<ReturnType<typeof executeSdkTransaction>>): SuiEventView[] {
  return (result.events ?? []).map((event) => ({
    type: event.type,
    data: (event.parsedJson && typeof event.parsedJson === 'object'
      ? event.parsedJson
      : {}) as Record<string, unknown>,
  }));
}

function eventBySuffix(events: SuiEventView[], suffix: string) {
  return events.find((event) => event.type.endsWith(suffix)) ?? null;
}

/**
 * Apply the demo recipient override — loudly, and never on mainnet.
 *
 * `SPLASH_TEST_RECIPIENT_ADDRESS` replaces the real beneficiary on every live
 * settlement path, per row in a batch. It is a genuinely useful testnet
 * affordance, but it was applied after the simulate-mode early return, with no
 * network gate and no log line: promote a testnet config to mainnet with the
 * value still set and a 50-row payroll pays the entire total to one address,
 * returns 200, and marks the batch SETTLED. The beneficiaries are simply never
 * paid, and nothing in the record says so.
 */
function resolvePayoutRecipient(inputRecipient: string | undefined, label: string): string {
  const configured = (getContractConfig().testRecipientAddress ?? '').trim();
  if (!configured) return inputRecipient ?? '';

  if ((process.env.SUI_NETWORK ?? '').trim().toLowerCase() === 'mainnet') {
    throw new Error(
      'SPLASH_TEST_RECIPIENT_ADDRESS is set while SUI_NETWORK=mainnet. That override redirects every real ' +
        'payout to one address. Clear it before settling on mainnet.',
    );
  }
  if (inputRecipient && inputRecipient !== configured) {
    console.warn(
      `[Sui Settlement] demo override: ${label} ${inputRecipient.slice(0, 12)}… redirected to ` +
        `SPLASH_TEST_RECIPIENT_ADDRESS ${configured.slice(0, 12)}…. The real beneficiary is NOT being paid.`,
    );
  }
  return configured;
}

function requireConfiguredRecipient(inputRecipient: string) {
  return requireSuiAddress(resolvePayoutRecipient(inputRecipient, 'Composed payment recipient'), 'Composed payment recipient');
}

/**
 * Resolve the CORE package — the one that publishes to mainnet.
 *
 * Falls back to the legacy `SPLASH_PACKAGE_ID` so a deployment that predates the
 * package split keeps working: before the split, one package held every module.
 */
function corePackageIdOrThrow(): string {
  const cfg = getContractConfig();
  const core = (cfg.corePackageId ?? '').trim();
  if (core) return requireSuiObjectId(core, 'SPLASH_CORE_PACKAGE_ID');
  return configIdOrThrow('packageId', 'SPLASH_PACKAGE_ID');
}

/**
 * Resolve the CUSTODY package, or explain why it does not exist.
 *
 * Splash cannot hold client funds — enforced structurally rather than by a
 * licence condition, and a precondition for operating before an e-money
 * licence exists. So
 * splash_custody — every struct that holds a `Balance<T>` — is NOT PUBLISHED.
 * This is not a feature flag: the bytecode is absent, so there is nothing to
 * flip and nothing to bypass. The error names the licence rather than reporting
 * a missing environment variable, because "not configured" would read as a
 * deployment mistake when it is in fact the regulatory posture working.
 */
function custodyPackageIdOrThrow(): string {
  const custody = (getContractConfig().custodyPackageId ?? '').trim();
  if (custody) return requireSuiObjectId(custody, 'SPLASH_CUSTODY_PACKAGE_ID');

  // Pre-split deployments carried custody modules inside the single package.
  const legacy = (getContractConfig().packageId ?? '').trim();
  if (legacy && !(getContractConfig().corePackageId ?? '').trim()) return legacy;

  throw new Error(
    'Batch settlement requires the splash_custody package, which publishes when the Labuan ' +
      'e-money licence is granted. Phase 0 settles through payment_intent, which holds no balance. See STATUS.md.',
  );
}

/**
 * The coin type payment intents are opened and settled in.
 *
 * `confirm_payment_intent` used to hardcode `Coin<SUI>`, which is wrong for a
 * USD corridor: SUI moves between intent creation and confirmation, so what the
 * recipient actually receives drifts from what was quoted. It is now generic —
 * but the intent BINDS the asset at creation and asserts it at confirmation
 * (abort 414), because an unbound generic would be worse than the hardcode: any
 * coin type could discharge the obligation, since the only amount check is
 * `value(payment) >= amount_usd` and unit counts are meaningless across assets.
 *
 * Today both PTBs source the payment with `tx.splitCoins(tx.gas, …)`, and gas is
 * SUI — so SUI is the honest answer. Configuring a stablecoin here WITHOUT
 * changing the coin sourcing would build a PTB that opens a USDC intent and pays
 * it with SUI, which the new assert correctly rejects on chain. Rather than let
 * that surface as an opaque abort, refuse here with the reason.
 */
export function settlementCoinType(): string {
  const configured = (process.env.SPLASH_SETTLEMENT_COIN_TYPE ?? '').trim();
  if (!configured || configured === SUI_COIN_TYPE) return SUI_COIN_TYPE;
  throw new Error(
    `SPLASH_SETTLEMENT_COIN_TYPE is set to ${configured}, but the settlement PTBs still fund the ` +
      'payment with tx.splitCoins(tx.gas, …), which yields SUI. Wire a coin-object selector for that ' +
      'type before switching, or the intent will be opened in one asset and paid in another (abort 414).',
  );
}

const SUI_COIN_TYPE = '0x2::sui::SUI';

function configuredSmartTreasuryId() {
  const value = getContractConfig().smartTreasurySuiId.trim();
  return value ? requireSuiObjectId(value, 'SPLASH_SMART_TREASURY_SUI_ID') : '';
}

async function requireSdkExecution() {
  const execution = await resolveSettlementExecution();
  if (execution !== 'sdk') {
    throw new Error(
      'The composed payment proof requires OPERATOR_SUI_PRIVATE_KEY so one server-signed SDK transaction can confirm, allocate, and anchor atomically.',
    );
  }
}

export async function createPaymentIntentOnSui(input: {
  recipient: string;
  amountMist: number;
  targetCurrency: string;
  fxRateScaled: number;
  /**
   * WS5. blake2b256(tag || bcs(payload) || salt), 32 bytes, from
   * lib/evidence/commitment.ts. This layer never sees the payload or the
   * salt; the caller keeps them in the Seal bundle. Required, so a caller
   * that still opens intents without one fails to compile.
   */
  commitment: Uint8Array;
}) {
  await requireSdkExecution();
  assertCommitmentBytes(input.commitment);
  const packageId = corePackageIdOrThrow();
  const recipient = requireConfiguredRecipient(input.recipient);
  const amountMist = Math.max(1, Math.floor(input.amountMist));
  const fxRateScaled = Math.max(1, Math.floor(input.fxRateScaled));
  const tx = new Transaction();
  tx.setGasBudget(process.env.SUI_COMPOSED_GAS_BUDGET ?? '30000000');
  tx.moveCall({
    target: `${packageId}::payment_intent::create_payment_intent`,
    typeArguments: [settlementCoinType()],
    arguments: [
      tx.pure.address(recipient),
      tx.pure.u64(amountMist),
      tx.pure.string(input.targetCurrency.toUpperCase()),
      tx.pure.u64(fxRateScaled),
      tx.pure.vector('u8', Array.from(input.commitment)),
      tx.object('0x6'),
    ],
  });

  const result = await executeSdkTransaction(tx);
  const events = resultEvents(result);
  const created = eventBySuffix(events, '::payment_intent::IntentCreated');
  const intentId = typeof created?.data.intent_id === 'string' ? created.data.intent_id : '';
  if (!intentId) {
    throw new Error(`PaymentIntent creation succeeded but IntentCreated was missing. Digest: ${result.digest}`);
  }

  return {
    digest: result.digest,
    intentId,
    event: created,
  };
}

export async function confirmComposedPaymentOnSui(input: {
  intentId: string;
  intentCreateDigest: string;
  paymentMist: number;
  treasuryAmountMist: number;
  auditHash: string;
  anchorId: string;
  backingBlobId: string;
}): Promise<ComposedSettlementResult> {
  await requireSdkExecution();
  const packageId = corePackageIdOrThrow();
  const anchorCapId = anchorCapObjectId();
  const businessAccountId = configIdOrThrow('businessAccountId', 'SPLASH_BUSINESS_ACCOUNT_ID');
  const smartTreasuryId = configuredSmartTreasuryId();
  const paymentMist = Math.max(1, Math.floor(input.paymentMist));
  const treasuryAmountMist = Math.max(0, Math.floor(input.treasuryAmountMist));

  if (treasuryAmountMist > 0 && !smartTreasuryId) {
    throw new Error('SPLASH_SMART_TREASURY_SUI_ID is required when treasuryAmountMist is greater than zero.');
  }

  const tx = new Transaction();
  tx.setGasBudget(process.env.SUI_COMPOSED_GAS_BUDGET ?? '30000000');
  const [paymentCoin] = tx.splitCoins(tx.gas, [paymentMist]);
  // 2026-07-19 package (0xec3b06…): confirm_payment_intent returns the
  // SettleReceipt hot-potato again — it MUST be consumed in the same PTB by
  // audit_anchor::anchor or the transaction aborts (unused value without drop).
  const [settleReceipt] = tx.moveCall({
    target: `${packageId}::payment_intent::confirm_payment_intent`,
    typeArguments: [settlementCoinType()],
    arguments: [
      tx.object(input.intentId),
      paymentCoin,
      tx.object('0x6'),
    ],
  });
  // Consume the receipt: emits SettlementAnchored binding the settlement to
  // the evidence ciphertext hash + Walrus blob (both guaranteed non-empty by
  // the composed-payment caller).
  tx.moveCall({
    target: `${packageId}::audit_anchor::anchor`,
    arguments: [
      settleReceipt,
      tx.pure.vector('u8', Array.from(Buffer.from(input.auditHash, 'utf8'))),
      tx.pure.vector('u8', Array.from(Buffer.from(input.backingBlobId, 'utf8'))),
      tx.object('0x6'),
    ],
  });

  if (treasuryAmountMist > 0) {
    // `smart_treasury` is a splash_custody module — the ONE custody call on the
    // composed path, which otherwise holds no balance. It must resolve through custody
    // package, not the core one: addressing a custody module with the core
    // package id is not a compile error, it is a runtime failure deep inside a
    // PTB. In Phase 0 this throws the licence-named error instead, which is the
    // honest outcome — the treasury allocation is a custodial operation and the
    // licence does not permit it yet.
    const custodyPackageId = custodyPackageIdOrThrow();
    const [treasuryCoin] = tx.splitCoins(tx.gas, [treasuryAmountMist]);
    tx.moveCall({
      target: `${custodyPackageId}::smart_treasury::deposit`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(smartTreasuryId),
        treasuryCoin,
        tx.object('0x6'),
      ],
    });
  }

  tx.moveCall({
    target: `${packageId}::audit_anchor::anchor_audit_hash`,
    arguments: [
      tx.object(anchorCapId),
      tx.object(capRegistryObjectId()),
      tx.pure.string(input.auditHash),
      tx.pure.string(input.anchorId),
      tx.pure.string(input.backingBlobId),
      tx.pure.address(businessAccountId),
      tx.object('0x6'),
    ],
  });

  const result = await executeSdkTransaction(tx);
  const events = resultEvents(result);
  const paid = eventBySuffix(events, '::payment_intent::IntentConfirmed');
  const allocated = eventBySuffix(events, '::smart_treasury::TreasuryDeposited');
  const anchored = eventBySuffix(events, '::audit_anchor::AuditAnchored');
  // Receipt-consuming proof (new package): audit_anchor::anchor must fire.
  const settlementAnchored = eventBySuffix(events, '::audit_anchor::SettlementAnchored');
  const auditAnchorObjectId =
    typeof anchored?.data.anchor_object === 'string' ? anchored.data.anchor_object : null;

  if (!paid || !anchored || !settlementAnchored || (treasuryAmountMist > 0 && !allocated)) {
    throw new Error(`Composed transaction succeeded but required proof events were missing. Digest: ${result.digest}`);
  }

  return {
    digest: result.digest,
    intentId: input.intentId,
    intentCreateDigest: input.intentCreateDigest,
    auditAnchorObjectId,
    smartTreasuryId: smartTreasuryId || null,
    events,
    objectChanges: result.objectChanges ?? [],
    composedActions: [
      {
        kind: 'paid',
        label: 'Payment intent confirmed',
        eventType: paid.type,
        data: paid.data,
      },
      ...(allocated
        ? [{
            kind: 'allocated' as const,
            label: 'Reserve allocated to Smart Treasury',
            eventType: allocated.type,
            data: allocated.data,
          }]
        : []),
      {
        kind: 'anchored',
        label: 'Audit proof anchored on Sui',
        eventType: anchored.type,
        data: anchored.data,
      },
    ],
    demo: false,
  };
}

export async function anchorAuditHashOnSui(input: {
  auditHash: string;
  anchorId: string;
  backingBlobId: string;
}) {
  await requireSdkExecution();
  const packageId = corePackageIdOrThrow();
  const anchorCapId = anchorCapObjectId();
  const businessAccountId = configIdOrThrow('businessAccountId', 'SPLASH_BUSINESS_ACCOUNT_ID');
  const tx = new Transaction();
  tx.setGasBudget(process.env.SUI_AUDIT_ANCHOR_GAS_BUDGET ?? '20000000');
  tx.moveCall({
    target: `${packageId}::audit_anchor::anchor_audit_hash`,
    arguments: [
      tx.object(anchorCapId),
      tx.object(capRegistryObjectId()),
      tx.pure.string(input.auditHash),
      tx.pure.string(input.anchorId),
      tx.pure.string(input.backingBlobId),
      tx.pure.address(businessAccountId),
      tx.object('0x6'),
    ],
  });
  const result = await executeSdkTransaction(tx);
  const anchored = eventBySuffix(resultEvents(result), '::audit_anchor::AuditAnchored');
  if (!anchored) throw new Error(`Audit anchor event missing. Digest: ${result.digest}`);
  return {
    digest: result.digest,
    anchorObjectId: typeof anchored.data.anchor_object === 'string' ? anchored.data.anchor_object : null,
    event: anchored,
  };
}

/**
 * On-chain half of KYB_ADMIN_APPROVED (wallet spec §3.3).
 *
 * AdminCap-gated on purpose: this is the accountable human decision, so it must
 * NOT be reachable from the Sumsub webhook. The provider only advances the
 * off-chain state to KYB_PROVIDER_APPROVED; a Splash admin action calls this.
 *
 * `businessAccountId` is resolved per-org (organizations.sui_business_account_id)
 * rather than from the single global env value, so verifying one tenant can
 * never flip another's account.
 */
export async function verifyBusinessOnSui(input: {
  businessAccountId: string;
  riskScore: number;
}) {
  await requireSdkExecution();
  const packageId = corePackageIdOrThrow();
  const adminCapId = configIdOrThrow('adminCapId', 'SPLASH_ADMIN_CAP_ID');
  const businessAccountId = requireSuiObjectId(input.businessAccountId, 'businessAccountId');

  const riskScore = Math.max(0, Math.min(255, Math.round(input.riskScore)));

  const tx = new Transaction();
  tx.setGasBudget(process.env.SUI_KYB_VERIFY_GAS_BUDGET ?? '20000000');
  tx.moveCall({
    target: `${packageId}::business_account::verify_business`,
    arguments: [
      tx.object(adminCapId),
      tx.object(businessAccountId),
      tx.pure.u8(riskScore),
    ],
  });

  const result = await executeSdkTransaction(tx);
  const verified = eventBySuffix(resultEvents(result), '::business_account::BusinessVerified');
  if (!verified) {
    throw new Error(`verify_business succeeded but BusinessVerified was missing. Digest: ${result.digest}`);
  }
  return { digest: result.digest, businessAccountId, riskScore, event: verified };
}

export async function refreshPegOnSui(input: { usdcPrice: number; usdtPrice: number }) {
  await requireSdkExecution();
  const packageId = corePackageIdOrThrow();
  const pegStateId = configIdOrThrow('pegStateId', 'SPLASH_PEG_STATE_ID');
  const anchorCapId = anchorCapObjectId();
  const usdcDeviationPpm = Math.max(0, Math.round(Math.abs(input.usdcPrice - 1) * 1_000_000));
  const usdtDeviationPpm = Math.max(0, Math.round(Math.abs(input.usdtPrice - 1) * 1_000_000));

  const tx = new Transaction();
  tx.setGasBudget(process.env.SUI_PEG_UPDATE_GAS_BUDGET ?? '10000000');
  tx.moveCall({
    target: `${packageId}::peg_monitor::update_peg`,
    arguments: [
      tx.object(pegStateId),
      tx.object(anchorCapId),
      tx.object(capRegistryObjectId()),
      tx.pure.u64(usdcDeviationPpm),
      tx.pure.u64(usdtDeviationPpm),
      tx.object('0x6'),
    ],
  });

  const result = await executeSdkTransaction(tx);
  return {
    digest: result.digest,
    usdcDeviationPpm,
    usdtDeviationPpm,
  };
}

export async function getOperatorWalletInfo(): Promise<{
  address: string;
  /** u64 MIST as a decimal string — beyond Number.MAX_SAFE_INTEGER above
   *  ~9M SUI, and a wallet total is not worth rounding. */
  totalMist: string;
  totalSui: string;
  coinCount: number;
}> {
  const signer = getOperatorKeypair();
  if (signer) {
    const address = signer.toSuiAddress();
    const coins = await listSdkGasCoins(address);
    const totalMist = coins.reduce((sum, coin) => sum + coin.balance, 0n);
    return {
      address,
      totalMist: totalMist.toString(),
      totalSui: formatMinor(totalMist, MIST_DECIMALS),
      coinCount: coins.length,
    };
  }

  const cli = await getCliReadiness();
  if (cli.ready) {
    const coins = await listOperatorGasCoins();
    const totalMist = coins.reduce((sum, coin) => sum + coin.balance, 0n);
    return {
      address: cli.address,
      totalMist: totalMist.toString(),
      totalSui: formatMinor(totalMist, MIST_DECIMALS),
      coinCount: coins.length,
    };
  }

  return {
    address: configuredOperatorAddress() || '0x0000000000000000000000000000000000000000000000000000000000000000',
    totalMist: '0',
    totalSui: '0.000000',
    coinCount: 0,
  };
}

async function listOperatorGasCoins(): Promise<OperatorGasCoin[]> {
  const { stdout } = await runSuiCommand(['client', 'gas', '--json']);
  return parseCliGasCoins(stdout);
}

async function listSdkGasCoins(address: string): Promise<OperatorGasCoin[]> {
  const coins: OperatorGasCoin[] = [];
  let cursor: string | null | undefined;

  do {
    const page = await suiClient.listCoins({ owner: address, cursor, coinType: '0x2::sui::SUI' });
    coins.push(
      ...page.objects
        .map((coin) => ({ id: coin.objectId, balance: toMist(coin.balance) }))
        .filter((coin) => coin.balance > 0n),
    );
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);

  return coins.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
}

/**
 * Pick the largest operator coin to use as gas, and return any extra coins
 * that must be merged into it inside the PTB to cover `neededMist`.
 *
 * Throws if the operator's total balance is insufficient.
 */
async function planGasCoin(neededMist: number): Promise<{ primaryId: string; mergeIds: string[] }> {
  const coins = await listOperatorGasCoins();
  if (coins.length === 0) {
    throw new Error('Operator wallet has no SUI coins. Fund the operator address.');
  }

  const total = coins.reduce((sum, coin) => sum + coin.balance, 0n);
  if (total < BigInt(neededMist)) {
    throw new Error(`Operator wallet has ${total} MIST but transfer needs ${neededMist} MIST (payment + gas). Top up the operator wallet.`);
  }

  const [primary, ...rest] = coins;
  const mergeIds: string[] = [];
  let accumulated = primary.balance;

  for (const coin of rest) {
    if (accumulated >= neededMist) break;
    mergeIds.push(coin.id);
    accumulated += coin.balance;
  }

  return { primaryId: primary.id, mergeIds };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function updatePegOnSui(): Promise<void> {
  const SPLASH_PACKAGE_ID = optionalConfigId('packageId');
  const SPLASH_PEG_STATE_ID = optionalConfigId('pegStateId');
  // A-12: no adminCapId fallback. An unconfigured attestation cap must stop the
  // peg daemon, not silently promote the hot key to money authority.
  const SPLASH_ANCHOR_CAP_ID = optionalConfigId('anchorCapId');
  const SPLASH_CAP_REGISTRY_ID = optionalConfigId('capRegistryId');

  if (!SPLASH_ANCHOR_CAP_ID) {
    console.warn('[Sui Peg Update] SPLASH_ANCHOR_CAP_ID is not set — skipping auto peg refresh. Settlement may fail with E_PEG_STALE. Point it at the AnchorCap minted by the package publish (business_account::init), rotated with business_account::rotate_anchor_cap — never at SPLASH_ADMIN_CAP_ID.');
    return;
  }
  if (!SPLASH_CAP_REGISTRY_ID) {
    console.warn('[Sui Peg Update] SPLASH_CAP_REGISTRY_ID is not set — skipping auto peg refresh. Since Phase 7 the anchor cap is checked against the shared CapRegistry on every use, so the call cannot be built without it. This is the correct failure: a code path that pushed a peg reading WITHOUT the revocation check is a path where a revoked capability still works.');
    return;
  }
  if (!SPLASH_PACKAGE_ID || !SPLASH_PEG_STATE_ID) {
    console.warn('[Sui Peg Update] Package or peg state not configured — skipping peg refresh.');
    return;
  }

  // Deviation in ppm from $1.00: 0 = healthy peg, max allowed on-chain = 3,000 ppm (0.30%).
  // Function signature: update_peg(peg_state, cap, usdc_deviation_ppm, usdt_deviation_ppm, clock)
  //
  // MEASURED, never a constant — see lib/server/peg-attestation.ts. When no
  // live reading is available we push NOTHING and let PegState go stale, so
  // assert_pegged aborts (302) instead of clearing settlement against a peg
  // nobody checked.
  const pegAttestation = await resolvePegAttestation();
  if (!pegAttestation.push) {
    console.warn(`[Sui Peg Update] refusing to attest the peg: ${pegAttestation.reason}`);
    return;
  }
  const usdcDeviationPpm = String(pegAttestation.usdcDeviationPpm);
  const usdtDeviationPpm = String(pegAttestation.usdtDeviationPpm);

  console.log('[Sui Peg Update] Refreshing peg (USDC dev:', usdcDeviationPpm, 'ppm, USDT dev:', usdtDeviationPpm, 'ppm)...');
  const { stdout, stderr } = await runSuiCommand([
    'client', 'call',
    '--package', SPLASH_PACKAGE_ID,
    '--module', 'peg_monitor',
    '--function', 'update_peg',
    '--args', SPLASH_PEG_STATE_ID, SPLASH_ANCHOR_CAP_ID, SPLASH_CAP_REGISTRY_ID, usdcDeviationPpm, usdtDeviationPpm, '0x6',
    '--gas-budget', process.env.SUI_PEG_UPDATE_GAS_BUDGET ?? '10000000',
    '--json',
  ], 1024 * 1024 * 5);

  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`Peg refresh produced no JSON. stdout: ${stdout.substring(0, 200)} stderr: ${stderr.substring(0, 200)}`);
  }

  const output = JSON.parse(stdout.slice(jsonStart)) as SuiCliCallOutput;
  if (output.effects?.status?.status !== 'success') {
    throw new Error(`Peg refresh failed: ${humanizeSuiError(output.effects?.status?.error, stderr)}`);
  }
  console.log('[Sui Peg Update] Peg refreshed:', output.digest);
}

export type SettlementBatchRow = {
  name?: string;
  address?: string;
  country?: string;
  purpose?: string;
  amount?: string;
};

type SuiCliCallOutput = {
  digest?: string;
  effects?: {
    transactionDigest?: string;
    status?: {
      status?: string;
      error?: string;
    };
  };
};

/**
 * A SUI/MIST quantity from an unknown source. The SDK returns balances as
 * strings; the CLI returns them as either. Both are integers already, so
 * this only widens them — it never parses a decimal.
 */
function toMist(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return 0n;
    return BigInt(value);
  }
  try {
    return BigInt(value.trim());
  } catch {
    return 0n;
  }
}

function requireSuiAddress(value: string, label: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a 32-byte Sui wallet address (0x + 64 hex chars). Got: "${value}". Set SPLASH_TEST_RECIPIENT_ADDRESS to a real wallet address — not an object ID.`);
  }

  return value;
}

function requireSuiObjectId(value: string, label: string) {
  if (!/^0x[a-fA-F0-9]+$/.test(value)) {
    throw new Error(`${label} must be a Sui object/package ID starting with 0x. Got: "${value}". Check ${label} in .env.local.`);
  }

  return value;
}

export async function recordSingleTransferOnSui(input: {
  transferId: string;
  recipient: string;
  amountUsd: number;
  stablecoinAmountMicro: number;
  /** ISO 4217 code of the destination corridor (e.g. 'PHP'). */
  targetCurrency?: string;
  /** Override the corridor fee. Bounded to CONTRACT_MAX_FEE_BPS. */
  feeBps?: number;
}) {
  const execution = await resolveSettlementExecution();
  if (execution === 'simulate') {
    const sim = simulatedSettlement(input.transferId);
    console.warn(`[Sui Single Transfer] sui CLI unavailable or simulate mode — recording SIMULATED settlement. transfer=${input.transferId} digest=${sim.digest}`);
    return sim;
  }
  const cfg = getContractConfig();
  const SPLASH_PACKAGE_ID = corePackageIdOrThrow();
  // settlement::settle_payment lives in splash_custody.
  const SPLASH_CUSTODY_PACKAGE_ID = custodyPackageIdOrThrow();
  const SPLASH_TREASURY_ID = configIdOrThrow('treasuryId', 'SPLASH_TREASURY_ID');
  const SPLASH_PEG_STATE_ID = configIdOrThrow('pegStateId', 'SPLASH_PEG_STATE_ID');
  const SPLASH_COMPLIANCE_CONFIG_ID = configIdOrThrow('complianceConfigId', 'SPLASH_COMPLIANCE_CONFIG_ID');
  const DEEPBOOK_POOL_ID = configIdOrThrow('deepbookPoolId', 'DEEPBOOK_POOL_ID');
  await assertDeepbookPoolWhitelisted();
  const SPLASH_BUSINESS_ACCOUNT_ID = configIdOrThrow('businessAccountId', 'SPLASH_BUSINESS_ACCOUNT_ID');
  if (!cfg.usdcType) throw new Error('USDC_TYPE is not configured. Set it in admin → Contract config (or in .env.local) and try again.');
  const USDC_TYPE = cfg.usdcType;
  if (!cfg.deepbookQuoteType) throw new Error('DEEPBOOK_QUOTE_TYPE is not configured. Set it in admin → Contract config.');
  const DEEPBOOK_QUOTE_TYPE = cfg.deepbookQuoteType;
  const recipientAddress = resolvePayoutRecipient(input.recipient, 'Transfer recipient');
  requireSuiAddress(recipientAddress, 'Transfer recipient');

  const feeBps = resolveFeeBps({ feeBps: input.feeBps, targetCurrency: input.targetCurrency });

  // Use at least 1_000_000 MIST so the fee calc (≤ MAX_FEE_BPS = 200 bps)
  // leaves a positive net amount per the contract's E_INSUFFICIENT_FUNDS check.
  const paymentMist = Math.max(1_000_000, input.stablecoinAmountMicro);

  // Peg refresh is bundled into the same PTB below — no separate tx, no staleness race.
  // settle_payment takes no capability, so the only cap this PTB needs is the
  // attestation cap for the peg push — this path stays fully hot after the split.
  const SPLASH_ANCHOR_CAP_ID = anchorCapObjectId();
  const SPLASH_CAP_REGISTRY_ID = capRegistryObjectId();
  // MEASURED, never a constant. Writing a hardcoded 0 here and reading it back
  // via assert_pegged one command later is what made the peg breaker inert.
  const pegAttestation = await resolvePegAttestation();
  if (!pegAttestation.push) {
    console.warn(`[Sui Peg] not attesting the peg in this PTB: ${pegAttestation.reason}`);
  }
  const usdcDeviationPpm = String(pegAttestation.push ? pegAttestation.usdcDeviationPpm : 0);
  const usdtDeviationPpm = String(pegAttestation.push ? pegAttestation.usdtDeviationPpm : 0);

  const gasBudget = process.env.SUI_RECORD_SETTLEMENT_GAS_BUDGET ?? '10000000';

  if (execution === 'sdk') {
    const tx = new Transaction();
    tx.setGasBudget(gasBudget);
    // Only attest a peg we actually measured. Pushing a constant here and
    // reading it back through assert_pegged one command later is what made the
    // breaker inert; when there is no live reading we omit the command entirely
    // and let PegState go stale (abort 302) rather than clear the settlement.
    if (pegAttestation.push) {
      tx.moveCall({
        target: `${SPLASH_PACKAGE_ID}::peg_monitor::update_peg`,
        arguments: [
          tx.object(SPLASH_PEG_STATE_ID),
          tx.object(SPLASH_ANCHOR_CAP_ID),
          tx.object(SPLASH_CAP_REGISTRY_ID),
          tx.pure.u64(usdcDeviationPpm),
          tx.pure.u64(usdtDeviationPpm),
          tx.object('0x6'),
        ],
      });
    }
    const [payment] = tx.splitCoins(tx.gas, [paymentMist]);
    tx.moveCall({
      target: `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::settle_payment`,
      typeArguments: [USDC_TYPE, DEEPBOOK_QUOTE_TYPE],
      arguments: [
        tx.object(SPLASH_TREASURY_ID),
        tx.object(SPLASH_BUSINESS_ACCOUNT_ID),
        tx.object(SPLASH_PEG_STATE_ID),
        tx.object(SPLASH_COMPLIANCE_CONFIG_ID),
        tx.object(DEEPBOOK_POOL_ID),
        payment,
        tx.pure.address(recipientAddress),
        tx.pure.u64(feeBps),
        tx.object('0x6'),
      ],
    });

    const result = await executeSdkTransaction(tx);
    return {
      digest: result.digest,
      packageId: SPLASH_PACKAGE_ID,
      treasuryId: SPLASH_TREASURY_ID,
    };
  }

  // The PTB will split `paymentMist` from the gas coin and burn up to
  // `gasBudget` MIST for fees, so the chosen gas coin must cover both.
  const { primaryId, mergeIds } = await planGasCoin(paymentMist + Number(gasBudget));

  // PTB: optionally merge fragmented coins into the gas coin, then split the
  // payment from gas and call settle_payment. This avoids a static
  // SPLASH_TRANSFER_COIN_ID that gets consumed after one use, and lets a
  // wallet with many small coins still fund a large transfer.
  const ptbArgs: string[] = ['client', 'ptb'];
  if (mergeIds.length > 0) {
    ptbArgs.push('--merge-coins', 'gas', `[${mergeIds.map((id) => `@${id}`).join(',')}]`);
  }
  if (pegAttestation.push) {
    // 1. Attest the peg reading we just MEASURED, atomically with the settle
    //    below. Skipped entirely when no live reading is available, so
    //    assert_pegged falls back to the staleness guard.
    ptbArgs.push(
      '--move-call',
      `${SPLASH_PACKAGE_ID}::peg_monitor::update_peg`,
      `@${SPLASH_PEG_STATE_ID}`,
      `@${SPLASH_ANCHOR_CAP_ID}`,
      `@${SPLASH_CAP_REGISTRY_ID}`,
      usdcDeviationPpm,
      usdtDeviationPpm,
      '@0x6',
    );
  }
  ptbArgs.push(
    // 2. Split payment from gas
    '--split-coins', 'gas', `[${paymentMist}]`,
    '--assign', 'payment',
    // 3. Settle — assert_pegged reads the freshly-updated PegState from step 1.
    //    Published v1 requires fee_bps before the Clock argument.
    '--move-call',
    `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::settle_payment`,
    `<${USDC_TYPE},${DEEPBOOK_QUOTE_TYPE}>`,
    `@${SPLASH_TREASURY_ID}`,
    `@${SPLASH_BUSINESS_ACCOUNT_ID}`,
    `@${SPLASH_PEG_STATE_ID}`,
    `@${SPLASH_COMPLIANCE_CONFIG_ID}`,
    `@${DEEPBOOK_POOL_ID}`,
    'payment.0',
    `@${recipientAddress}`,
    feeBps.toString(),
    '@0x6',
    '--gas-coin', `@${primaryId}`,
    '--gas-budget', gasBudget,
    '--json',
  );

  console.log('[Sui Single Transfer] Calling sui client ptb with:', {
    package: SPLASH_PACKAGE_ID,
    usdcType: USDC_TYPE,
    function: 'settle_payment',
    paymentMist,
    feeBps,
    targetCurrency: input.targetCurrency,
    recipient: recipientAddress,
    gasCoin: primaryId,
    mergedCoinCount: mergeIds.length,
  });

  const { stdout, stderr } = await runSuiCommand(ptbArgs);

  console.log('[Sui Single Transfer] CLI stdout:', stdout.substring(0, 500));
  console.log('[Sui Single Transfer] CLI stderr:', stderr.substring(0, 500));

  const jsonStart = stdout.indexOf('{');

  if (jsonStart === -1) {
    throw new Error(`Sui CLI did not return JSON output. stdout: ${stdout.substring(0, 200)}, stderr: ${stderr.substring(0, 200)}`);
  }

  const output = JSON.parse(stdout.slice(jsonStart)) as SuiCliCallOutput;
  const digest = output.digest ?? output.effects?.transactionDigest ?? null;
  const status = output.effects?.status?.status;

  if (!digest || status !== 'success') {
    const errorMsg = humanizeSuiError(output.effects?.status?.error, stderr);
    console.error('[Sui Single Transfer] Transaction failed:', errorMsg);
    throw new Error(errorMsg);
  }

  console.log('[Sui Single Transfer] Transaction successful:', digest);

  return {
    digest,
    packageId: SPLASH_PACKAGE_ID,
    treasuryId: SPLASH_TREASURY_ID,
  };
}

export async function recordBatchSettlementOnSui(input: {
  batchId: string;
  rows: SettlementBatchRow[];
  totalUsd: number;
  /** ISO 4217 code of the destination corridor (e.g. 'PHP'). One fee per batch. */
  targetCurrency?: string;
  /** Override the corridor fee. Bounded to CONTRACT_MAX_FEE_BPS. */
  feeBps?: number;
}) {
  const execution = batchExecutionOverride() ?? await resolveSettlementExecution();
  if (execution === 'simulate') {
    const sim = simulatedSettlement(input.batchId);
    console.warn(`[Sui Batch Settlement] simulate mode (or CLI unavailable) — recording SIMULATED settlement. batch=${input.batchId} rows=${input.rows.length} digest=${sim.digest}`);
    return { ...sim, simulated: true as const };
  }
  const cfg = getContractConfig();
  // Core modules (peg_monitor) and custody modules (settlement) now live in
  // SEPARATE packages. Under Phase 0 the custody package is not published, so
  // this resolution is what turns 'the licence does not permit custody' into a
  // clear error instead of an ObjectNotFound deep inside a PTB.
  const SPLASH_PACKAGE_ID = corePackageIdOrThrow();
  const SPLASH_CUSTODY_PACKAGE_ID = custodyPackageIdOrThrow();
  const SPLASH_TREASURY_ID = configIdOrThrow('treasuryId', 'SPLASH_TREASURY_ID');
  const SPLASH_PEG_STATE_ID = configIdOrThrow('pegStateId', 'SPLASH_PEG_STATE_ID');
  // Called for its side effect, not its value: it throws a named error if the
  // id is unconfigured, which is the whole point of the pre-flight above.
  configIdOrThrow('businessAccountId', 'SPLASH_BUSINESS_ACCOUNT_ID');
  // 2026-07-19 package (0xec3b06…): settle_sui_batch pays recipients from the
  // SUI SettlementPool but now ALSO requires the ComplianceConfig object, a
  // DeepBook Pool<SUI, QuoteAsset> reference for the liquidity guard, and the
  // QuoteAsset type argument.
  const SPLASH_COMPLIANCE_CONFIG_ID = configIdOrThrow('complianceConfigId', 'SPLASH_COMPLIANCE_CONFIG_ID');
  const DEEPBOOK_POOL_ID = configIdOrThrow('deepbookPoolId', 'DEEPBOOK_POOL_ID');
  await assertDeepbookPoolWhitelisted();
  if (!cfg.deepbookQuoteType) {
    throw new Error('DEEPBOOK_QUOTE_TYPE is not configured — settle_sui_batch<QuoteAsset> needs the DeepBook quote type. Set it in admin → Contract config (or .env.local), or run batches in simulate mode.');
  }
  const DEEPBOOK_QUOTE_TYPE = cfg.deepbookQuoteType;
  const feeBps = resolveFeeBps({ feeBps: input.feeBps, targetCurrency: input.targetCurrency });

  // Peg refresh is bundled into the same PTB below — no separate tx, no staleness race.
  //
  // NOTE (cap split, spec §5): this PTB needs BOTH caps — the attestation cap
  // for `update_peg` and the money-authority AdminCap for `settle_sui_batch`,
  // which pays recipients out of the shared SettlementPool. That means once the
  // AdminCap moves to a cold 2-of-3 multisig, batch settlement can no longer be
  // driven by the hot server alone. Resolving that (a bounded, hot
  // `SettlementCap` with per-batch limits) is an explicit follow-up decision —
  // see docs/KEY-CEREMONY-RUNBOOK.md. Single transfers are unaffected.
  const SPLASH_ANCHOR_CAP_ID = anchorCapObjectId();
  const SPLASH_CAP_REGISTRY_ID = capRegistryObjectId();
  // The batch no longer takes an AdminCap. It takes a delegation the TENANT
  // granted, which the operator owns and can therefore name as an input.
  const SPLASH_PAYOUT_DELEGATION_ID = configIdOrThrow('payoutDelegationId', 'SPLASH_PAYOUT_DELEGATION_ID');
  // MEASURED, never a constant. Writing a hardcoded 0 here and reading it back
  // via assert_pegged one command later is what made the peg breaker inert.
  const pegAttestation = await resolvePegAttestation();
  if (!pegAttestation.push) {
    console.warn(`[Sui Peg] not attesting the peg in this PTB: ${pegAttestation.reason}`);
  }
  const usdcDeviationPpm = String(pegAttestation.push ? pegAttestation.usdcDeviationPpm : 0);
  const usdtDeviationPpm = String(pegAttestation.push ? pegAttestation.usdtDeviationPpm : 0);

  // A batch creates one Coin object and emits one event PER ROW, so a flat
  // budget is wrong by construction: 10_000_000 MIST was exhausted at
  // single-digit row counts while the single-transfer path next door used
  // 30_000_000 for one payment.
  const batchSize = checkBatchSize(input.rows.length);
  if (!batchSize.ok) throw new Error(batchSize.message);
  const gasBudget = batchGasBudgetMist(input.rows.length, process.env.SUI_RECORD_SETTLEMENT_GAS_BUDGET);

  // Pre-flight: the most common batch failure is an unfunded SettlementPool,
  // which otherwise surfaces as an opaque MoveAbort mid-PTB. Check it here so
  // the operator gets an actionable message instead of an abort code.
  await assertSettlementPoolFunded(SPLASH_TREASURY_ID, input.rows);

  const paymentObjects = input.rows.map((row) => {
    const amount = parseMinor(row.amount ?? '0', MICRO_DECIMALS, 'half-up');
    const recipient = requireSuiAddress(resolvePayoutRecipient(row.address, `Batch recipient ${row.name ?? row.address ?? ''}`.trim()), `Batch recipient ${row.name ?? row.address ?? ''}`.trim());
    return { recipient, amount };
  });

  if (execution === 'sdk') {
    const tx = new Transaction();
    tx.setGasBudget(gasBudget);
    // Only attest a peg we actually measured. Pushing a constant here and
    // reading it back through assert_pegged one command later is what made the
    // breaker inert; when there is no live reading we omit the command entirely
    // and let PegState go stale (abort 302) rather than clear the settlement.
    if (pegAttestation.push) {
      tx.moveCall({
        target: `${SPLASH_PACKAGE_ID}::peg_monitor::update_peg`,
        arguments: [
          tx.object(SPLASH_PEG_STATE_ID),
          tx.object(SPLASH_ANCHOR_CAP_ID),
          tx.object(SPLASH_CAP_REGISTRY_ID),
          tx.pure.u64(usdcDeviationPpm),
          tx.pure.u64(usdtDeviationPpm),
          tx.object('0x6'),
        ],
      });
    }
    const payments = paymentObjects.map((payment) =>
      tx.moveCall({
        target: `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::new_payment`,
        arguments: [tx.pure.address(payment.recipient), tx.pure.u64(payment.amount)],
      }),
    );
    const paymentVector = tx.makeMoveVec({
      type: `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::Payment`,
      elements: payments,
    });
    // AdminCap and BusinessAccount are GONE from this call, and that is the
    // whole point. They were owned by two different addresses (cold multisig and
    // tenant), and a Sui transaction may only name owned objects belonging to
    // its sender — so the old `settle_batch` could not be signed by anyone.
    // The delegation carries the tenant's identity and their rate limit, and the
    // operator owns it, so one signer suffices.
    tx.moveCall({
      target: `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::settle_sui_batch_delegated`,
      typeArguments: [DEEPBOOK_QUOTE_TYPE],
      arguments: [
        tx.object(SPLASH_TREASURY_ID),
        tx.object(SPLASH_PAYOUT_DELEGATION_ID),
        tx.object(SPLASH_PEG_STATE_ID),
        tx.object(SPLASH_COMPLIANCE_CONFIG_ID),
        tx.object(DEEPBOOK_POOL_ID),
        paymentVector,
        tx.pure.u64(feeBps),
        tx.object('0x6'),
      ],
    });

    const result = await executeSdkTransaction(tx);
    return {
      digest: result.digest,
      packageId: SPLASH_PACKAGE_ID,
      treasuryId: SPLASH_TREASURY_ID,
    };
  }

  const ptbArgs = ['client', 'ptb'];
  if (pegAttestation.push) {
    // 1. Attest the MEASURED peg reading, atomically with settle_batch below.
    ptbArgs.push(
      '--move-call',
      `${SPLASH_PACKAGE_ID}::peg_monitor::update_peg`,
      `@${SPLASH_PEG_STATE_ID}`,
      `@${SPLASH_ANCHOR_CAP_ID}`,
      `@${SPLASH_CAP_REGISTRY_ID}`,
      usdcDeviationPpm,
      usdtDeviationPpm,
      '@0x6',
    );
  }

  paymentObjects.forEach((payment, index) => {
    ptbArgs.push(
      '--move-call',
      `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::new_payment`,
      `@${payment.recipient}`,
      payment.amount.toString(),
      '--assign',
      `payment_${index}`,
    );
  });

  ptbArgs.push(
    '--make-move-vec',
    `<${SPLASH_CUSTODY_PACKAGE_ID}::settlement::Payment>`,
    `[${paymentObjects.map((_, index) => `payment_${index}`).join(',')}]`,
    '--assign',
    'payments',
    // No AdminCap and no BusinessAccount: they were owned by two different
    // addresses, which made the old settle_batch unsignable by anyone. The
    // delegation carries the tenant's identity and rate limit, and the operator
    // owns it, so one signature is enough.
    '--move-call',
    `${SPLASH_CUSTODY_PACKAGE_ID}::settlement::settle_sui_batch_delegated`,
    `<${DEEPBOOK_QUOTE_TYPE}>`,
    `@${SPLASH_TREASURY_ID}`,
    `@${SPLASH_PAYOUT_DELEGATION_ID}`,
    `@${SPLASH_PEG_STATE_ID}`,
    `@${SPLASH_COMPLIANCE_CONFIG_ID}`,
    `@${DEEPBOOK_POOL_ID}`,
    'payments',
    feeBps.toString(),
    '@0x6',
    '--gas-budget',
    gasBudget,
    '--json',
  );

  console.log('[Sui Batch Settlement] Calling sui client call with:', {
    package: SPLASH_PACKAGE_ID,
    module: 'settlement',
    function: 'settle_sui_batch',
    feeBps,
    targetCurrency: input.targetCurrency,
    args: ptbArgs,
  });

  const { stdout, stderr } = await runSuiCommand(ptbArgs);

  console.log('[Sui Batch Settlement] CLI stdout:', stdout.substring(0, 500));
  console.log('[Sui Batch Settlement] CLI stderr:', stderr.substring(0, 500));

  const jsonStart = stdout.indexOf('{');

  if (jsonStart === -1) {
    throw new Error(`Sui CLI did not return JSON output. stdout: ${stdout.substring(0, 200)}, stderr: ${stderr.substring(0, 200)}`);
  }

  const output = JSON.parse(stdout.slice(jsonStart)) as SuiCliCallOutput;
  const digest = output.digest ?? output.effects?.transactionDigest ?? null;
  const status = output.effects?.status?.status;

  if (!digest || status !== 'success') {
    const errorMsg = humanizeSuiError(output.effects?.status?.error, stderr);
    console.error('[Sui Batch Settlement] Transaction failed:', errorMsg);
    throw new Error(errorMsg);
  }

  console.log('[Sui Batch Settlement] Transaction successful:', digest);

  return {
    digest,
    packageId: SPLASH_PACKAGE_ID,
    treasuryId: SPLASH_TREASURY_ID,
  };
}

export type ComplianceControls = {
  configured: boolean;
  maxDeviationPpm: number;
  maxStalenessMs: number;
  maxSlippageBps: number;
  minDepthBaseUnits: number;
  /// Gross settlement floor in the settled coin's minor units. `null` when the
  /// deployed package predates it (see the ABI straddle below).
  minSettlementAmount: bigint | null;
  /// DeepBook venues the on-chain liquidity guard will accept (audit S-12).
  /// Empty array means the deployed package predates the whitelist — NOT that
  /// every pool is allowed.
  allowedDeepbookPools: string[];
  /// True when the deployed package enforces the whitelist at all. Callers that
  /// want to fail closed should check this, not `allowedDeepbookPools.length`.
  poolWhitelistEnforced: boolean;
  paused: boolean;
};

const DEFAULT_COMPLIANCE_CONTROLS: ComplianceControls = {
  configured: false,
  maxDeviationPpm: 3_000,
  maxStalenessMs: 60_000,
  maxSlippageBps: 100,
  minDepthBaseUnits: 100_000_000,
  minSettlementAmount: null,
  allowedDeepbookPools: [],
  poolWhitelistEnforced: false,
  paused: false,
};

export async function readComplianceControls(): Promise<ComplianceControls> {
  const config = getContractConfig();
  if (!config.complianceConfigId) return DEFAULT_COMPLIANCE_CONTROLS;
  try {
    const { object } = await suiClient.getObject({ objectId: config.complianceConfigId, include: { json: true } });
    const fields = object.json as Record<string, unknown> | null | undefined;
    if (!fields) return DEFAULT_COMPLIANCE_CONTROLS;
    const whitelist = parsePoolWhitelist(fields);
    return {
      configured: true,
      maxDeviationPpm: Number(fields.max_deviation_ppm),
      maxStalenessMs: Number(fields.max_staleness_ms),
      maxSlippageBps: Number(fields.max_slippage_bps),
      minDepthBaseUnits: Number(fields.min_depth_base_units),
      // A settlement floor is an amount, so it is read as one. The other
      // fields here are bounds and durations, which are counts.
      minSettlementAmount:
        fields.min_settlement_amount === undefined ? null : BigInt(String(fields.min_settlement_amount)),
      allowedDeepbookPools: whitelist ?? [],
      poolWhitelistEnforced: whitelist !== null,
      paused: fields.paused === true || fields.paused === 'true',
    };
  } catch {
    return DEFAULT_COMPLIANCE_CONTROLS;
  }
}

export type PoolWhitelistCheck = PoolWhitelistVerdict;

/**
 * Preflight for audit S-12. `assert_deepbook_liquidity` aborts with 353 if the
 * pool we pass is not whitelisted on chain; catching it here turns an opaque
 * MoveAbort into an actionable message, and — more importantly — stops us
 * burning gas on a settlement that cannot succeed.
 *
 * Deliberately does NOT fail when the deployed package predates the whitelist:
 * that is the ABI straddle, not a misconfiguration. It reports `enforced: false`
 * so callers can surface the weaker posture instead of pretending it is on.
 */
export async function checkDeepbookPoolWhitelisted(): Promise<PoolWhitelistCheck> {
  const poolId = getContractConfig().deepbookPoolId ?? '';
  const controls = await readComplianceControls();

  if (!controls.configured) {
    return {
      allowed: false,
      enforced: false,
      poolId: poolId.trim(),
      reason: 'SPLASH_COMPLIANCE_CONFIG_ID is not configured or could not be read.',
    };
  }
  return checkPoolAllowed(poolId, controls.poolWhitelistEnforced ? controls.allowedDeepbookPools : null);
}

/**
 * Throwing form used on the settlement hot paths. Runs BEFORE the PTB is built,
 * so a misconfigured venue costs a read instead of a failed on-chain transaction
 * — and, on the batch path, before we borrow the AdminCap.
 */
export async function assertDeepbookPoolWhitelisted(): Promise<void> {
  const verdict = await checkDeepbookPoolWhitelisted();
  if (verdict.allowed) {
    if (!verdict.enforced) {
      console.warn(
        '[Sui Settlement] the deployed package predates ComplianceConfig.allowed_deepbook_pools ' +
          '(audit S-12): the liquidity guard still accepts any pool the operator passes. ' +
          'Republish to enforce the venue whitelist.',
      );
    }
    return;
  }
  throw new Error(`DeepBook venue rejected (audit S-12): ${verdict.reason}`);
}

export async function updateComplianceControls(
  input: {
    maxDeviationPpm: number;
    maxStalenessMs: number;
    maxSlippageBps: number;
    minDepthBaseUnits: number;
    /** A settlement floor in base units. Bounded by the API schema. */
    minSettlementAmount: number | null;
    paused: boolean;
  },
) {
  const packageId = corePackageIdOrThrow();
  const configId = configIdOrThrow('complianceConfigId', 'SPLASH_COMPLIANCE_CONFIG_ID');
  const capId = configIdOrThrow('complianceCapId', 'SPLASH_COMPLIANCE_CAP_ID');
  if (!getOperatorKeypair()) throw new Error('OPERATOR_SUI_PRIVATE_KEY is required to update compliance controls.');

  // ABI straddle. `update` gained a 5th parameter (min_settlement_amount) in the
  // republished package; the version deployed today still has 4. Detect which
  // one we are talking to from the object itself rather than guessing, because
  // an arity mismatch is a hard MoveCall failure, not a graceful degrade.
  const onChain = await readComplianceControls();
  const supportsMinSettlement = onChain.minSettlementAmount !== null;
  const minSettlement =
    input.minSettlementAmount !== undefined && input.minSettlementAmount !== null
      ? BigInt(input.minSettlementAmount)
      : onChain.minSettlementAmount;
  if (supportsMinSettlement && !(minSettlement !== null && minSettlement > 0n)) {
    throw new Error('minSettlementAmount must be greater than zero — a zero floor disables the minimum on chain.');
  }

  // Phase 6: ComplianceCap is subtractive BY TYPE. `tighten` aborts on any
  // argument that loosens a control, and there is no ComplianceCap unpause at
  // all — both directions of loosening are AdminCap, which lives on the cold
  // multisig and which this server does not hold.
  //
  // So refuse here, with the exact command, rather than building a PTB that
  // aborts on chain. A 356 in a wallet is a worse explanation than a sentence.
  const loosenings: string[] = [];
  if (input.maxDeviationPpm > onChain.maxDeviationPpm) {
    loosenings.push(`maxDeviationPpm ${onChain.maxDeviationPpm} -> ${input.maxDeviationPpm} (tolerating more peg drift)`);
  }
  if (input.maxStalenessMs > onChain.maxStalenessMs) {
    loosenings.push(`maxStalenessMs ${onChain.maxStalenessMs} -> ${input.maxStalenessMs} (tolerating older readings)`);
  }
  if (input.maxSlippageBps > onChain.maxSlippageBps) {
    loosenings.push(`maxSlippageBps ${onChain.maxSlippageBps} -> ${input.maxSlippageBps} (tolerating more slippage)`);
  }
  if (input.minDepthBaseUnits < onChain.minDepthBaseUnits) {
    loosenings.push(`minDepthBaseUnits ${onChain.minDepthBaseUnits} -> ${input.minDepthBaseUnits} (requiring less depth)`);
  }
  if (supportsMinSettlement && minSettlement !== null && onChain.minSettlementAmount !== null && minSettlement < onChain.minSettlementAmount) {
    loosenings.push(`minSettlementAmount ${onChain.minSettlementAmount} -> ${minSettlement} (letting smaller settlements through)`);
  }
  if (onChain.paused && !input.paused) {
    loosenings.push('resuming settlement');
  }

  if (loosenings.length > 0) {
    throw new Error(
      'The compliance capability can only make controls stricter. This change loosens: ' +
        `${loosenings.join('; ')}. Loosening is AdminCap — run it from the cold multisig:
` +
        `  sui client call --package ${packageId} --module compliance_config ` +
        `--function admin_set_parameters --args <ADMIN_CAP_ID> ${configId} ` +
        `${input.maxDeviationPpm} ${input.maxStalenessMs} ${input.maxSlippageBps} ${input.minDepthBaseUnits}` +
        `${supportsMinSettlement && minSettlement !== null ? ` ${minSettlement}` : ''}` +
        (onChain.paused && !input.paused
          ? `
  sui client call --package ${packageId} --module compliance_config --function admin_set_paused --args <ADMIN_CAP_ID> ${configId} false`
          : ''),
    );
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::compliance_config::tighten`,
    arguments: [
      tx.object(configId),
      tx.object(capId),
      tx.object(capRegistryObjectId()),
      tx.pure.u64(input.maxDeviationPpm),
      tx.pure.u64(input.maxStalenessMs),
      tx.pure.u64(input.maxSlippageBps),
      tx.pure.u64(input.minDepthBaseUnits),
      ...(supportsMinSettlement && minSettlement !== null ? [tx.pure.u64(minSettlement)] : []),
    ],
  });
  if (input.paused && !onChain.paused) {
    tx.moveCall({
      target: `${packageId}::compliance_config::pause`,
      arguments: [tx.object(configId), tx.object(capId), tx.object(capRegistryObjectId())],
    });
  }
  return executeSdkTransaction(tx);
}
