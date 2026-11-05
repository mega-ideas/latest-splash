/**
 * Operator custody alerts (WS4).
 *
 * Three things page someone: the hot balance is above its ceiling (sweep the
 * excess to cold), the hot balance cannot cover a payout (top it up), and a
 * value-moving transaction left the operator address that was not the v2
 * approved path (treat as a compromise until shown otherwise). That path is
 * `splash_spend::pay_intent` in our splash_spend package, paid from the
 * business wallet's allowance with the owners' approval naming the operator,
 * its receipt consumed by `audit_anchor::anchor` in our core package, to an
 * allowlisted beneficiary, a registered partner deposit address or business
 * wallet, or FeeConfig's fee recipient (lib/server/operator-outflows.ts). The
 * legacy `confirm_with_approval` was removed from v2 core and approves
 * nothing.
 *
 * Delivery is the server log, always, plus OPERATOR_ALERT_WEBHOOK_URL when it
 * is set — the same shape as the Seal health alert. A failed delivery is
 * logged and swallowed: an alert must never be the reason a check fails open
 * or a payout that should have been refused goes through.
 *
 * Amounts travel as decimal strings of minor units (bigint does not survive
 * JSON). No alert carries a key, a credential, or a beneficiary's name.
 */

export type OperatorAlert =
  | {
      kind: 'operator_above_ceiling';
      severity: 'warning';
      operator: string;
      coinType: string;
      balanceMinor: string;
      ceilingMinor: string;
      excessMinor: string;
    }
  | {
      kind: 'operator_top_up_needed';
      severity: 'critical';
      operator: string;
      coinType: string;
      balanceMinor: string;
      requiredMinor: string;
      shortfallMinor: string;
    }
  | {
      kind: 'operator_unapproved_outflow';
      severity: 'critical';
      operator: string;
      digest: string;
      reason: string;
      detail: unknown;
    }
  | {
      /** A configured governance id (SPLASH_UPGRADE_WRAPPER_ID or
       *  SPLASH_COMPLIANCE_CONFIG_ID) does not resolve on chain to the
       *  canonical object of the canonical type, or the object could not be
       *  read in full (lib/server/governance-alert-monitor.ts). Owners are NOT
       *  being told about governance changes until a person fixes it. */
      kind: 'governance_config_mismatch';
      severity: 'critical';
      objectId: string;
      reason: string;
    };

export type OperatorAlertSink = (alert: OperatorAlert) => Promise<void>;

export const sendOperatorAlert: OperatorAlertSink = async (alert) => {
  const line = `[operator-custody] ${alert.severity.toUpperCase()} ${alert.kind}`;
  if (alert.severity === 'critical') console.error(line, alert);
  else console.warn(line, alert);

  const webhook = process.env.OPERATOR_ALERT_WEBHOOK_URL?.trim();
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'splash-operator-custody', ...alert }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.error('[operator-custody] alert delivery failed:', error instanceof Error ? error.message : error);
  }
};
