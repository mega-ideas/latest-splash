/**
 * The title a person carries after their name, as in "Declined by Aisha (CFO)"
 * (v2 Phase 3, Sky's decision): the member's own job title when they have one,
 * else "Finance lead" for the person the owners appointed to it, else the word
 * for their role. Pure and client-safe.
 *
 * A membership carries a free-text `title` (migration 0083), empty by default and
 * set in Settings, Team: by an owner for anyone in their business, and by a person
 * for themselves. Every "Name (Title)" in the product is made here or by
 * `declinerLabel` (lib/team/declined-by.ts), which this uses, so a title is cleaned
 * the same way wherever it is said.
 */
import { declinerLabel, plainTitle, TITLE_MAX } from './declined-by.ts';
import { FINANCE_LEAD_NAME } from './view.ts';
import { roleLabel } from '../wallet-page/members.ts';

export { plainTitle, TITLE_MAX };

/** The title as plain words, whatever the member has: their own, else "Finance lead", else the role's word ("Owner", "Staff", "Approver", "Viewer"; "Member" for none). */
export function memberTitle(member: { title?: unknown; role?: string | null; financeLead?: boolean }): string {
  return plainTitle(member.title) ?? (member.financeLead ? FINANCE_LEAD_NAME : roleLabel(member.role ?? ''));
}

/** "Name (Title)" for a member: each part cleaned on its own, then put in the shape. A name with nothing usable is said by the title alone. */
export function memberLabel(member: { name?: unknown; title?: unknown; role?: string | null; financeLead?: boolean }): string {
  return declinerLabel({ name: member.name, title: memberTitle(member) });
}

/** Said under the title field, to the person who sets it and to an owner setting someone else's. */
export const TITLE_HELP = 'Plain words, up to 40 characters, for example CFO, Finance lead or Operations. It shows after the name, as in Aisha (CFO), and ends at the first link, number, symbol or the word “and”. Leave it empty to use the role.';

/** Said when what was typed has no words in it (a link, markup, only numbers or symbols). */
export const TITLE_REFUSAL = 'A title is plain words, for example CFO or Operations. Links, markup and numbers on their own cannot be a title.';

/**
 * What was typed or sent as a title: nothing at all clears it (null), plain words are kept as
 * cleaned, and anything else (a number, an object, a link, markup) is refused rather than quietly
 * dropped, so a person is never told "saved" for something that was not.
 */
export function titleFromInput(raw: unknown): { ok: true; title: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, title: null };
  if (typeof raw !== 'string') return { ok: false, error: TITLE_REFUSAL };
  // Whitespace and invisible characters alone are empty, not a bad title.
  if (raw.slice(0, 4000).replace(/[\p{C}\p{Z}\s]/gu, '') === '') return { ok: true, title: null };
  const title = plainTitle(raw);
  return title === null ? { ok: false, error: TITLE_REFUSAL } : { ok: true, title };
}
