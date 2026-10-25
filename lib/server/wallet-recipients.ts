/**
 * Wallet recipients for ONE business (v2 §4.7, D5): saving the three kinds,
 * the self-custody ownership proof, the owners' approval, and the gate a
 * payment passes.
 *
 *   Saving       the kind's fields are checked (lib/recipients/
 *                wallet-recipients.ts); an address Splash controls
 *                (lib/server/splash-addresses.ts) or one of the business's
 *                own (its wallet, its members' passkey and zkLogin
 *                addresses) is refused; a Solana mint recipient is checked
 *                on chain to be a USDC token account; the address is
 *                screened for this business by the server's provider
 *                (lib/server/kyt-screenings.ts) before anything is stored,
 *                and a BLOCK is never saved. One saved recipient per
 *                address: a second at the same address is refused (under a
 *                per-address lock, so two saves cannot race past it), so
 *                which supplier a payment goes to is never guessed.
 *   Approval     maker-checker: a recipient a staff member saved is paid or
 *                tagged only once an owner approves it; an owner's own save
 *                is approved by that owner. Who saved, approved and proved
 *                it is kept on the recipient and named in the controls
 *                evidence.
 *   The proof    a SELF_CUSTODY recipient is paid only once the supplier
 *                proves it holds the wallet. Splash makes a link (a random
 *                token, kept only as its SHA-256) to a fixed message naming
 *                the address, the supplier, the paying business, a
 *                single-use nonce and the expiry; the supplier signs it as a
 *                Sui personal message with the wallet. The link is emailed
 *                to the supplier; only an owner is shown it. The challenge
 *                is used up BEFORE the signature is checked, so a link is
 *                good for one try. A good signature is recorded only if no
 *                withdrawal happened since the link was made (the
 *                recipient's ownership epoch), all in one transaction, so an
 *                owner's withdrawal is never undone by a check that finishes
 *                after it. The proof row in `wallet_ownership_proofs` is
 *                also the off-chain gate for the WALLET tag on a SpendPolicy
 *                (lib/server/ownership-proofs.ts).
 *   The gate     `walletDeliveryGate`: a wallet payment (kind WALLET) goes
 *                only to this business's approved SELF_CUSTODY recipient,
 *                with the supplier's details, whose proof holds; an
 *                exchange payment (kind EXCHANGE) only to its approved
 *                EXCHANGE recipient, and is signed only once the exchange
 *                confirmed the account: a Travel Rule message to that
 *                address at that exchange was approved by the counterparty
 *                (not merely submitted, or awaiting it). Until then the
 *                first payment may be opened, so its message can be sent,
 *                but not signed. Never an address Splash controls or one of
 *                the business's own. Checked when a payment is opened and
 *                again before every signature
 *                (lib/server/payment-compliance-gate.ts).
 *
 * Every read and write takes the business's org from the caller, who took it
 * from the session. The proof link is the one cross-tenant read, by its
 * token, which is the capability: it was handed to one supplier.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  memberships,
  organizations,
  passkeyCredentials,
  recipientOwnershipChallenges,
  suppliers,
  travelRuleTransfers,
  walletDepositSync,
  walletIdentities,
  walletOwnershipProofs,
  walletSigningRequests,
  walletSigningSigners,
  walletSingleSignerConsents,
  withdrawals,
} from '../db/schema.ts';
import type { KytProvider } from '../compliance/kyt.ts';
import {
  CROSS_CHAIN_CHAINS,
  MOVE_KIND,
  moveDeliveryOf,
  OWNERSHIP_PROOF_TTL_MS,
  ownershipProofMessage,
  parseWalletRecipient,
  RecipientInputError,
  screeningSubjectOf,
  type DeliveryKind,
  type WalletRecipientInput,
} from '../recipients/wallet-recipients.ts';
import { recordOwnershipProof, revokeOwnershipProof } from './ownership-proofs.ts';
import * as repo from './repository/recipients.ts';
import { screenRecipient } from './kyt-screenings.ts';
import { isProductionRuntime } from './runtime-mode.ts';
import type { SolanaTokenAccountReader } from './solana-token-accounts.ts';
import { splashAddressSourceFromEnv, splashCrossChainAddresses, type SplashAddressSource } from './splash-addresses.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

export type WalletRecipientDeps = {
  db: DrizzleDb;
  orgId: string;
  now: () => Date;
  /** The server's screening provider. With none, verdicts are null and the recipient is saved but not payable. */
  kyt: KytProvider;
  /** Splash's own Sui addresses. Default: this server's configuration, read live. */
  splashAddresses?: SplashAddressSource;
  /** Splash's own addresses on other chains. Default: FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON. */
  splashCrossChain?: string[];
  /** Asks Solana whether an address is a USDC token account. Without one, no Solana recipient is saved. */
  solana?: SolanaTokenAccountReader | null;
};

type SupplierRow = typeof suppliers.$inferSelect;
type GateRefusal = { status: number; code: string; error: string };

/** What a client sees of one wallet recipient. Its own business's data only. */
export function walletRecipientView(row: repo.RecipientRow, raw?: Pick<SupplierRow, 'createdBy' | 'approvedBy' | 'approvedAt' | 'destinationTokenOwner'> | null, exchangeConfirmed = false) {
  const d = row.delivery ?? { deliveryKind: 'BANK' as const };
  const t = row.travelRule ?? {};
  const move = moveDeliveryOf({ ...d, walletAddress: row.walletAddress ?? null });
  return {
    id: row.id,
    name: row.name,
    deliveryKind: d.deliveryKind,
    supplier: {
      legalName: t.legalName ?? null,
      registrationNumber: t.registrationNumber ?? null,
      country: t.addressCountry ?? row.country,
      addressLine1: t.addressLine1 ?? null,
      addressCity: t.addressCity ?? null,
      addressPostalCode: t.addressPostalCode ?? null,
      email: row.orgEmail ?? null,
    },
    exchange: d.deliveryKind === 'EXCHANGE' ? { id: d.exchangeId ?? null, network: d.depositNetwork ?? null, depositAddress: row.walletAddress ?? null, confirmed: exchangeConfirmed } : null,
    wallet: d.deliveryKind === 'SELF_CUSTODY' ? { address: row.walletAddress ?? null, label: row.walletProvider ?? null, ownership: d.ownershipStatus ?? 'unproven' } : null,
    crossChain:
      d.deliveryKind === 'CROSS_CHAIN'
        ? {
            chain: d.destinationChain ?? null,
            domain: d.destinationDomain ?? null,
            address: d.destinationAddress ?? null,
            mintRecipient: d.mintRecipient ?? null,
            tokenAccountOwner: raw?.destinationTokenOwner ?? null,
            asset: 'USDC' as const,
            route: 'CCTP_V2' as const,
          }
        : null,
    /** Who saved it, and the owner who approved it for payment (null: waiting for an owner). */
    controls: { createdBy: raw?.createdBy ?? null, approvedBy: raw?.approvedBy ?? null, approvedAt: raw?.approvedAt?.toISOString() ?? null },
    /** What the Move side is given: the intent kind and, for CCTP, the domain and mint recipient. Owners only for cross-chain. */
    move,
    screeningVerdict: row.screeningVerdict ?? null,
    createdAt: row.createdAt,
  };
}

async function savedAtSui(db: DrizzleDb, orgId: string, address: string): Promise<SupplierRow[]> {
  return db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.orgId, orgId), eq(suppliers.walletAddress, normalizeSuiAddress(address)), inArray(suppliers.deliveryKind, ['EXCHANGE', 'SELF_CUSTODY'])));
}

// ─── Addresses that are never a supplier ────────────────────────────────────

/** Null when `address` is not Splash's; a refusal when it is, or when the list cannot be read. */
async function splashRefusal(source: SplashAddressSource | undefined, address: string): Promise<GateRefusal | null> {
  let listed: string[];
  try {
    listed = await (source ?? splashAddressSourceFromEnv())();
  } catch {
    return { status: 503, code: 'splash_addresses_unreadable', error: "Splash's own addresses (its fee recipient among them) could not be read, so this recipient cannot be checked against them." };
  }
  const set = new Set(listed.map((a) => normalizeSuiAddress(a)));
  if (set.has(normalizeSuiAddress(address))) {
    return { status: 409, code: 'splash_controlled_address', error: 'That address is one Splash controls. Splash never receives client money, so it cannot be a recipient.' };
  }
  return null;
}

/**
 * Whether `address` is the business's own: its wallet (the deposit
 * watcher's, a withdrawal's, a signing request's sender), or a member's
 * passkey or zkLogin address (a signer, a consent, a credential, an
 * identity). A member's own wallet saved as a "supplier" is how an insider
 * would pay themselves.
 */
export async function isOwnAddress(db: DrizzleDb, orgId: string, address: string): Promise<boolean> {
  const a = normalizeSuiAddress(address);
  const hit = async (q: Promise<unknown[]>) => (await q).length > 0;
  const checks = [
    () => hit(db.select({ x: walletDepositSync.orgId }).from(walletDepositSync).where(and(eq(walletDepositSync.orgId, orgId), eq(walletDepositSync.walletAddress, a))).limit(1)),
    () => hit(db.select({ x: withdrawals.id }).from(withdrawals).where(and(eq(withdrawals.orgId, orgId), eq(withdrawals.walletAddress, a))).limit(1)),
    () => hit(db.select({ x: walletSigningRequests.id }).from(walletSigningRequests).where(and(eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.senderAddress, a))).limit(1)),
    () => hit(db.select({ x: walletSigningSigners.requestId }).from(walletSigningSigners).where(and(eq(walletSigningSigners.orgId, orgId), eq(walletSigningSigners.address, a))).limit(1)),
    () => hit(db.select({ x: walletSingleSignerConsents.userId }).from(walletSingleSignerConsents).where(and(eq(walletSingleSignerConsents.orgId, orgId), eq(walletSingleSignerConsents.walletAddress, a))).limit(1)),
    () => hit(db.select({ x: walletIdentities.id }).from(walletIdentities).where(and(eq(walletIdentities.orgId, orgId), eq(walletIdentities.suiAddress, a))).limit(1)),
    () =>
      hit(
        db
          .select({ x: passkeyCredentials.id })
          .from(passkeyCredentials)
          .innerJoin(memberships, eq(memberships.userId, passkeyCredentials.userId))
          .where(and(eq(memberships.orgId, orgId), eq(passkeyCredentials.suiAddress, a)))
          .limit(1),
      ),
  ];
  for (const check of checks) if (await check()) return true;
  return false;
}

const OWN_ADDRESS: GateRefusal = {
  status: 409,
  code: 'own_address',
  error: "That address is this business's own wallet, or one of its members' wallets. A supplier is paid at an address the supplier holds.",
};

/** The supplier's business details a wallet is paid only with (D5b): registered name, registration number, address, city. */
function hasSupplierDetails(r: Pick<SupplierRow, 'legalName' | 'registrationNumber' | 'addressLine1' | 'addressCity'>): boolean {
  return [r.legalName, r.registrationNumber, r.addressLine1, r.addressCity].every((v) => typeof v === 'string' && v.trim().length > 0);
}

const DETAILS_MISSING: GateRefusal = {
  status: 409,
  code: 'supplier_details_missing',
  error: "The supplier's registered name, registration number and address are not on file for this recipient. Save it again with them.",
};

// ─── Saving ─────────────────────────────────────────────────────────────────

/**
 * The older body (`payoutMethod: 'WALLET'`, `walletAddress`,
 * `walletProvider`) as a SELF_CUSTODY save: the same checks as every wallet
 * recipient, the supplier's details included.
 */
export function legacyWalletBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, deliveryKind: 'SELF_CUSTODY', address: body.address ?? body.walletAddress, walletLabel: body.walletLabel ?? body.walletProvider ?? 'OTHER' };
}

/** Save one wallet recipient: checked, screened, and stored only if not blocked. */
export async function createWalletRecipient(
  deps: WalletRecipientDeps,
  input: { body: Record<string, unknown>; requestedBy: string; requestedRole?: string },
): Promise<
  | {
      ok: true;
      recipient: ReturnType<typeof walletRecipientView>;
      screening: { verdict: string | null; provider: string; reference: string | null };
      /** Solana only: the screening of the wallet that owns the token account. */
      ownerScreening?: { address: string; verdict: string | null; provider: string; reference: string | null };
    }
  | Refusal
> {
  let parsed: WalletRecipientInput;
  try {
    parsed = parseWalletRecipient(input.body);
  } catch (error) {
    if (error instanceof RecipientInputError) return refuse(400, error.code, error.message);
    throw error;
  }

  let tokenOwner: string | null = null;
  let lockKey: string;
  if (parsed.kind === 'CROSS_CHAIN') {
    const theirs = new Set((deps.splashCrossChain ?? splashCrossChainAddresses()).map((a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a)));
    if (theirs.has(parsed.address)) {
      return refuse(409, 'splash_controlled_address', 'That address is one Splash controls. Splash never receives client money, so it cannot be a recipient.');
    }
    const [dupe] = await deps.db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.orgId, deps.orgId), eq(suppliers.deliveryKind, 'CROSS_CHAIN'), eq(suppliers.destinationChain, parsed.chain), eq(suppliers.destinationAddress, parsed.address)))
      .limit(1);
    if (dupe) return refuse(409, 'recipient_exists', 'A recipient with this address on this chain is already saved.');
    if (parsed.chain === 'SOLANA') {
      if (!deps.solana) return refuse(503, 'solana_check_not_configured', 'Splash cannot check Solana token accounts here, so a Solana recipient cannot be saved.');
      const checked = await deps.solana.check(parsed.address);
      if (!checked.ok) {
        const status = checked.code === 'solana_not_usdc_token_account' ? 400 : 503;
        return refuse(status, checked.code, checked.code === 'solana_not_usdc_token_account' ? `${checked.reason} CCTP mints to the supplier's USDC token account (its associated token account).` : checked.reason);
      }
      tokenOwner = checked.tokenOwner;
    }
    lockKey = `${deps.orgId}:${parsed.chain}:${parsed.address}`;
  } else {
    const address = parsed.kind === 'EXCHANGE' ? parsed.depositAddress : parsed.address;
    const splash = await splashRefusal(deps.splashAddresses, address);
    if (splash) return refuse(splash.status, splash.code, splash.error);
    if (await isOwnAddress(deps.db, deps.orgId, address)) return refuse(OWN_ADDRESS.status, OWN_ADDRESS.code, OWN_ADDRESS.error);
    if ((await savedAtSui(deps.db, deps.orgId, address)).length > 0) {
      return refuse(409, 'recipient_exists', 'A recipient with this address is already saved. One address is one recipient.');
    }
    lockKey = `${deps.orgId}:SUI:${normalizeSuiAddress(address)}`;
  }

  // Screened BEFORE saving: a blocked address never enters the list.
  const subject = screeningSubjectOf(parsed);
  const screened = await screenRecipient({ db: deps.db, orgId: deps.orgId, kyt: deps.kyt, now: deps.now }, { kind: subject.kind, chain: subject.chain, address: subject.address, requestedBy: input.requestedBy });
  if (!screened.ok) return screened;
  // On Solana the wallet that owns the token account is screened too:
  // sanctions and KYT lists name wallets, not the token accounts they own.
  let ownerScreening: Awaited<ReturnType<typeof screenRecipient>> | null = null;
  if (tokenOwner) {
    ownerScreening = await screenRecipient({ db: deps.db, orgId: deps.orgId, kyt: deps.kyt, now: deps.now }, { kind: subject.kind, chain: subject.chain, address: tokenOwner, requestedBy: input.requestedBy });
    if (!ownerScreening.ok) return refuse(409, 'recipient_not_screened', 'The wallet that owns this token account could not be screened, so the recipient is not saved.');
  }
  const owner = ownerScreening?.ok ? ownerScreening.screening : null;
  if (screened.screening.verdict === 'BLOCK') return refuse(403, 'recipient_blocked', 'This address was refused by screening. Splash will not add it as a recipient.');
  if (owner?.verdict === 'BLOCK') return refuse(403, 'recipient_blocked', 'The wallet that owns this token account was refused by screening. Splash will not add it as a recipient.');
  // The recipient shows the less favourable of the two answers: REVIEW, or
  // unscreened, over CLEAR.
  const rank = (v: string | null) => (v === 'CLEAR' ? 0 : v === 'REVIEW' ? 2 : 1);
  const s = owner && rank(owner.verdict) > rank(screened.screening.verdict) ? owner : screened.screening;

  const supplier = parsed.supplier;
  const base = {
    id: `rcp_${randomUUID()}`,
    orgId: deps.orgId,
    name: supplier.name,
    country: supplier.country,
    bank: '',
    swift: '',
    account: '',
    tier: 'PAYOUT_ONLY',
    kybStatus: 'none' as const,
    orgEmail: supplier.email ?? undefined,
    createdVia: 'manual' as const,
    travelRule: {
      beneficiaryType: 'BUSINESS' as const,
      legalName: supplier.legalName,
      registrationNumber: supplier.registrationNumber,
      addressLine1: supplier.addressLine1,
      addressCity: supplier.addressCity,
      addressPostalCode: supplier.addressPostalCode ?? undefined,
      addressCountry: supplier.country,
    },
  };
  const now = deps.now();
  // An owner's own save is approved by that owner; a staff member's waits for one.
  const approval = input.requestedRole === 'OWNER' ? { approvedBy: input.requestedBy, approvedAt: now } : { approvedBy: null, approvedAt: null };
  let row: repo.RecipientRow | null;
  try {
    row = await deps.db.transaction(async (tx) => {
      const t = tx as unknown as DrizzleDb;
      // One address, one recipient, even for two saves at once.
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      if (parsed.kind !== 'CROSS_CHAIN') {
        const address = parsed.kind === 'EXCHANGE' ? parsed.depositAddress : parsed.address;
        if ((await savedAtSui(t, deps.orgId, address)).length > 0) return null;
      }
      let inserted: repo.RecipientRow;
      if (parsed.kind === 'EXCHANGE') {
        inserted = await repo.insertRecipient(t, {
          ...base,
          payoutMethod: 'WALLET',
          walletAddress: parsed.depositAddress,
          delivery: { deliveryKind: 'EXCHANGE', exchangeId: parsed.exchange, depositNetwork: parsed.network },
        });
      } else if (parsed.kind === 'SELF_CUSTODY') {
        inserted = await repo.insertRecipient(t, {
          ...base,
          payoutMethod: 'WALLET',
          walletAddress: parsed.address,
          walletProvider: parsed.walletLabel,
          delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' },
        });
      } else {
        inserted = await repo.insertRecipient(t, {
          ...base,
          payoutMethod: 'CROSS_CHAIN',
          delivery: {
            deliveryKind: 'CROSS_CHAIN',
            destinationChain: parsed.chain,
            destinationDomain: parsed.domain,
            destinationAddress: parsed.address,
            mintRecipient: parsed.mintRecipient,
          },
        });
      }
      await t
        .update(suppliers)
        .set({ createdBy: input.requestedBy, ...approval, destinationTokenOwner: tokenOwner })
        .where(and(eq(suppliers.id, inserted.id), eq(suppliers.orgId, deps.orgId)));
      return inserted;
    });
  } catch (error) {
    // The cross-chain unique index: two saves raced.
    if (/suppliers_cross_chain_unique|duplicate key/i.test(String((error as { message?: string })?.message ?? '') + String((error as { cause?: { message?: string } })?.cause?.message ?? ''))) {
      return refuse(409, 'recipient_exists', 'A recipient with this address on this chain is already saved.');
    }
    throw error;
  }
  if (!row) return refuse(409, 'recipient_exists', 'A recipient with this address is already saved. One address is one recipient.');
  await repo.setRecipientScreening(deps.db, deps.orgId, row.id, {
    verdict: (s.verdict as SupplierRow['screeningVerdict']) ?? null,
    reference: s.reference,
    screenedAt: s.screenedAt ? new Date(s.screenedAt) : null,
  });
  const stored = (await repo.getRecipient(deps.db, deps.orgId, row.id)) ?? row;
  const [raw] = await deps.db.select().from(suppliers).where(and(eq(suppliers.id, row.id), eq(suppliers.orgId, deps.orgId))).limit(1);
  const t = screened.screening;
  return {
    ok: true,
    recipient: walletRecipientView(stored, raw ?? null, false),
    screening: { verdict: t.verdict, provider: t.provider, reference: t.reference },
    ...(owner ? { ownerScreening: { address: owner.address, verdict: owner.verdict, provider: owner.provider, reference: owner.reference } } : {}),
  };
}

/**
 * An owner approves a wallet recipient a staff member saved, so it may be
 * paid and tagged (maker-checker). The one who saved it does not approve it.
 */
export async function approveWalletRecipient(
  deps: Pick<WalletRecipientDeps, 'db' | 'orgId' | 'now'>,
  input: { recipientId: string; approvedBy: string; role: string },
): Promise<{ ok: true; approvedBy: string; approvedAt: string } | Refusal> {
  if (input.role !== 'OWNER') return refuse(403, 'owner_only', 'Only an owner can approve a recipient for payment.');
  const [row] = await deps.db.select().from(suppliers).where(and(eq(suppliers.id, input.recipientId), eq(suppliers.orgId, deps.orgId))).limit(1);
  if (!row) return refuse(404, 'not_found', 'No such recipient.');
  if (!['EXCHANGE', 'SELF_CUSTODY', 'CROSS_CHAIN'].includes(row.deliveryKind)) return refuse(409, 'not_a_wallet_recipient', 'Only a wallet recipient is approved here.');
  if (row.approvedBy && row.approvedAt) return { ok: true, approvedBy: row.approvedBy, approvedAt: row.approvedAt.toISOString() };
  if (row.createdBy && row.createdBy === input.approvedBy) return refuse(409, 'creator_cannot_approve', 'Another owner approves a recipient you saved.');
  const now = deps.now();
  const done = await deps.db
    .update(suppliers)
    .set({ approvedBy: input.approvedBy, approvedAt: now, updatedAt: now })
    .where(and(eq(suppliers.id, row.id), eq(suppliers.orgId, deps.orgId), isNull(suppliers.approvedAt)))
    .returning({ approvedBy: suppliers.approvedBy, approvedAt: suppliers.approvedAt });
  const winner = done[0] ?? (await deps.db.select({ approvedBy: suppliers.approvedBy, approvedAt: suppliers.approvedAt }).from(suppliers).where(eq(suppliers.id, row.id)).limit(1))[0];
  return { ok: true, approvedBy: winner?.approvedBy ?? input.approvedBy, approvedAt: (winner?.approvedAt ?? now).toISOString() };
}

// ─── The ownership proof ────────────────────────────────────────────────────

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export type ProofLinkDeps = WalletRecipientDeps & {
  /** The site the supplier opens, e.g. https://app.splash… */
  appUrl: string;
  /** Sends the link to the supplier's email. */
  sendEmail?: (message: { to: string; subject: string; text: string; link: string }) => Promise<void>;
};

async function businessName(db: DrizzleDb, orgId: string): Promise<string> {
  const [org] = await db.select({ name: organizations.name, legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return (org?.legalName ?? '').trim() || org?.name || 'the paying business';
}

/**
 * Make (and send) the ownership-proof link for one SELF_CUSTODY recipient.
 * Any link still open for it is replaced: only the newest can be used.
 *
 * The link goes to the supplier's email. It is handed back only when
 * `revealLink` (an owner asked); a staff member gets it only by email to the
 * supplier, so a staff member cannot sign it themselves or spend it with a
 * junk signature. With no email on file, or an email that failed, a staff
 * member's request leaves no open link behind.
 */
export async function requestOwnershipProof(
  deps: ProofLinkDeps,
  input: { recipientId: string; requestedBy: string; revealLink?: boolean },
): Promise<{ ok: true; challengeId: string; link: string | null; message: string; expiresAt: string; emailedTo: string | null } | Refusal> {
  const reveal = input.revealLink === true;
  const [raw] = await deps.db.select().from(suppliers).where(and(eq(suppliers.id, input.recipientId), eq(suppliers.orgId, deps.orgId))).limit(1);
  const row = raw ? await repo.getRecipient(deps.db, deps.orgId, input.recipientId) : null;
  if (!raw || !row) return refuse(404, 'not_found', 'No such recipient.');
  if (row.delivery?.deliveryKind !== 'SELF_CUSTODY' || !row.walletAddress) {
    return refuse(409, 'not_self_custody', 'Only a wallet the supplier holds needs an ownership proof.');
  }
  if (!hasSupplierDetails(raw)) return refuse(DETAILS_MISSING.status, DETAILS_MISSING.code, DETAILS_MISSING.error);
  if (row.delivery.ownershipStatus === 'proven') return refuse(409, 'already_proven', 'This wallet is already proven.');
  if (!reveal && (!row.orgEmail || !deps.sendEmail)) {
    return refuse(409, 'supplier_email_needed', "The link goes to the supplier's email, and none is on file. Add it, or ask an owner to send the link.");
  }
  const now = deps.now();
  await deps.db
    .update(recipientOwnershipChallenges)
    .set({ usedAt: now, outcome: 'superseded' })
    .where(and(eq(recipientOwnershipChallenges.orgId, deps.orgId), eq(recipientOwnershipChallenges.recipientId, row.id), isNull(recipientOwnershipChallenges.usedAt)));
  const token = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + OWNERSHIP_PROOF_TTL_MS);
  const payingBusiness = await businessName(deps.db, deps.orgId);
  const message = ownershipProofMessage({ address: row.walletAddress, supplierName: row.travelRule?.legalName ?? row.name, payingBusiness, nonce, expiresAt });
  const id = `roc_${randomUUID()}`;
  const link = `${deps.appUrl.replace(/\/+$/, '')}/wallet-proof/${token}`;
  let emailedTo: string | null = null;
  await deps.db.insert(recipientOwnershipChallenges).values({
    id,
    orgId: deps.orgId,
    recipientId: row.id,
    address: normalizeSuiAddress(row.walletAddress),
    tokenSha256: sha256(token),
    nonce,
    message,
    expiresAt,
    createdBy: input.requestedBy,
    createdAt: now,
    recipientEpoch: raw.ownershipEpoch,
  });
  if (row.orgEmail && deps.sendEmail) {
    try {
      await deps.sendEmail({
        to: row.orgEmail,
        subject: `${payingBusiness} asks you to confirm your wallet`,
        text: [
          `${payingBusiness} wants to pay you in USDC to the wallet ${normalizeSuiAddress(row.walletAddress)}.`,
          'Before any payment, please confirm you hold this wallet: open the link, connect the wallet and sign the message shown. Signing moves no money.',
          link,
          `The link works once and expires on ${expiresAt.toISOString()}.`,
        ].join('\n\n'),
        link,
      });
      emailedTo = row.orgEmail;
      await deps.db.update(recipientOwnershipChallenges).set({ sentTo: row.orgEmail }).where(eq(recipientOwnershipChallenges.id, id));
    } catch {
      if (!reveal) {
        // Nobody was sent it, and the one who asked may not see it: withdrawn.
        await deps.db.update(recipientOwnershipChallenges).set({ usedAt: now, outcome: 'email_failed' }).where(eq(recipientOwnershipChallenges.id, id));
        return refuse(502, 'email_failed', "The link could not be emailed to the supplier. Nothing is open; try again, or ask an owner to send it.");
      }
      // An owner asked: the link is returned, and the owner can pass it on.
    }
  }
  return { ok: true, challengeId: id, link: reveal ? link : null, message, expiresAt: expiresAt.toISOString(), emailedTo };
}

/** The ownership-proof page: what to sign, by the link's token. Nothing about the paying business beyond its name in the message. */
export async function readOwnershipChallenge(db: DrizzleDb, token: unknown, now: Date) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return refuse(404, 'not_found', 'This link is not valid.');
  const [row] = await db.select().from(recipientOwnershipChallenges).where(eq(recipientOwnershipChallenges.tokenSha256, sha256(token))).limit(1);
  if (!row) return refuse(404, 'not_found', 'This link is not valid.');
  const state = row.outcome === 'verified' ? 'verified' : row.usedAt ? 'used' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'open';
  return { ok: true as const, address: row.address, message: row.message, expiresAt: row.expiresAt.toISOString(), state };
}

export type ProofSubmitDeps = {
  db: DrizzleDb;
  now: () => Date;
  /** True when `signature` is the address's own signature over the message as a Sui personal message. */
  verifySignature: (message: Uint8Array, signature: string, address: string) => Promise<boolean>;
};

/**
 * The supplier's signature. The challenge is used up first (a compare-and-
 * set on an unused, unexpired row), so a link is good for one try and the
 * nonce for ever; then the signature over the stored message is checked
 * against the stored address; only then, in one transaction and only if the
 * recipient is still the one the link was made for and no withdrawal came
 * since (its ownership epoch is the link's), is the proof recorded.
 */
export async function submitOwnershipProof(deps: ProofSubmitDeps, input: { token: unknown; signature: unknown }): Promise<{ ok: true; address: string; challengeId: string } | Refusal> {
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) return refuse(404, 'not_found', 'This link is not valid.');
  const signature = typeof input.signature === 'string' ? input.signature.trim() : '';
  if (!signature || signature.length > 4096) return refuse(400, 'bad_signature', 'Sign the message with the wallet, then send the signature.');
  const now = deps.now();
  const tokenSha256 = sha256(input.token);
  const [claimed] = await deps.db
    .update(recipientOwnershipChallenges)
    .set({ usedAt: now, outcome: 'bad_signature' })
    .where(and(eq(recipientOwnershipChallenges.tokenSha256, tokenSha256), isNull(recipientOwnershipChallenges.usedAt), sql`${recipientOwnershipChallenges.expiresAt} > ${now}`))
    .returning();
  if (!claimed) {
    const [row] = await deps.db.select().from(recipientOwnershipChallenges).where(eq(recipientOwnershipChallenges.tokenSha256, tokenSha256)).limit(1);
    if (!row) return refuse(404, 'not_found', 'This link is not valid.');
    if (row.usedAt) return refuse(409, 'link_used', 'This link was already used. Ask for a new one.');
    return refuse(410, 'link_expired', 'This link has expired. Ask for a new one.');
  }
  let valid = false;
  try {
    valid = await deps.verifySignature(new TextEncoder().encode(claimed.message), signature, claimed.address);
  } catch {
    valid = false;
  }
  if (!valid) return refuse(400, 'bad_signature', 'The signature is not this wallet’s signature of the message. Ask for a new link and sign with the wallet at this address.');

  const outcome = await deps.db.transaction(async (tx) => {
    const t = tx as unknown as DrizzleDb;
    const proven = await t
      .update(suppliers)
      .set({ ownershipStatus: 'proven', ownershipProvenAt: now, ownershipChallengeId: claimed.id, updatedAt: now })
      .where(
        and(
          eq(suppliers.id, claimed.recipientId),
          eq(suppliers.orgId, claimed.orgId),
          eq(suppliers.deliveryKind, 'SELF_CUSTODY'),
          eq(suppliers.walletAddress, claimed.address),
          eq(suppliers.ownershipEpoch, claimed.recipientEpoch),
          inArray(suppliers.ownershipStatus, ['unproven', 'revoked']),
        ),
      )
      .returning({ id: suppliers.id });
    if (proven.length !== 1) {
      const [now_] = await t.select().from(suppliers).where(and(eq(suppliers.id, claimed.recipientId), eq(suppliers.orgId, claimed.orgId))).limit(1);
      if (!now_ || now_.deliveryKind !== 'SELF_CUSTODY' || !now_.walletAddress || normalizeSuiAddress(now_.walletAddress) !== claimed.address) return 'recipient_changed' as const;
      return 'proof_withdrawn' as const;
    }
    const verified = await t
      .update(recipientOwnershipChallenges)
      .set({ outcome: 'verified' })
      .where(and(eq(recipientOwnershipChallenges.id, claimed.id), eq(recipientOwnershipChallenges.outcome, 'bad_signature')))
      .returning({ id: recipientOwnershipChallenges.id });
    if (verified.length !== 1) throw new Error('the ownership challenge changed while it was being verified');
    await recordOwnershipProof(t, { orgId: claimed.orgId, address: claimed.address, method: 'sui_personal_message', evidence: `${claimed.message}\n${signature}`, now });
    return 'proven' as const;
  });
  if (outcome === 'recipient_changed') return refuse(409, 'recipient_changed', 'The recipient this link was made for has changed. Ask for a new link.');
  if (outcome === 'proof_withdrawn') return refuse(409, 'proof_withdrawn', 'An owner withdrew this wallet’s proof after the link was made. Ask for a new link.');
  return { ok: true, address: claimed.address, challengeId: claimed.id };
}

/**
 * Withdraw a recipient's proof (the owners no longer trust it, or the
 * recipient is being removed): no payment to it until it is proven again,
 * open links are withdrawn, a link already being checked proves nothing (the
 * epoch moves on), and a spending-rule request still collecting signatures
 * that would tag it WALLET is cancelled.
 */
export async function revokeRecipientOwnership(deps: Pick<WalletRecipientDeps, 'db' | 'orgId' | 'now'>, input: { recipientId: string }): Promise<{ ok: true } | Refusal> {
  const row = await repo.getRecipient(deps.db, deps.orgId, input.recipientId);
  if (!row) return refuse(404, 'not_found', 'No such recipient.');
  if (row.delivery?.deliveryKind !== 'SELF_CUSTODY' || !row.walletAddress) return refuse(409, 'not_self_custody', 'Only a wallet the supplier holds has an ownership proof.');
  const now = deps.now();
  await deps.db
    .update(suppliers)
    .set({ ownershipStatus: 'revoked', ownershipEpoch: sql`${suppliers.ownershipEpoch} + 1`, ownershipProvenAt: null, ownershipChallengeId: null, updatedAt: now })
    .where(and(eq(suppliers.id, row.id), eq(suppliers.orgId, deps.orgId), eq(suppliers.deliveryKind, 'SELF_CUSTODY')));
  await deps.db
    .update(recipientOwnershipChallenges)
    .set({ usedAt: now, outcome: 'withdrawn' })
    .where(and(eq(recipientOwnershipChallenges.orgId, deps.orgId), eq(recipientOwnershipChallenges.recipientId, row.id), isNull(recipientOwnershipChallenges.usedAt)));
  await revokeOwnershipProof(deps.db, { orgId: deps.orgId, address: row.walletAddress, now });
  return { ok: true };
}

// ─── The gate a payment passes ──────────────────────────────────────────────

/**
 * Whether the exchange confirmed this saved EXCHANGE account: a Travel Rule
 * message from this business to this address at this exchange, made after
 * the account was saved, that the counterparty approved. In production a
 * sandbox message confirms nothing.
 */
export async function exchangeConfirmed(db: DrizzleDb, row: Pick<SupplierRow, 'orgId' | 'walletAddress' | 'exchangeId' | 'createdAt'>, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!row.walletAddress || !row.exchangeId) return false;
  const conditions = [
    eq(travelRuleTransfers.orgId, row.orgId),
    eq(travelRuleTransfers.depositAddress, normalizeSuiAddress(row.walletAddress)),
    eq(travelRuleTransfers.exchange, row.exchangeId),
    eq(travelRuleTransfers.status, 'approved'),
    gte(travelRuleTransfers.createdAt, row.createdAt),
  ];
  if (isProductionRuntime(env)) conditions.push(eq(travelRuleTransfers.sandbox, false));
  const [hit] = await db.select({ id: travelRuleTransfers.id }).from(travelRuleTransfers).where(and(...conditions)).limit(1);
  return Boolean(hit);
}

export type DeliveryGateOptions = {
  /**
   * `open`: a payment is being opened (its Travel Rule message is sent from
   * it, so an unconfirmed exchange account may be opened for). `sign`
   * (the default): a signature is asked for.
   */
  stage?: 'open' | 'sign';
  /** Splash's own Sui addresses. Default: this server's configuration, read live. */
  splashAddresses?: SplashAddressSource;
};

/**
 * May this business pay `recipient` on Sui as `kind`? Null lets it through.
 *
 * A business-wallet payment (kind 0) is checked by the chain (the address
 * registry), a bank payout (kind 4) goes through the payout route, and a
 * cross-chain payment (kind 3) never comes this way. A wallet payment
 * (kind 1) needs an approved, saved SELF_CUSTODY recipient with the
 * supplier's details whose ownership proof holds; an exchange payment
 * (kind 2) an approved, saved EXCHANGE recipient, confirmed by the exchange
 * before anything is signed. An address saved as the other kind is
 * refused, so declaring the other kind avoids neither the proof nor the
 * Travel Rule. An address Splash controls, or one of the business's own,
 * is refused whatever is saved.
 */
export async function walletDeliveryGate(db: DrizzleDb, orgId: string, recipient: string, kind: number | null, opts: DeliveryGateOptions = {}): Promise<GateRefusal | null> {
  if (kind === MOVE_KIND.SPLASH_BUSINESS || kind === MOVE_KIND.BANK_PAYOUT) return null;
  if (kind === MOVE_KIND.CROSS_CHAIN) {
    return { status: 400, code: 'wrong_pay_path', error: "A cross-chain payment is paid from the owners' wallet over CCTP, not as a payment on Sui." };
  }
  if (kind !== MOVE_KIND.WALLET && kind !== MOVE_KIND.EXCHANGE) return { status: 400, code: 'bad_kind', error: 'The payment does not say how the recipient is paid.' };
  let address: string;
  try {
    address = normalizeSuiAddress(recipient);
  } catch {
    return { status: 400, code: 'bad_recipient', error: 'The recipient is not a Sui address.' };
  }
  const splash = await splashRefusal(opts.splashAddresses, address);
  if (splash) return splash;
  if (await isOwnAddress(db, orgId, address)) return OWN_ADDRESS;
  const rows = await savedAtSui(db, orgId, address);
  if (rows.length === 0) return { status: 409, code: 'recipient_not_saved', error: 'Save this supplier as a recipient first: an exchange account, or a wallet the supplier holds and has proven.' };
  if (rows.length > 1) return { status: 409, code: 'recipient_ambiguous', error: 'More than one saved recipient has this address. Keep one, then try again.' };
  const r = rows[0];
  const saved = r.deliveryKind as DeliveryKind;
  if (kind === MOVE_KIND.EXCHANGE && saved !== 'EXCHANGE') {
    return { status: 409, code: 'kind_mismatch', error: 'This address is saved as a wallet the supplier holds, not an exchange account. Pay it as a wallet payment.' };
  }
  if (kind === MOVE_KIND.WALLET && saved !== 'SELF_CUSTODY') {
    return { status: 409, code: 'kind_mismatch', error: 'This address is saved as an exchange account. Pay it as an exchange payment, with its Travel Rule message.' };
  }
  if (!hasSupplierDetails(r)) return DETAILS_MISSING;
  if (!r.approvedAt || !r.approvedBy) {
    return { status: 409, code: 'recipient_not_approved', error: 'A staff member saved this recipient. An owner approves it before it is paid.' };
  }
  if (kind === MOVE_KIND.EXCHANGE) {
    if ((opts.stage ?? 'sign') === 'open') return null;
    if (await exchangeConfirmed(db, r)) return null;
    return {
      status: 409,
      code: 'exchange_unconfirmed',
      error: "The exchange has not yet confirmed this account belongs to the supplier. The first payment is signed once the exchange approves its Travel Rule message.",
    };
  }
  if (r.ownershipStatus !== 'proven') return { status: 409, code: 'ownership_not_proven', error: 'The supplier has not proven it holds this wallet yet. Send the ownership link and wait for the signature.' };
  const [proof] = await db
    .select({ address: walletOwnershipProofs.address })
    .from(walletOwnershipProofs)
    .where(and(eq(walletOwnershipProofs.orgId, orgId), eq(walletOwnershipProofs.address, address), isNull(walletOwnershipProofs.revokedAt)))
    .limit(1);
  if (!proof) return { status: 409, code: 'ownership_not_proven', error: 'The ownership proof for this wallet no longer holds.' };
  return null;
}

/**
 * This business's payable recipients among these Sui addresses, for a
 * SpendPolicy tag: `WALLET` a proven wallet, `EXCHANGE` a confirmed exchange
 * account; each approved, never Splash's or the business's own.
 */
export async function payableForTag(db: DrizzleDb, orgId: string, addresses: string[], kind: typeof MOVE_KIND.WALLET | typeof MOVE_KIND.EXCHANGE, opts: Pick<DeliveryGateOptions, 'splashAddresses'> = {}): Promise<string[]> {
  const wanted = [...new Set(addresses.map((a) => normalizeSuiAddress(a)))];
  const out: string[] = [];
  for (const a of wanted) {
    if ((await walletDeliveryGate(db, orgId, a, kind, { stage: 'sign', ...opts })) === null) out.push(a);
  }
  return out;
}

/** This business's confirmed EXCHANGE recipients among these Sui addresses (the EXCHANGE tag's gate). */
export async function savedExchangeAddresses(db: DrizzleDb, orgId: string, addresses: string[], opts: Pick<DeliveryGateOptions, 'splashAddresses'> = {}): Promise<string[]> {
  return payableForTag(db, orgId, addresses, MOVE_KIND.EXCHANGE, opts);
}

/** The newest ownership challenges of one recipient, for its owners' screen. No tokens: they are not kept. */
export async function ownershipChallengesOf(db: DrizzleDb, orgId: string, recipientId: string) {
  const rows = await db
    .select()
    .from(recipientOwnershipChallenges)
    .where(and(eq(recipientOwnershipChallenges.orgId, orgId), eq(recipientOwnershipChallenges.recipientId, recipientId)))
    .orderBy(desc(recipientOwnershipChallenges.createdAt))
    .limit(10);
  return rows.map((r) => ({ id: r.id, expiresAt: r.expiresAt.toISOString(), sentTo: r.sentTo, createdBy: r.createdBy, usedAt: r.usedAt?.toISOString() ?? null, outcome: r.outcome }));
}

/** Who saved, approved and proved a recipient, for the controls evidence. Null for none at this address. */
export async function recipientControlsAt(db: DrizzleDb, orgId: string, address: string) {
  let a: string;
  try {
    a = normalizeSuiAddress(address);
  } catch {
    return null;
  }
  const rows = await savedAtSui(db, orgId, a);
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    recipientId: r.id,
    deliveryKind: r.deliveryKind,
    createdBy: r.createdBy ?? null,
    approvedBy: r.approvedBy ?? null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    ownership: r.deliveryKind === 'SELF_CUSTODY' ? { status: r.ownershipStatus ?? 'unproven', provenAt: r.ownershipProvenAt?.toISOString() ?? null, challengeId: r.ownershipChallengeId ?? null } : null,
    exchange: r.deliveryKind === 'EXCHANGE' ? { id: r.exchangeId ?? null, confirmed: await exchangeConfirmed(db, r) } : null,
  };
}

/** The chains a cross-chain recipient may be on, for the form. */
export const CROSS_CHAIN_RECIPIENT_CHAINS = Object.keys(CROSS_CHAIN_CHAINS);
