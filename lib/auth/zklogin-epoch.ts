/**
 * How long a zkLogin ephemeral key stays valid, and why it is not always one
 * epoch.
 *
 * A zkLogin proof is bound to `maxEpoch`. Once the network passes it the
 * ephemeral key is dead and the user must sign in again — so `maxEpoch` is the
 * hard ceiling on a signing session, chosen at sign-in and unchangeable
 * afterwards.
 *
 * `current + 1` is the obvious choice and is wrong near a boundary. Sui epochs
 * are roughly 24 hours, so a user signing in with twenty minutes left in the
 * current epoch gets a key that expires in twenty minutes: they authenticate,
 * start work, and are logged out mid-task for no reason they can see. `+2`
 * when the remainder is under two hours costs at most one extra epoch of
 * validity and removes that cliff.
 *
 * This is deliberately NOT the application's idle timeout. `maxEpoch` bounds
 * how long the ephemeral KEY can sign; the idle timeout bounds how long an
 * unattended BROWSER stays authenticated, and it is fifteen minutes —
 * independent of this and always far shorter. Conflating them would mean
 * either a browser left open all day stays live, or a signing key dies on a
 * coffee break.
 */

/** Under this much left in the current epoch, take an extra one. */
export const EPOCH_BOUNDARY_GRACE_MS = 2 * 60 * 60 * 1000;

/** Sui mainnet and testnet both run ~24h epochs. Used only as a fallback when
 *  the RPC does not report a duration. */
export const ASSUMED_EPOCH_MS = 24 * 60 * 60 * 1000;

export type EpochInfo = {
  /** The epoch the network is in now. */
  epoch: number;
  /** ms since the unix epoch at which the current one started. */
  epochStartMs: number;
  /** Nominal length of an epoch in ms. */
  epochDurationMs: number;
};

export type MaxEpochDecision = {
  maxEpoch: number;
  /** Epochs added to `current`. Always 1 or 2. */
  span: 1 | 2;
  /** How much of the current epoch was left when the decision was made. */
  remainingMs: number;
  reason: string;
};

/**
 * Choose `maxEpoch` for a sign-in starting now.
 *
 * Pure, so the boundary behaviour is testable without a network: the caller
 * supplies the epoch info and the clock.
 */
export function chooseMaxEpoch(info: EpochInfo, nowMs: number = Date.now()): MaxEpochDecision {
  const duration = info.epochDurationMs > 0 ? info.epochDurationMs : ASSUMED_EPOCH_MS;
  const elapsed = nowMs - info.epochStartMs;

  // A clock skewed backwards, or an epochStart in the future, would otherwise
  // produce a negative remainder and silently take the +2 branch for the wrong
  // reason. Clamp into the epoch instead.
  const clampedElapsed = Math.min(Math.max(elapsed, 0), duration);
  const remainingMs = duration - clampedElapsed;

  if (remainingMs < EPOCH_BOUNDARY_GRACE_MS) {
    return {
      maxEpoch: info.epoch + 2,
      span: 2,
      remainingMs,
      reason: `only ${Math.round(remainingMs / 60000)} minutes remain in epoch ${info.epoch}; one epoch would expire almost immediately`,
    };
  }

  return {
    maxEpoch: info.epoch + 1,
    span: 1,
    remainingMs,
    reason: `epoch ${info.epoch} has ${Math.round(remainingMs / 3600000)} hours left`,
  };
}

/**
 * Read the current epoch from the network.
 *
 * Returns null rather than guessing when the RPC is unreachable: a `maxEpoch`
 * computed from an invented epoch number produces a proof the network will
 * reject, and failing sign-in with a clear message beats issuing a credential
 * that cannot work.
 */
export async function fetchEpochInfo(): Promise<EpochInfo | null> {
  try {
    const { suiClient } = await import('../sui.ts');
    const client = suiClient as unknown as {
      core?: {
        getCurrentSystemState?: () => Promise<Record<string, unknown>>;
        getLatestSuiSystemState?: () => Promise<Record<string, unknown>>;
      };
      getLatestSuiSystemState?: () => Promise<Record<string, unknown>>;
    };

    // gRPC names this getCurrentSystemState and wraps the payload in
    // a systemState envelope; the retired JSON-RPC named it
    // getLatestSuiSystemState and
    // returned the fields flat. Accept either, so pointing SUI_RPC_URL at a
    // different client does not silently disable sign-in.
    const candidates = [
      [client.core?.getCurrentSystemState, client.core],
      [client.core?.getLatestSuiSystemState, client.core],
      [client.getLatestSuiSystemState, client],
    ] as const;
    const found = candidates.find(([fn]) => typeof fn === 'function');
    if (!found) return null;
    const [read, self] = found;

    const raw = await (read as () => Promise<Record<string, unknown>>).call(self);
    const state = ((raw as Record<string, unknown>).systemState ?? raw) as Record<string, unknown>;
    const params = (state.parameters ?? {}) as Record<string, unknown>;

    // Every gRPC scalar arrives as a string, so Number() the reads rather than
    // trusting the type.
    const epoch = Number(state.epoch ?? state.epochId);
    const epochStartMs = Number(state.epochStartTimestampMs ?? state.epoch_start_timestamp_ms);
    const epochDurationMs = Number(
      params.epochDurationMs ?? state.epochDurationMs ?? state.epoch_duration_ms ?? ASSUMED_EPOCH_MS,
    );
    if (!Number.isFinite(epoch) || !Number.isFinite(epochStartMs)) return null;
    return {
      epoch,
      epochStartMs,
      epochDurationMs: Number.isFinite(epochDurationMs) && epochDurationMs > 0 ? epochDurationMs : ASSUMED_EPOCH_MS,
    };
  } catch {
    return null;
  }
}
