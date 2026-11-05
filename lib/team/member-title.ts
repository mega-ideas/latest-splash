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
import { declinerLabel, plainTitle, plainTitleDetail, TITLE_MAX } from './declined-by.ts';
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

/**
 * The authority decisions an owner makes (who is in charge, who signs off a move) must show the role the
 * system knows, not only the words a person chose for themselves: "Maya (CFO), Staff". The role is left off
 * when the title already says it (no title, or a title that is the role's own word).
 */
export function titleAndRole(member: { title?: unknown; role?: string | null; financeLead?: boolean }): { title: string; role: string | null } {
  const title = memberTitle(member);
  const role = member.role ? roleLabel(member.role) : null;
  return { title, role: role === null || role.toLowerCase() === title.toLowerCase() ? null : role };
}

/** The words that name a role. A person cannot give themselves one of these as a title; an owner can give anyone any. */
const ROLE_WORDS = new Set(['owner', 'approver', 'finance lead', 'staff', 'viewer', 'member', 'admin', 'administrator', 'checker', 'maker']);

/** Is this title only the name of a role (whatever its case or spacing)? */
export function isRoleWord(title: string | null): boolean {
  return title !== null && ROLE_WORDS.has(title.trim().replace(/\s+/gu, ' ').toLowerCase());
}

/** Said when a person gives themselves the name of a role. */
export const TITLE_ROLE_REFUSAL = 'That is the name of a role, and your role already shows. Use words of your own, such as CFO or Operations, or leave it empty.';

/** Said under the title field, to the person who sets it and to an owner setting someone else's. */
export const TITLE_HELP = 'Plain words, up to 40 characters, for example CFO, Finance lead or R&D. It shows after the name, as in Aisha (CFO), and ends at the first link, number, symbol or the word “and”. Leave it empty to use the role.';

/**
 * What the page says after a save: the title the server kept, and, when the title was cut, the word it
 * stopped at and why. The person is never left to find out from the help text that part of it was dropped.
 */
export function savedTitleMessage(input: { whose: string; kept: string; leftOut?: string | null; roleWord: string }): string {
  if (input.kept === '') return `Title cleared. ${input.roleWord} is used instead.`;
  const base = `${input.whose} title is ${input.kept}.`;
  return input.leftOut ? `${base} “${input.leftOut}” and everything after it were left out, because a title is plain words.` : base;
}

/** Said when what was typed has no words in it (a link, markup, only numbers or symbols). */
export const TITLE_REFUSAL = 'A title is plain words, for example CFO or Operations. Links, markup and numbers on their own cannot be a title.';

/**
 * What was typed or sent as a title: nothing at all clears it (null), plain words are kept as
 * cleaned, and anything else (a number, an object, a link, markup) is refused rather than quietly
 * dropped, so a person is never told "saved" for something that was not.
 */
export function titleFromInput(raw: unknown): { ok: true; title: string | null; leftOut?: string } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, title: null };
  if (typeof raw !== 'string') return { ok: false, error: TITLE_REFUSAL };
  // Whitespace and invisible characters alone are empty, not a bad title.
  if (raw.slice(0, 4000).replace(/[\p{C}\p{Z}\s]/gu, '') === '') return { ok: true, title: null };
  const { title, stoppedAt } = plainTitleDetail(raw);
  if (title === null) return { ok: false, error: TITLE_REFUSAL };
  // `leftOut` is there only when something was: the word the title stopped at.
  return stoppedAt === null ? { ok: true, title } : { ok: true, title, leftOut: stoppedAt };
}
