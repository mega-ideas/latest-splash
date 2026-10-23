/**
 * Which operator transactions moved value somewhere they should not have (WS4).
 *
 * Pure: transactions in, a verdict per transaction out. The cron route
 * (app/api/cron/operator-outflows) reads the operator address's recent
 * transactions and the recipient allowlist and hands both here; the tests
 * hand it synthetic ones. Nothing here touches the network.
 *
 * The rule. Every outflow from the operator address must be a call to
 * `payment_intent::confirm_with_approval` in one of OUR core packages, and
 * every address that gained value from it must be an approved recipient.
 * That is the one path where a second human (the account's approver) has
 * already signed off on chain, so it is the one path a stolen signer cannot
 * use on its own. Anything else that moved value out is flagged:
 *
 *   not_confirm_with_approval   value left and no approved-path call was made
 *                               (a plain transfer, `confirm_payment_intent`,
 *                               or a look-alike function in someone else's
 *                               package);
 *   recipient_not_approved      the approved path, to an address that is not
 *                               on the allowlist;
 *   outflow_without_recipient   value left the operator and no address gained
 *                               it — it went into an object.
 *
 * What is NOT an outflow: gas. The operator pays gas on every anchor, peg
 * update and verification it signs; subtracting the transaction's own gas
 * cost from the operator's SUI change leaves zero for those, and they are
 * reported as `notOutflows`.
 *
 * Deliberately strict, and stricter than main's settlement paths today: the
 * gas-funded `settle_payment` and the composed `confirm_payment_intent` flows
 * also pay out of this address and will be flagged. That is the intended
 * pressure — those paths bypass the approver — and SECURITY.md (WS4) says so.
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
  /** Our core package ids, every version that may hold `payment_intent`. */
  corePackageIds: string[];
  /** Approved recipient addresses, any case. */
  approvedRecipients: ReadonlySet<string>;
};

export type OutflowReason = 'not_confirm_with_approval' | 'recipient_not_approved' | 'outflow_without_recipient';

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
  const packages = new Set(policy.corePackageIds.filter(Boolean).map(normalizeSuiAddress));
  const allowed = new Set([...policy.approvedRecipients].map(normalizeSuiAddress));
  const report: OutflowReport = { approved: [], notOutflows: [], flagged: [] };

  for (const tx of transactions) {
    const operatorNet = new Map<string, bigint>();
    const gained = new Map<string, bigint>();
    for (const change of tx.balanceChanges) {
      const coinType = normalizeCoinType(change.coinType);
      const owner = change.owner ? normalizeSuiAddress(change.owner) : null;
      if (owner === operator) {
        operatorNet.set(coinType, (operatorNet.get(coinType) ?? 0n) + change.amount);
      } else if (owner && change.amount > 0n) {
        const key = `${owner}|${coinType}`;
        gained.set(key, (gained.get(key) ?? 0n) + change.amount);
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

    if (operatorOutflow.length === 0 && recipients.length === 0) {
      report.notOutflows.push(tx.digest);
      continue;
    }

    const approvedPath = tx.moveCalls.some(
      (call) =>
        call.module === 'payment_intent' &&
        call.function === 'confirm_with_approval' &&
        packages.has(normalizeSuiAddress(call.package)),
    );

    let reason: OutflowReason | null = null;
    if (!approvedPath) reason = 'not_confirm_with_approval';
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
