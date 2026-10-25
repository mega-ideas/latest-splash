/**
 * The live wiring for the §4.7 wallet-recipient routes: the database, the
 * server's screening provider, email for the ownership-proof link, the
 * signature check, and Circle's attestation service and the destination
 * chains' RPCs for a cross-chain receipt. The org always comes from the
 * caller, who took it from the session; nothing here reads it from a request.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, type AuthorityContext } from '@/lib/auth/authority';
import { kytProviderFromEnv } from '@/lib/compliance/kyt';
import { canAskForWithdrawal } from '@/lib/payouts/withdrawal-rules';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { requireSessionAccount } from '@/lib/server/session-account';
import { solanaTokenAccountReaderFromEnv } from '@/lib/server/solana-token-accounts';
import { splashAddressSourceFromEnv, splashCrossChainAddresses } from '@/lib/server/splash-addresses';
import type { ProofLinkDeps, ProofSubmitDeps, WalletRecipientDeps } from '@/lib/server/wallet-recipients';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function recipientsDb(): Promise<DrizzleDb | null> {
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('@/lib/db/client');
  return getDb() as unknown as DrizzleDb;
}

/** A signed-in owner or staff member of the business, with its org from the SESSION. */
export async function recipientRoute(request: Request): Promise<{ ok: true; orgId: string; authority: AuthorityContext; email: string; db: DrizzleDb } | { ok: false; response: Response }> {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return { ok: false, response: auth.response };
  const account = await requireSessionAccount(auth.session);
  if (account.response) return { ok: false, response: account.response };
  let authority: AuthorityContext;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE }) };
  }
  if (authority.orgId !== account.account.orgId) return { ok: false, response: NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE }) };
  if (!canAskForWithdrawal(authority.role)) {
    return { ok: false, response: NextResponse.json({ error: 'Only an owner or a staff member can manage the business’s recipients.' }, { status: 403, headers: NO_STORE }) };
  }
  const db = await recipientsDb();
  if (!db) return { ok: false, response: NextResponse.json({ error: 'Wallet recipients need the database.' }, { status: 503, headers: NO_STORE }) };
  return { ok: true, orgId: account.account.orgId, authority, email: auth.session.email, db };
}

export function walletRecipientDeps(db: DrizzleDb, orgId: string, env: NodeJS.ProcessEnv = process.env): WalletRecipientDeps {
  return {
    db,
    orgId,
    now: () => new Date(),
    kyt: kytProviderFromEnv(env),
    // Splash's own addresses, read live (FeeConfig's recipient can change).
    splashAddresses: splashAddressSourceFromEnv(env),
    // Read when needed: an unreadable value refuses the recipient.
    splashCrossChain: () => splashCrossChainAddresses(env, { requireConfigured: true }),
    // Solana token accounts are checked on chain; with no RPC, none is saved.
    solana: solanaTokenAccountReaderFromEnv(env),
  };
}

export async function proofLinkDeps(db: DrizzleDb, orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<ProofLinkDeps> {
  const { getEnv } = await import('@/lib/env');
  const { resolveEmailTransport } = await import('@/lib/auth/email-transport');
  return {
    ...walletRecipientDeps(db, orgId, env),
    appUrl: getEnv().NEXT_PUBLIC_APP_URL,
    async sendEmail(message) {
      await resolveEmailTransport(env).sendMessage(message);
    },
  };
}

/** The supplier's Sui personal-message signature, any scheme Sui verifies (zkLogin through the chain). */
export function proofSubmitDeps(db: DrizzleDb): ProofSubmitDeps {
  return {
    db,
    now: () => new Date(),
    async verifySignature(message, signature, address) {
      const [{ isValidPersonalMessageSignature }, { parseSerializedSignature }, { suiClient }] = await Promise.all([
        import('@mysten/sui/verify'),
        import('@mysten/sui/cryptography'),
        import('@/lib/sui'),
      ]);
      // Something that is not a signature is a bad signature; an error after
      // that point (zkLogin and passkey checks read the chain) is the check
      // failing, which the caller tells apart and does not hold against the link.
      try {
        parseSerializedSignature(signature);
      } catch {
        return false;
      }
      return isValidPersonalMessageSignature(message, signature, { address, client: suiClient });
    },
  };
}
