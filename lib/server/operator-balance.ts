/**
 * The hot-balance check that runs before every operator-funded payout (WS4).
 *
 * The operator address is a hot wallet: whatever sits on it is exposed to
 * whoever can make the server sign. So it should hold enough to pay what is
 * about to be paid, and not much more.
 *
 *   - Above OPERATOR_HOT_BALANCE_CEILING_MICRO: alert, with the excess, so it
 *     is swept to the cold multisig. The payout is NOT blocked — refusing a
 *     legitimate payment because the wallet is too full would punish the
 *     customer for an operations backlog.
 *   - Below the payout amount: refuse with a 'top-up needed' state, before
 *     anything is signed. Never a partial payment. A partly-paid beneficiary
 *     is a reconciliation case with a real person waiting on the rest; a
 *     refused one is a retry after the top-up.
 *
 * The ceiling is denominated in micro-USDC (the coin named by USDC_TYPE), the
 * hot asset that matters. The payout check reads the coin the payout is made
 * in, which on main today is SUI for the gas-funded settlement paths. Both
 * are bigint minor units; nothing here is a float.
 *
 * This is a pre-flight, not a lock. Two payouts racing for the last coins can
 * both pass it; the chain then rejects whichever cannot be funded, and that
 * transaction pays nothing. The check exists so the ordinary case fails
 * before signing with a reason an operator can act on.
 */
import { sendOperatorAlert, type OperatorAlertSink } from './operator-alerts.ts';

export type BalanceReader = (owner: string, coinType: string) => Promise<bigint>;

export class OperatorTopUpNeededError extends Error {
  readonly code = 'operator_top_up_needed';
  readonly state = 'top-up-needed';
  readonly balance: bigint;
  readonly required: bigint;
  readonly shortfall: bigint;
  readonly coinType: string;

  constructor(input: { balance: bigint; required: bigint; coinType: string }) {
    const shortfall = input.required - input.balance;
    super(
      `Operator top-up needed: the hot wallet holds ${input.balance} and this payout needs ${input.required} ` +
        `(minor units of ${input.coinType}; short by ${shortfall}). Nothing was paid. Top up the operator ` +
        'address from the cold multisig and retry.',
    );
    this.name = 'OperatorTopUpNeededError';
    this.balance = input.balance;
    this.required = input.required;
    this.shortfall = shortfall;
    this.coinType = input.coinType;
  }
}

export type OperatorPayCheckOptions = {
  /** The coin the payout is made in. */
  coinType: string;
  /** The operator address. Defaults to the operator signer's address. */
  owner?: string;
  readBalance?: BalanceReader;
  /** Defaults to OPERATOR_HOT_BALANCE_CEILING_MICRO; null disables the check. */
  ceilingMicro?: bigint | null;
  /** The coin the ceiling is measured in. Defaults to USDC_TYPE. */
  ceilingCoinType?: string | null;
  alert?: OperatorAlertSink;
};

export type OperatorHotBalance = {
  owner: string;
  coinType: string;
  balance: bigint;
  aboveCeiling: boolean;
};

export async function assertOperatorCanPay(
  amount: bigint,
  options: OperatorPayCheckOptions,
): Promise<OperatorHotBalance> {
  if (typeof amount !== 'bigint') throw new TypeError('assertOperatorCanPay takes the payout as bigint minor units');
  if (amount < 0n) throw new RangeError('a payout amount cannot be negative');

  const read = options.readBalance ?? readSuiBalance;
  const alert = options.alert ?? sendOperatorAlert;
  const owner = options.owner ?? (await operatorAddress());
  const ceiling = options.ceilingMicro === undefined ? configuredCeilingMicro() : options.ceilingMicro;
  const ceilingCoin = options.ceilingCoinType === undefined ? configuredCeilingCoin() : options.ceilingCoinType;

  const balance = await read(owner, options.coinType);

  let aboveCeiling = false;
  if (ceiling !== null && ceilingCoin) {
    const ceilingBalance = ceilingCoin === options.coinType ? balance : await read(owner, ceilingCoin);
    if (ceilingBalance > ceiling) {
      aboveCeiling = true;
      await alert({
        kind: 'operator_above_ceiling',
        severity: 'warning',
        operator: owner,
        coinType: ceilingCoin,
        balanceMinor: ceilingBalance.toString(),
        ceilingMinor: ceiling.toString(),
        excessMinor: (ceilingBalance - ceiling).toString(),
      });
    }
  }

  if (balance < amount) {
    const error = new OperatorTopUpNeededError({ balance, required: amount, coinType: options.coinType });
    await alert({
      kind: 'operator_top_up_needed',
      severity: 'critical',
      operator: owner,
      coinType: options.coinType,
      balanceMinor: balance.toString(),
      requiredMinor: amount.toString(),
      shortfallMinor: error.shortfall.toString(),
    });
    throw error;
  }

  return { owner, coinType: options.coinType, balance, aboveCeiling };
}

function configuredCeilingMicro(): bigint | null {
  const raw = process.env.OPERATOR_HOT_BALANCE_CEILING_MICRO?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error('OPERATOR_HOT_BALANCE_CEILING_MICRO must be a whole number of micro-USDC');
  return BigInt(raw);
}

function configuredCeilingCoin(): string | null {
  const usdc = process.env.USDC_TYPE?.trim();
  // The development stand-in is native SUI (9 decimals); a micro-USDC ceiling
  // compared against MIST would be off by a thousand, so it is skipped.
  if (!usdc || usdc === '0x2::sui::SUI') return null;
  return usdc;
}

async function operatorAddress(): Promise<string> {
  const { getOperatorSigner } = await import('./operator-signer.ts');
  const signer = await getOperatorSigner();
  if (!signer) throw new Error('No operator signer is configured, so there is no hot balance to check.');
  return signer.toSuiAddress();
}

const readSuiBalance: BalanceReader = async (owner, coinType) => {
  const { suiClient } = await import('../sui.ts');
  const { balance } = await suiClient.core.getBalance({ owner, coinType });
  return BigInt(balance.balance);
};
