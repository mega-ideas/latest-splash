import { feeConfigIdFromEnv, getFeeConfig } from '../fees/fee-config.ts';
import { LAUNCH_SCHEDULE, type FeeSchedule } from '../fees/schedule.ts';
import { anchorFeeEnabled } from '../payments/stablecoin-lane.ts';

/**
 * Splash's fee on the Send USDC desk (lib/payments/stablecoin-lane.ts, Price):
 * whether it is charged, the schedule it is charged from, and who receives
 * it. One wallet price (Amendment A1 §2.2, §2.5): the schedule and the fee
 * recipient are the on-chain FeeConfig's, the same ones every settle path
 * reads, never a single address from the environment.
 *
 *   switched off (STABLECOIN_ANCHOR_FEE not "on")  not charged.
 *   on, the FeeConfig has no recipient yet         not charged: fees are off
 *                                                  until the first recipient
 *                                                  change is applied through
 *                                                  the 24-hour path, as on
 *                                                  chain.
 *   on, the FeeConfig names a recipient            charged from its schedule,
 *                                                  paid to that recipient (the
 *                                                  finance multisig).
 *   on, the FeeConfig cannot be read, or the app   charged, with no recipient:
 *   is not on mainnet (the desk's only network)    transfers out of Splash
 *                                                  stay closed rather than
 *                                                  paying a default address.
 */
export type LaneWalletFee = {
  on: boolean;
  recipient: string | null;
  schedule: FeeSchedule;
  /** Why there is no recipient while the fee is on. */
  reason?: string;
};

export async function laneWalletFee(env: NodeJS.ProcessEnv = process.env): Promise<LaneWalletFee> {
  if (!anchorFeeEnabled(env)) return { on: false, recipient: null, schedule: LAUNCH_SCHEDULE };
  if ((env.SUI_NETWORK ?? '').trim().toLowerCase() !== 'mainnet') {
    return { on: true, recipient: null, schedule: LAUNCH_SCHEDULE, reason: 'the app is not on Sui mainnet, so it has no mainnet FeeConfig to pay' };
  }
  const id = feeConfigIdFromEnv(env);
  if (!id.ok) return { on: true, recipient: null, schedule: LAUNCH_SCHEDULE, reason: id.reason };
  try {
    const cfg = await getFeeConfig();
    if (!cfg.feesOn || !cfg.feeRecipient) return { on: false, recipient: null, schedule: cfg.schedule };
    return { on: true, recipient: cfg.feeRecipient, schedule: cfg.schedule };
  } catch (error) {
    return { on: true, recipient: null, schedule: LAUNCH_SCHEDULE, reason: `the FeeConfig cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
}
