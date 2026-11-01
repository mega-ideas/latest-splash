/**
 * The title a person carries after their name in "Declined by Aisha (CFO)"
 * (v2 Phase 3, Sky's decision): the member's own title when one is set, else
 * the word for their role, and "Finance lead" for the person the owners
 * appointed to it. Pure and client-safe.
 *
 * A member has no title field today (a membership is a user, a business and a
 * role), so every title is the role word until one is added; `title` is read
 * first so adding the field changes nothing else.
 */
import { plainName } from './declined-by.ts';
import { FINANCE_LEAD_NAME } from './view.ts';
import { roleLabel } from '../wallet-page/members.ts';

/** The title as plain words, whatever the member has: their own, else "Finance lead", else the role's word ("Owner", "Staff", "Approver", "Viewer"; "Member" for none). */
export function memberTitle(member: { title?: unknown; role?: string | null; financeLead?: boolean }): string {
  return plainName(member.title) ?? (member.financeLead ? FINANCE_LEAD_NAME : roleLabel(member.role ?? ''));
}
