/**
 * Real composed-PTB entry points.
 *
 * Kept as a small compatibility module for callers that historically imported
 * `lib/server/ptb`. The implementation lives beside the operator signer in
 * `sui-settlement.ts`; no fabricated digests are returned from this module.
 */
// WS3: the operator no longer opens and pays its own intents, so the two
// server-pays entry points are gone. A payout Splash funds settles through
// confirmServiceOrderOnSui, after two members of the client's account sign.
export {
  anchorAuditHashOnSui,
  confirmServiceOrderOnSui,
  type ComposedAction,
  type ComposedSettlementResult,
} from '@/lib/server/sui-settlement';
