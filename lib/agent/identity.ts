/**
 * The agent's two names, and why they must never be confused.
 *
 * `AGENT_ACTOR_ID` is the persisted identity of the agent. It NEVER changes,
 * whatever the product calls the assistant. Proposal rows, approval events and
 * audit records already carry this exact string, and the security rules that
 * compare against it are load-bearing:
 *
 *   - the maker-checker exemption (lib/queue/proposal-state.ts,
 *     lib/queue/approval-queue.ts, app/api/proposals/[id]/submit): a HUMAN
 *     maker may not approve their own proposal; the agent's proposals are
 *     exempt because a human still has to approve them.
 *   - the signer rejection (lib/queue/proposal-state.ts,
 *     lib/safety/submit-guard.ts): anything signed by the agent's id is
 *     refused outright, which is what makes it impossible for the agent to
 *     become a signer.
 *
 * Renaming the stored value would silently disable both for existing records.
 * If a second actor id is ever introduced, the signer rejection must reject
 * BOTH — never one.
 *
 * `AGENT_DISPLAY_NAME` is what the product calls the assistant. Safe to
 * change — display only. It feeds DEFAULT_ASSISTANT_NAME and every
 * user-visible surface; nothing persisted compares against it.
 */
export const AGENT_ACTOR_ID = 'OXWAL' as const;

export const AGENT_DISPLAY_NAME = 'Zeke';
