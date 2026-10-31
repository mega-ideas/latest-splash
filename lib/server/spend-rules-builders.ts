/**
 * v2 transaction builders for spending rules (§4.2, decision D2): the PTBs
 * the business wallet signs to give, change and take back a staff member's
 * rule, and the one an owner signs to give a second approval.
 *
 * Every call is to a function Phase 1 published, with its exact signature
 * (move/splash_spend/sources/spend_policy.move, splash_spend.move) or to the
 * framework's allowance module:
 *
 *   createSpendPolicyTx   spend_policy::create_policy<USDC>        the wallet
 *   spendRuleTx           any of, in order:
 *                           spend_policy::add_spender / remove_spender
 *                           spend_policy::verify_recipient / remove_recipient
 *                           spend_policy::verify_beneficiary / remove_beneficiary
 *                           spend_policy::set_limits / set_running_window
 *                           0x2::allowance::revoke<Balance<USDC>>       (a rule taken back)
 *                           0x2::allowance::periodic_rate_limit | monthly_rate_limit
 *                           0x1::option::some<RateLimit>
 *                           0x2::allowance::propose_for_app<Balance<USDC>, SPLASH_SPEND>
 *                           splash_spend::accept<USDC>               the wallet
 *   approvePayoutTx       splash_spend::approve_payout              one owner
 *
 * A rule is an app-bound allowance from the wallet to the staff member's
 * address, named `splash-policy:<policy id>` so it pays only under the
 * policy that accepted it, plus the staff member's place on the policy with
 * their own per-payment maximum. Changing a rule is revoking its allowance
 * and issuing a new one in the same transaction (an allowance's settings
 * cannot change); a new per-payment maximum also removes and re-adds the
 * spender, which retires every outstanding approval (Move: `generation`).
 *
 * There is no `rotate_spender` here, as there is none in splash_spend. Every
 * builder is offline (shared objects by initial version), sponsored the same
 * way as the wallet's own transactions (lib/server/sui-v2-builders.ts).
 */
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { MS_PER_DAY } from '../wallet/allowance-window.ts';
import { applySponsoredGas, V2BuildError, type SharedRef, type SponsoredGas, type V2Chain } from './sui-v2-builders.ts';

export type SpendChain = V2Chain & {
  spendPackageId: string;
  /** The `PolicyRegistry` shared at splash_spend's publish. */
  policyRegistry: SharedRef;
};

export type OwnedRef = { objectId: string; version: string | number; digest: string };

/** STAFF (1) open and pay; EXECUTOR (2), Splash's operator, only pays what the owners approved. */
export const SPEND_ROLE = Object.freeze({ STAFF: 1, EXECUTOR: 2 });
/** The kinds a verified recipient is tagged with (A1 §2.3). */
export const RECIPIENT_TAG = Object.freeze({ WALLET: 1, EXCHANGE: 2 });
/** Every destination a policy verifies is on Sui (CCTP domain 8). */
export const SUI_DOMAIN = 8;

/** A rule's recurring cap: per day (24 hours from the first payment) or per month (from the first payment, renewing on that day at 00:00 UTC). */
export type RuleCap = { period: 'day'; limitMinor: bigint } | { period: 'month'; limitMinor: bigint };

export type RuleOp =
  | { op: 'add_spender'; spender: string; role: number; perPaymentMaxMinor: bigint }
  | { op: 'remove_spender'; spender: string }
  | { op: 'verify_recipient'; address: string; kind: number }
  | { op: 'remove_recipient'; address: string }
  | { op: 'verify_beneficiary'; commitment: Uint8Array; partnerDeposit: string }
  | { op: 'remove_beneficiary'; commitment: Uint8Array }
  | { op: 'set_limits'; perPaymentMaxMinor: bigint; secondApprovalThresholdMinor: bigint }
  | { op: 'set_running_window'; windowMs: bigint }
  | { op: 'revoke_allowance'; cap: OwnedRef; allowance: SharedRef }
  | {
      op: 'issue_allowance';
      spender: string;
      /** `splash_spend::allowance_name` of the policy that accepts it. */
      name: string;
      cap: RuleCap;
      lifetimeCapMinor?: bigint | null;
      startsAtMs?: bigint | null;
      expiresAtMs: bigint;
    };

const U64_MAX = 18_446_744_073_709_551_615n;

function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) throw new V2BuildError(`${what} is out of range`, 'bad_amount');
  return v;
}

const spendFn = (chain: SpendChain, target: string) => `${normalizeSuiAddress(chain.spendPackageId)}::${target}`;
const coreUsdc = (chain: SpendChain) => normalizeStructTag(chain.usdcType);
export const balanceType = (chain: Pick<V2Chain, 'usdcType'>) => `0x2::balance::Balance<${normalizeStructTag(chain.usdcType)}>`;
export const splashSpendAppType = (chain: Pick<SpendChain, 'spendPackageId'>) => `${normalizeSuiAddress(chain.spendPackageId)}::splash_spend::SPLASH_SPEND`;

function shared(tx: Transaction, ref: SharedRef, mutable: boolean) {
  return tx.sharedObjectRef({ objectId: ref.objectId, initialSharedVersion: ref.initialSharedVersion, mutable });
}

/** The wallet creates the policy for its account's current wallet generation. */
export function createSpendPolicyTx(
  chain: SpendChain,
  input: { wallet: string; account: SharedRef; keys: Uint8Array[]; weights: number[]; threshold: number; perPaymentMaxMinor: bigint; gas: SponsoredGas },
): Promise<Uint8Array> {
  if (input.perPaymentMaxMinor <= 0n) throw new V2BuildError('a per-payment maximum of zero refuses every payment', 'bad_limit');
  if (input.keys.length === 0 || input.keys.length !== input.weights.length) throw new V2BuildError('as many weights as keys, and at least one', 'bad_members');
  const tx = new Transaction();
  tx.moveCall({
    target: spendFn(chain, 'spend_policy::create_policy'),
    typeArguments: [coreUsdc(chain)],
    arguments: [
      shared(tx, chain.policyRegistry, true),
      shared(tx, input.account, false),
      shared(tx, chain.complianceConfig, false),
      shared(tx, chain.feeConfig, false),
      shared(tx, chain.registry, false),
      tx.pure.vector('vector<u8>', input.keys.map((k) => Array.from(k))),
      tx.pure.vector('u8', input.weights),
      tx.pure.u16(input.threshold),
      tx.pure.u64(u64(input.perPaymentMaxMinor, 'the per-payment maximum')),
    ],
  });
  applySponsoredGas(tx, input.wallet, input.gas);
  return tx.build();
}

/** The wallet changes its policy and its rules, in the order given. */
export function spendRuleTx(
  chain: SpendChain,
  input: { wallet: string; account: SharedRef; policy: SharedRef; ops: RuleOp[]; gas: SponsoredGas },
): Promise<Uint8Array> {
  if (input.ops.length === 0) throw new V2BuildError('nothing to change', 'empty');
  const tx = new Transaction();
  // Inputs only when a command uses them: revoking alone touches neither.
  let policyArg: ReturnType<typeof shared> | null = null;
  let accountArg: ReturnType<typeof shared> | null = null;
  const lazy = {
    get policy() {
      return (policyArg ??= shared(tx, input.policy, true));
    },
    get account() {
      return (accountArg ??= shared(tx, input.account, false));
    },
  };
  const T = coreUsdc(chain);
  const B = balanceType(chain);
  for (const op of input.ops) {
    switch (op.op) {
      case 'add_spender':
        if (op.role !== SPEND_ROLE.STAFF && op.role !== SPEND_ROLE.EXECUTOR) throw new V2BuildError('a spender is staff or the executor', 'bad_role');
        if (op.perPaymentMaxMinor <= 0n) throw new V2BuildError('a per-payment maximum of zero refuses every payment', 'bad_limit');
        tx.moveCall({
          target: spendFn(chain, 'spend_policy::add_spender'),
          arguments: [lazy.policy, lazy.account, tx.pure.address(normalizeSuiAddress(op.spender)), tx.pure.u8(op.role), tx.pure.u64(u64(op.perPaymentMaxMinor, 'the per-payment maximum'))],
        });
        break;
      case 'remove_spender':
        tx.moveCall({ target: spendFn(chain, 'spend_policy::remove_spender'), arguments: [lazy.policy, tx.pure.address(normalizeSuiAddress(op.spender))] });
        break;
      case 'verify_recipient':
        if (op.kind !== RECIPIENT_TAG.WALLET && op.kind !== RECIPIENT_TAG.EXCHANGE) throw new V2BuildError('a recipient is tagged a wallet or an exchange', 'bad_kind');
        tx.moveCall({
          target: spendFn(chain, 'spend_policy::verify_recipient'),
          arguments: [lazy.policy, lazy.account, tx.pure.u32(SUI_DOMAIN), tx.pure.address(normalizeSuiAddress(op.address)), tx.pure.u8(op.kind)],
        });
        break;
      case 'remove_recipient':
        tx.moveCall({ target: spendFn(chain, 'spend_policy::remove_recipient'), arguments: [lazy.policy, tx.pure.u32(SUI_DOMAIN), tx.pure.address(normalizeSuiAddress(op.address))] });
        break;
      case 'verify_beneficiary':
        if (op.commitment.length !== 32) throw new V2BuildError('a beneficiary is named by its 32-byte commitment', 'bad_commitment');
        tx.moveCall({
          target: spendFn(chain, 'spend_policy::verify_beneficiary'),
          arguments: [lazy.policy, lazy.account, tx.pure.vector('u8', Array.from(op.commitment)), tx.pure.address(normalizeSuiAddress(op.partnerDeposit))],
        });
        break;
      case 'remove_beneficiary':
        tx.moveCall({ target: spendFn(chain, 'spend_policy::remove_beneficiary'), arguments: [lazy.policy, tx.pure.vector('u8', Array.from(op.commitment))] });
        break;
      case 'set_limits':
        if (op.perPaymentMaxMinor <= 0n) throw new V2BuildError('a per-payment maximum of zero refuses every payment', 'bad_limit');
        tx.moveCall({
          target: spendFn(chain, 'spend_policy::set_limits'),
          arguments: [lazy.policy, lazy.account, tx.pure.u64(u64(op.perPaymentMaxMinor, 'the per-payment maximum')), tx.pure.u64(u64(op.secondApprovalThresholdMinor, 'the threshold'))],
        });
        break;
      case 'set_running_window':
        tx.moveCall({ target: spendFn(chain, 'spend_policy::set_running_window'), arguments: [lazy.policy, lazy.account, tx.pure.u64(u64(op.windowMs, 'the window'))] });
        break;
      case 'revoke_allowance':
        tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: [B], arguments: [tx.objectRef(op.cap), shared(tx, op.allowance, true)] });
        break;
      case 'issue_allowance': {
        if (op.cap.limitMinor <= 0n) throw new V2BuildError("a rule's cap must be above zero", 'bad_limit');
        if (op.expiresAtMs <= 0n) throw new V2BuildError('a rule needs an expiry', 'bad_expiry');
        if (op.startsAtMs != null && op.startsAtMs >= op.expiresAtMs) throw new V2BuildError('a rule must start before it expires', 'bad_expiry');
        if (op.lifetimeCapMinor != null && op.lifetimeCapMinor <= 0n) throw new V2BuildError('a lifetime cap must be above zero', 'bad_limit');
        if (new TextEncoder().encode(op.name).length > 128) throw new V2BuildError('the allowance name is too long', 'bad_name');
        const [rate] =
          op.cap.period === 'month'
            ? tx.moveCall({ target: '0x2::allowance::monthly_rate_limit', arguments: [tx.pure.u256(op.cap.limitMinor)] })
            : tx.moveCall({ target: '0x2::allowance::periodic_rate_limit', arguments: [tx.pure.u64(MS_PER_DAY), tx.pure.u256(op.cap.limitMinor)] });
        const [someRate] = tx.moveCall({ target: '0x1::option::some', typeArguments: ['0x2::allowance::RateLimit'], arguments: [rate] });
        const [proposal] = tx.moveCall({
          target: '0x2::allowance::propose_for_app',
          typeArguments: [B, splashSpendAppType(chain)],
          arguments: [
            tx.pure.string(op.name),
            tx.pure.address(normalizeSuiAddress(op.spender)),
            tx.pure.option('u256', op.lifetimeCapMinor ?? null),
            tx.pure.option('u64', op.startsAtMs ?? null),
            tx.pure.option('u64', u64(op.expiresAtMs, 'the expiry')),
            someRate,
          ],
        });
        tx.moveCall({ target: spendFn(chain, 'splash_spend::accept'), typeArguments: [T], arguments: [proposal, lazy.policy, lazy.account] });
        break;
      }
    }
  }
  applySponsoredGas(tx, input.wallet, input.gas);
  return tx.build();
}

/** One owner's second approval for one payment, to be paid by `payer`. Sender: that owner. */
export function approvePayoutTx(
  chain: SpendChain,
  input: { owner: string; account: SharedRef; policy: SharedRef; intent: SharedRef; payer: string; maxTotalMinor: bigint; settleByMs: bigint; gas: SponsoredGas },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: spendFn(chain, 'splash_spend::approve_payout'),
    arguments: [
      shared(tx, input.policy, false),
      shared(tx, input.account, false),
      shared(tx, input.intent, false),
      tx.pure.address(normalizeSuiAddress(input.payer)),
      tx.pure.u64(u64(input.maxTotalMinor, 'the approved total')),
      tx.pure.u64(u64(input.settleByMs, 'the settle-by time')),
      tx.object.clock(),
    ],
  });
  applySponsoredGas(tx, input.owner, input.gas);
  return tx.build();
}
