/**
 * Wallet recipients for ONE business (v2 §4.7, D5): saving the three kinds,
 * the self-custody ownership proof, and the gate a payment passes.
 *
 *   Saving       the kind's fields are checked (lib/recipients/
 *                wallet-recipients.ts), the address is screened for this
 *                business by the server's provider (lib/server/
 *                kyt-screenings.ts) before anything is stored, and a BLOCK
 *                is never saved. One saved recipient per address: a second
 *                at the same address is refused, so which supplier a
 *                payment goes to is never guessed.
 *   The proof    a SELF_CUSTODY recipient is paid only once the supplier
 *                proves it holds the wallet. Splash makes a link (a random
 *                token, kept only as its SHA-256) to a fixed message naming
 *                the address, the supplier, the paying business, a
 *                single-use nonce and the expiry; the supplier signs it as a
 *                Sui personal message with the wallet. The challenge is used
 *                up BEFORE the signature is checked, so a link is good for
 *                one try, and an expired, used or replaced link proves
 *                nothing. A good signature records the proof in
 *                `wallet_ownership_proofs`, which is also the off-chain gate
 *                for the WALLET tag on a SpendPolicy (lib/server/
 *                ownership-proofs.ts).
 *   The gate     `walletDeliveryGate`: a wallet payment (kind WALLET) goes
 *                only to this business's saved SELF_CUSTODY recipient whose
 *                proof holds; an exchange payment (kind EXCHANGE) only to its
 *                saved EXCHANGE recipient. Checked when a payment is opened
 *                and again before every signature
 *                (lib/server/payment-compliance-gate.ts).
 *
 * Every read and write takes the business's org from the caller, who took it
 * from the session. The proof link is the one cross-tenant read, by its
 * token, which is the capability: it was handed to one supplier.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { organizations, recipientOwnershipChallenges, suppliers, walletOwnershipProofs } from '../db/schema.ts';
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
import type { DrizzleDb } from './wallet-signing-store.ts';

export type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

export type WalletRecipientDeps = {
  db: DrizzleDb;
  orgId: string;
  now: () => Date;
  /** The server's screening provider. With none, verdicts are null and the recipient is saved but not payable. */
  kyt: KytProvider;
};

type SupplierRow = typeof suppliers.$inferSelect;

/** What a client sees of one wallet recipient. Its own business's data only. */
export function walletRecipientView(row: repo.RecipientRow) {
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
    exchange: d.deliveryKind === 'EXCHANGE' ? { id: d.exchangeId ?? null, network: d.depositNetwork ?? null, depositAddress: row.walletAddress ?? null } : null,
    wallet: d.deliveryKind === 'SELF_CUSTODY' ? { address: row.walletAddress ?? null, label: row.walletProvider ?? null, ownership: d.ownershipStatus ?? 'unproven' } : null,
    crossChain:
      d.deliveryKind === 'CROSS_CHAIN'
        ? { chain: d.destinationChain ?? null, domain: d.destinationDomain ?? null, address: d.destinationAddress ?? null, mintRecipient: d.mintRecipient ?? null, asset: 'USDC' as const, route: 'CCTP_V2' as const }
        : null,
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

/** Save one wallet recipient: checked, screened, and stored only if not blocked. */
export async function createWalletRecipient(
  deps: WalletRecipientDeps,
  input: { body: Record<string, unknown>; requestedBy: string },
): Promise<{ ok: true; recipient: ReturnType<typeof walletRecipientView>; screening: { verdict: string | null; provider: string; reference: string | null } } | Refusal> {
  let parsed: WalletRecipientInput;
  try {
    parsed = parseWalletRecipient(input.body);
  } catch (error) {
    if (error instanceof RecipientInputError) return refuse(400, error.code, error.message);
    throw error;
  }
  if (parsed.kind === 'CROSS_CHAIN') {
    const [dupe] = await deps.db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.orgId, deps.orgId), eq(suppliers.deliveryKind, 'CROSS_CHAIN'), eq(suppliers.destinationChain, parsed.chain), eq(suppliers.destinationAddress, parsed.address)))
      .limit(1);
    if (dupe) return refuse(409, 'recipient_exists', 'A recipient with this address on this chain is already saved.');
  } else {
    const address = parsed.kind === 'EXCHANGE' ? parsed.depositAddress : parsed.address;
    if ((await savedAtSui(deps.db, deps.orgId, address)).length > 0) {
      return refuse(409, 'recipient_exists', 'A recipient with this address is already saved. One address is one recipient.');
    }
  }

  // Screened BEFORE saving: a blocked address never enters the list.
  const subject = screeningSubjectOf(parsed);
  const screened = await screenRecipient({ db: deps.db, orgId: deps.orgId, kyt: deps.kyt, now: deps.now }, { kind: subject.kind, chain: subject.chain, address: subject.address, requestedBy: input.requestedBy });
  if (!screened.ok) return screened;
  const s = screened.screening;
  if (s.verdict === 'BLOCK') return refuse(403, 'recipient_blocked', 'This address was refused by screening. Splash will not add it as a recipient.');

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
  let row: repo.RecipientRow;
  try {
    if (parsed.kind === 'EXCHANGE') {
      row = await repo.insertRecipient(deps.db, {
        ...base,
        payoutMethod: 'WALLET',
        walletAddress: parsed.depositAddress,
        delivery: { deliveryKind: 'EXCHANGE', exchangeId: parsed.exchange, depositNetwork: parsed.network },
      });
    } else if (parsed.kind === 'SELF_CUSTODY') {
      row = await repo.insertRecipient(deps.db, {
        ...base,
        payoutMethod: 'WALLET',
        walletAddress: parsed.address,
        walletProvider: parsed.walletLabel,
        delivery: { deliveryKind: 'SELF_CUSTODY', ownershipStatus: 'unproven' },
      });
    } else {
      row = await repo.insertRecipient(deps.db, {
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
  } catch (error) {
    // The cross-chain unique index: two saves raced.
    if (/suppliers_cross_chain_unique|duplicate key/i.test(String((error as { message?: string })?.message ?? '') + String((error as { cause?: { message?: string } })?.cause?.message ?? ''))) {
      return refuse(409, 'recipient_exists', 'A recipient with this address on this chain is already saved.');
    }
    throw error;
  }
  await repo.setRecipientScreening(deps.db, deps.orgId, row.id, {
    verdict: (s.verdict as SupplierRow['screeningVerdict']) ?? null,
    reference: s.reference,
    screenedAt: s.screenedAt ? new Date(s.screenedAt) : null,
  });
  const stored = (await repo.getRecipient(deps.db, deps.orgId, row.id)) ?? row;
  return { ok: true, recipient: walletRecipientView(stored), screening: { verdict: s.verdict, provider: s.provider, reference: s.reference } };
}

// ─── The ownership proof ────────────────────────────────────────────────────

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export type ProofLinkDeps = WalletRecipientDeps & {
  /** The site the supplier opens, e.g. https://app.splash… */
  appUrl: string;
  /** Sends the link to the supplier's email. Absent: the link is only returned. */
  sendEmail?: (message: { to: string; subject: string; text: string; link: string }) => Promise<void>;
};

async function businessName(db: DrizzleDb, orgId: string): Promise<string> {
  const [org] = await db.select({ name: organizations.name, legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return (org?.legalName ?? '').trim() || org?.name || 'the paying business';
}

/**
 * Make (and send) the ownership-proof link for one SELF_CUSTODY recipient.
 * Any link still open for it is replaced: only the newest can be used.
 */
export async function requestOwnershipProof(
  deps: ProofLinkDeps,
  input: { recipientId: string; requestedBy: string },
): Promise<{ ok: true; challengeId: string; link: string; message: string; expiresAt: string; emailedTo: string | null } | Refusal> {
  const row = await repo.getRecipient(deps.db, deps.orgId, input.recipientId);
  if (!row) return refuse(404, 'not_found', 'No such recipient.');
  if (row.delivery?.deliveryKind !== 'SELF_CUSTODY' || !row.walletAddress) {
    return refuse(409, 'not_self_custody', 'Only a wallet the supplier holds needs an ownership proof.');
  }
  if (row.delivery.ownershipStatus === 'proven') return refuse(409, 'already_proven', 'This wallet is already proven.');
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
      // The link is still returned; whoever asked can pass it on.
    }
  }
  return { ok: true, challengeId: id, link, message, expiresAt: expiresAt.toISOString(), emailedTo };
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
 * against the stored address; only then is the proof recorded.
 */
export async function submitOwnershipProof(deps: ProofSubmitDeps, input: { token: unknown; signature: unknown }): Promise<{ ok: true; address: string } | Refusal> {
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) return refuse(404, 'not_found', 'This link is not valid.');
  const signature = typeof input.signature === 'string' ? input.signature.trim() : '';
  if (!signature || signature.length > 4096) return refuse(400, 'bad_signature', 'Sign the message with the wallet, then send the signature.');
  const now = deps.now();
  const tokenSha256 = sha256(input.token);
  const [claimed] = await deps.db
    .update(recipientOwnershipChallenges)
    .set({ usedAt: now, outcome: 'bad_signature' })
    .where(and(eq(recipientOwnershipChallenges.tokenSha256, tokenSha256), isNull(recipientOwnershipChallenges.usedAt), gt(recipientOwnershipChallenges.expiresAt, now)))
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

  // The recipient must still be the one the link was made for.
  const [recipient] = await deps.db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, claimed.recipientId), eq(suppliers.orgId, claimed.orgId)))
    .limit(1);
  if (!recipient || recipient.deliveryKind !== 'SELF_CUSTODY' || !recipient.walletAddress || normalizeSuiAddress(recipient.walletAddress) !== claimed.address) {
    return refuse(409, 'recipient_changed', 'The recipient this link was made for has changed. Ask for a new link.');
  }
  await deps.db.update(recipientOwnershipChallenges).set({ outcome: 'verified' }).where(and(eq(recipientOwnershipChallenges.id, claimed.id), eq(recipientOwnershipChallenges.outcome, 'bad_signature')));
  await recordOwnershipProof(deps.db, {
    orgId: claimed.orgId,
    address: claimed.address,
    method: 'sui_personal_message',
    evidence: `${claimed.message}\n${signature}`,
    now,
  });
  await deps.db
    .update(suppliers)
    .set({ ownershipStatus: 'proven', updatedAt: now })
    .where(and(eq(suppliers.id, recipient.id), eq(suppliers.orgId, claimed.orgId), eq(suppliers.deliveryKind, 'SELF_CUSTODY')));
  return { ok: true, address: claimed.address };
}

/**
 * Withdraw a recipient's proof (the owners no longer trust it, or the
 * recipient is being removed): no payment to it until it is proven again,
 * open links are withdrawn, and a spending-rule request still collecting
 * signatures that would tag it WALLET is cancelled.
 */
export async function revokeRecipientOwnership(deps: Pick<WalletRecipientDeps, 'db' | 'orgId' | 'now'>, input: { recipientId: string }): Promise<{ ok: true } | Refusal> {
  const row = await repo.getRecipient(deps.db, deps.orgId, input.recipientId);
  if (!row) return refuse(404, 'not_found', 'No such recipient.');
  if (row.delivery?.deliveryKind !== 'SELF_CUSTODY' || !row.walletAddress) return refuse(409, 'not_self_custody', 'Only a wallet the supplier holds has an ownership proof.');
  const now = deps.now();
  await deps.db
    .update(recipientOwnershipChallenges)
    .set({ usedAt: now, outcome: 'withdrawn' })
    .where(and(eq(recipientOwnershipChallenges.orgId, deps.orgId), eq(recipientOwnershipChallenges.recipientId, row.id), isNull(recipientOwnershipChallenges.usedAt)));
  await deps.db
    .update(suppliers)
    .set({ ownershipStatus: 'revoked', updatedAt: now })
    .where(and(eq(suppliers.id, row.id), eq(suppliers.orgId, deps.orgId), eq(suppliers.deliveryKind, 'SELF_CUSTODY')));
  await revokeOwnershipProof(deps.db, { orgId: deps.orgId, address: row.walletAddress, now });
  return { ok: true };
}

// ─── The gate a payment passes ──────────────────────────────────────────────

/**
 * May this business pay `recipient` on Sui as `kind`? Null lets it through.
 *
 * A business-wallet payment (kind 0) is checked by the chain (the address
 * registry), a bank payout (kind 4) goes through the payout route, and a
 * cross-chain payment (kind 3) never comes this way. A wallet payment
 * (kind 1) needs a saved SELF_CUSTODY recipient whose ownership proof
 * holds; an exchange payment (kind 2) a saved EXCHANGE recipient. An address
 * saved as the other kind is refused, so declaring the other kind avoids
 * neither the proof nor the Travel Rule.
 */
export async function walletDeliveryGate(db: DrizzleDb, orgId: string, recipient: string, kind: number | null): Promise<{ status: number; code: string; error: string } | null> {
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
  const rows = await savedAtSui(db, orgId, address);
  if (rows.length === 0) return { status: 409, code: 'recipient_not_saved', error: 'Save this supplier as a recipient first: an exchange account, or a wallet the supplier holds and has proven.' };
  if (rows.length > 1) return { status: 409, code: 'recipient_ambiguous', error: 'More than one saved recipient has this address. Keep one, then try again.' };
  const r = rows[0];
  const saved = r.deliveryKind as DeliveryKind;
  if (kind === MOVE_KIND.EXCHANGE) {
    if (saved !== 'EXCHANGE') return { status: 409, code: 'kind_mismatch', error: 'This address is saved as a wallet the supplier holds, not an exchange account. Pay it as a wallet payment.' };
    return null;
  }
  if (saved !== 'SELF_CUSTODY') return { status: 409, code: 'kind_mismatch', error: 'This address is saved as an exchange account. Pay it as an exchange payment, with its Travel Rule message.' };
  if (r.ownershipStatus !== 'proven') return { status: 409, code: 'ownership_not_proven', error: 'The supplier has not proven it holds this wallet yet. Send the ownership link and wait for the signature.' };
  const [proof] = await db
    .select({ address: walletOwnershipProofs.address })
    .from(walletOwnershipProofs)
    .where(and(eq(walletOwnershipProofs.orgId, orgId), eq(walletOwnershipProofs.address, address), isNull(walletOwnershipProofs.revokedAt)))
    .limit(1);
  if (!proof) return { status: 409, code: 'ownership_not_proven', error: 'The ownership proof for this wallet no longer holds.' };
  return null;
}

/** This business's saved EXCHANGE recipients among these Sui addresses (the EXCHANGE tag's gate). */
export async function savedExchangeAddresses(db: DrizzleDb, orgId: string, addresses: string[]): Promise<string[]> {
  const wanted = [...new Set(addresses.map((a) => normalizeSuiAddress(a)))];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ address: suppliers.walletAddress })
    .from(suppliers)
    .where(and(eq(suppliers.orgId, orgId), eq(suppliers.deliveryKind, 'EXCHANGE'), inArray(suppliers.walletAddress, wanted)));
  return [...new Set(rows.map((r) => r.address).filter((a): a is string => Boolean(a)))];
}

/** The newest ownership challenges of one recipient, for its owners' screen. No tokens: they are not kept. */
export async function ownershipChallengesOf(db: DrizzleDb, orgId: string, recipientId: string) {
  const rows = await db
    .select()
    .from(recipientOwnershipChallenges)
    .where(and(eq(recipientOwnershipChallenges.orgId, orgId), eq(recipientOwnershipChallenges.recipientId, recipientId)))
    .orderBy(desc(recipientOwnershipChallenges.createdAt))
    .limit(10);
  return rows.map((r) => ({ id: r.id, expiresAt: r.expiresAt.toISOString(), sentTo: r.sentTo, usedAt: r.usedAt?.toISOString() ?? null, outcome: r.outcome }));
}

/** The chains a cross-chain recipient may be on, for the form. */
export const CROSS_CHAIN_RECIPIENT_CHAINS = Object.keys(CROSS_CHAIN_CHAINS);
