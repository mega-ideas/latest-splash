import {
  buildTransferBytes,
  describeBuildError,
  digestOf,
  executeTransfer,
  laneClient,
  readTransfer,
  senderOf,
  simulateTransfer,
} from '@/lib/server/stablecoin-chain';
import type { SendDeps } from '@/lib/server/stablecoin-send';
import { consumeStepUp, releaseStepUp } from '@/lib/server/step-up';

/**
 * The real dependencies for a wallet transfer: Postgres for the ledger, the
 * lane's own fullnode clients for the chain. Null without a database — the
 * allowance is a ledger, and a ledger that disappears on restart is not one.
 */
export async function liveSendDeps(): Promise<SendDeps | null> {
  if (!process.env.DATABASE_URL) return null;
  const [{ getDb }, { readRecipient }] = await Promise.all([
    import('@/lib/db/client'),
    import('@/lib/server/recipients-store'),
  ]);
  const db = getDb();
  return {
    db,
    approval: {
      consume: ({ orgId, subjectId, subject }) => consumeStepUp(db, { orgId, purpose: 'STABLECOIN_TRANSFER', subjectId, subject }),
      release: ({ orgId, subjectId }) => releaseStepUp(db, { orgId, purpose: 'STABLECOIN_TRANSFER', subjectId }),
    },
    readRecipient,
    feeAddress: () => process.env.SPLASH_FEE_ADDRESS_MAINNET,
    chain: {
      build: (input) => buildTransferBytes(laneClient(), input),
      simulate: (bytes) => simulateTransfer(laneClient(), bytes),
      execute: (bytes, signature) => executeTransfer(laneClient(), bytes, signature),
      read: (digest) => readTransfer(laneClient(), digest),
      digestOf,
      senderOf,
      describeBuildError,
    },
  };
}

export const NO_LEDGER_RESPONSE = {
  error: 'Wallet transfers need the database: the 30-day allowance is a ledger. Set DATABASE_URL.',
  code: 'ledger_unavailable',
};
