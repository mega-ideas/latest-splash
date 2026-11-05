/**
 * What the spending-rules area is showing, and what it says when something is
 * refused or cannot be read (v2 §4.2). One honest state at a time, and a
 * failure in the customer's words: never the server's own text when it names
 * an environment variable, never an empty list for a read that failed. Pure
 * and client-safe.
 */

export type RulesState = 'loading' | 'error' | 'staff_error' | 'no_policy' | 'no_staff' | 'empty' | 'list';

/**
 * Waiting is not failing, and a failure is not an empty list. An owner with no
 * one to give a rule to is told that, but only after the team was read and
 * found no one: a team still being read is loading, and one that could not be
 * read is an error with a way to try again, never "No staff yet". Rules whose
 * holders are gone are still listed so they can be taken back. Someone who is
 * not an owner never sees "no staff" and never waits for the team: only that
 * they have no rule.
 */
export function rulesState(input: {
  owner: boolean;
  loading: boolean;
  error: string | null;
  hasPolicy: boolean;
  staff: number;
  rules: number;
  staffLoading?: boolean;
  staffError?: string | null;
}): RulesState {
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (!input.hasPolicy) return 'no_policy';
  if (input.rules > 0) return 'list';
  if (input.owner && input.staffLoading) return 'loading';
  if (input.owner && input.staffError) return 'staff_error';
  if (input.owner && input.staff === 0) return 'no_staff';
  return 'empty';
}

/** What taking a rule back stops, what stays, and that it needs no waiting. */
export function revokeWords(name: string | null): { title: string; stops: string[]; stays: string[]; note: string } {
  const who = name ?? 'This person';
  return {
    title: name ? `Take back ${name}’s rule?` : 'Take back this rule?',
    stops: [
      `${who} can no longer pay anyone on their own.`,
      'Their allowance is revoked and they are removed from the spending policy.',
      'Their open payments stop at once.',
    ],
    stays: [
      'Payments already made stay on the record.',
      'Their later payments go to the owners. They can still ask the owners to pay for them; the owners pay from the wallet.',
      'You can give a new rule later.',
    ],
    note: 'Your own change takes effect at once, with no waiting period. The owners sign it on their own devices.',
  };
}

const NOT_OPEN = 'Spending rules are not open for your business yet. Nothing was changed. Your Splash contact will tell you when they are.';
const UNREACHABLE = 'Could not reach Splash. Check your connection; nothing was changed.';

/** A failed read of the rules, in words a customer can use. */
export function explainSpendFailure(status: number, text: string): string {
  if (status === 0) return UNREACHABLE;
  if (status === 503) return NOT_OPEN;
  if (status === 502) return 'Splash could not reach the chain to read your rules. Nothing was changed.';
  if (status >= 500 || !text.trim()) return 'The spending rules could not be read. Nothing was changed.';
  return text;
}

/** A refused request for a rule change, in words a customer can use. */
export function askFailureText(failure: { status: number; code?: string; error: string }, kind: 'give' | 'change' | 'revoke' | 'other'): string {
  void kind;
  if (failure.status === 0) return 'Could not reach Splash. Nothing was changed.';
  if (failure.code === 'request_open') return 'A request like this is already waiting for the owners’ signatures. Find it under Needs your signature at the top of this page, or let it expire.';
  if (failure.code === 'rule_exists') return 'This person already has a rule. Change it instead.';
  if (failure.status === 503) return NOT_OPEN;
  if (failure.status >= 500 || !failure.error.trim()) return 'That change was not started. Nothing was changed.';
  return failure.error;
}
