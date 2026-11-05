/**
 * Which operator transactions moved value somewhere they should not have (WS4).
 *
 * Pure: transactions in, a verdict per transaction out. The cron route
 * (app/api/cron/operator-outflows) reads the operator address's recent
 * transactions, the recipient allowlist, Splash's fee recipient and the
 * address registry, and hands them here; the tests hand it synthetic ones.
 * Nothing here touches the network.
 *
 * The rule, for v2. The operator (the KMS key) is an EXECUTOR on a business's
 * spending rule: it pays only through `splash_spend::pay_intent` in OUR
 * splash_spend package, from the business wallet's allowance and never from
 * its own balance, with an owner's approval naming it, and the same
 * transaction consumes the settlement receipt with `audit_anchor::anchor` in
 * OUR core package (the only consumer of a SettleReceipt). That is the
 * approved path. On it, every address that gained value must be one of:
 *
 *   an approved wallet beneficiary (the allowlist);
 *   an address Splash's registry classifies (`address_registry`): a payout
 *   partner's deposit address, for a bank payout, or a business wallet, for
 *   a payment between Splash businesses;
 *   FeeConfig's fee recipient, for Splash's fee leg.
 *
 * Anything else that moved value is flagged:
 *
 *   not_approved_path               value moved and the transaction is not
 *                                   the approved path: a plain transfer, the
 *                                   v1 testnet composed flow, the retired
 *                                   `confirm_with_approval` (v2 core has
 *                                   none), a pay_intent without its anchor,
 *                                   or a look-alike function in someone
 *                                   else's package;
 *   operator_paid_from_own_balance  the approved path, but the operator's own
 *                                   balance paid more than gas: an executor
 *                                   pays from the business's allowance;
 *   recipient_not_approved          the approved path, to an address that is
 *                                   none of the above;
 *   outflow_without_recipient       value left and no address gained it: it
 *                                   went into an object.
 *
 * What is NOT an outflow: gas. The operator pays gas on every anchor, peg
 * update and verification it signs; subtracting the transaction's own gas
 * cost from the operator's SUI change leaves zero for those, and they are
 * reported as `notOutflows`.
 *
 * Deliberately strict: the v1 testnet builders (the gas-funded
 * `settle_payment` and the composed `confirm_payment_intent` flows) also pay
 * out of this address and will be flagged. That is the intended pressure,
 * since those paths bypass the approver, and SECURITY.md (WS4) says so.
 */

export type OperatorMoveCall = { package: string; module: string; function: string };

export type OperatorBalanceChange = {
  /** The address whose balance changed; null when the owner is an object. */
  owner: string | null;
  coinType: string;
  /** Signed, in the coin's minor units. */
  amount: bigint;
};

export type OperatorTransaction = {
  digest: string;
  timestampMs?: number | null;
  moveCalls: OperatorMoveCall[];
  balanceChanges: OperatorBalanceChange[];
  /** Net gas charged to the sender, in MIST. */
  gasMist: bigint;
};

export type OutflowPolicy = {
  operator: string;
  /** Our core package ids, every version that may hold `audit_anchor`. */
  corePackageIds: string[];
  /** Our splash_spend package ids (SPLASH_SPEND_PACKAGE_ID). */
  spendPackageIds: string[];
  /** Approved recipient addresses, any case. */
  approvedRecipients: ReadonlySet<string>;
  /** Addresses Splash's registry classifies (partner deposit addresses,
   *  business wallets), as far as the monitor looked them up. */
  registeredRecipients: ReadonlySet<string>;
  /** FeeConfig's fee recipient; null while the fees are off. */
  feeRecipient: string | null;
};

export type OutflowReason =
  | 'not_approved_path'
  | 'operator_paid_from_own_balance'
  | 'recipient_not_approved'
  | 'outflow_without_recipient';

export type FlaggedOutflow = {
  digest: string;
  timestampMs: number | null;
  reason: OutflowReason;
  /** Addresses that gained value, with what they gained (minor units). */
  recipients: Array<{ address: string; coinType: string; amount: string }>;
  /** What the operator lost, net of gas. */
  operatorOutflow: Array<{ coinType: string; amount: string }>;
};

export type OutflowReport = {
  approved: string[];
  notOutflows: string[];
  flagged: FlaggedOutflow[];
};


/** Sui addresses and package ids compare in canonical 64-hex form. */
export function normalizeSuiAddress(value: string): string {
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  return `0x${hex.padStart(64, '0')}`;
}

function normalizeCoinType(coinType: string): string {
  const [address, ...rest] = coinType.trim().split('::');
  return rest.length ? [normalizeSuiAddress(address), ...rest].join('::') : coinType.trim();
}

/** Native SUI, in the normalized form balance changes are compared in. */
const SUI = normalizeCoinType('0x2::sui::SUI');

export function classifyOperatorTransactions(
  transactions: OperatorTransaction[],
  policy: OutflowPolicy,
): OutflowReport {
  const operator = normalizeSuiAddress(policy.operator);
  const core = new Set(policy.corePackageIds.filter(Boolean).map(normalizeSuiAddress));
  const spend = new Set(policy.spendPackageIds.filter(Boolean).map(normalizeSuiAddress));
  const allowed = new Set(
    [...policy.approvedRecipients, ...policy.registeredRecipients, ...(policy.feeRecipient ? [policy.feeRecipient] : [])].map(normalizeSuiAddress),
  );
  const report: OutflowReport = { approved: [], notOutflows: [], flagged: [] };

  for (const tx of transactions) {
    const operatorNet = new Map<string, bigint>();
    const gained = new Map<string, bigint>();
    // Another address's value that this transaction spent: on the v2 path,
    // the business wallet's, through its allowance.
    let othersSpent = false;
    for (const change of tx.balanceChanges) {
      const coinType = normalizeCoinType(change.coinType);
      const owner = change.owner ? normalizeSuiAddress(change.owner) : null;
      if (owner === operator) {
        operatorNet.set(coinType, (operatorNet.get(coinType) ?? 0n) + change.amount);
      } else if (owner && change.amount > 0n) {
        const key = `${owner}|${coinType}`;
        gained.set(key, (gained.get(key) ?? 0n) + change.amount);
      } else if (change.amount < 0n) {
        othersSpent = true;
      }
    }

    const operatorOutflow: Array<{ coinType: string; amount: string }> = [];
    for (const [coinType, net] of operatorNet) {
      // The operator's SUI change includes the gas it paid; that is a cost,
      // not an outflow.
      const out = -net - (coinType === SUI ? tx.gasMist : 0n);
      if (out > 0n) operatorOutflow.push({ coinType, amount: out.toString() });
    }
    const recipients = [...gained].map(([key, amount]) => {
      const [address, coinType] = key.split('|');
      return { address, coinType, amount: amount.toString() };
    });

    if (operatorOutflow.length === 0 && recipients.length === 0 && !othersSpent) {
      report.notOutflows.push(tx.digest);
      continue;
    }

    const calls = (module: string, fn: string, from: ReadonlySet<string>) =>
      tx.moveCalls.some((call) => call.module === module && call.function === fn && from.has(normalizeSuiAddress(call.package)));
    const approvedPath = calls('splash_spend', 'pay_intent', spend) && calls('audit_anchor', 'anchor', core);

    let reason: OutflowReason | null = null;
    if (!approvedPath) reason = 'not_approved_path';
    else if (operatorOutflow.length > 0) reason = 'operator_paid_from_own_balance';
    else if (recipients.length === 0) reason = 'outflow_without_recipient';
    else if (recipients.some((r) => !allowed.has(r.address))) reason = 'recipient_not_approved';

    if (reason) {
      report.flagged.push({ digest: tx.digest, timestampMs: tx.timestampMs ?? null, reason, recipients, operatorOutflow });
    } else {
      report.approved.push(tx.digest);
    }
  }
  return report;
}
