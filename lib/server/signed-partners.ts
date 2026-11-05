import 'server-only';

import { getEnv } from '@/lib/env';
import { parseSignedPartners, partnerLabel, type PartnerId } from '@/lib/partners/signed-partners';

/**
 * The deployment's signed partners, read once from `SIGNED_PARTNERS`.
 * Server-side only: which agreements are signed is configuration, not
 * something a browser bundle decides.
 */
export function signedPartners(): ReadonlySet<PartnerId> {
  return parseSignedPartners(getEnv().SIGNED_PARTNERS);
}

/** What copy may call a partner here: its name if signed, its role if not. */
export function labelFor(id: PartnerId): string {
  return partnerLabel(id, signedPartners());
}
