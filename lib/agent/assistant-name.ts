/**
 * Letting someone rename the assistant.
 *
 * ─── Why this is stored in MemWal and not a settings column ─────────────────
 *
 * MemWal is free-text semantic memory: `rememberFact(text)` and
 * `recallMemories(query)`. There is no key/value get and set, and the namespace
 * is process-wide rather than per user — so a name stored there is recalled by
 * SEARCHING for it, and a search can return somebody else's.
 *
 * That is a real constraint and it shapes what is safe to put there. A
 * preferred name is: cosmetic, non-authoritative, and harmless to get wrong —
 * the worst outcome is the assistant answering to the wrong nickname. Nothing
 * that decides access, money or identity belongs in a store with those
 * properties, and none of it is here.
 *
 * The fact is written with the org id inside the sentence so recall can be
 * filtered rather than trusted, and the read is anchored to the same org.
 */
import { DEFAULT_ASSISTANT_NAME } from '@/lib/agent/assistant-name-shared';

export { DEFAULT_ASSISTANT_NAME };

/** The phrase a stored name is wrapped in, so recall can find and parse it. */
const MARKER = 'Preferred assistant name';

/**
 * Names people may actually choose.
 *
 * Letters, digits, spaces and a few joiners, two to twenty-four characters. The
 * limit is not decoration: this string is interpolated into the system prompt,
 * and a "name" containing instructions is a prompt-injection vector aimed at
 * the assistant's own persona. Length and character class remove it.
 */
export function isUsableName(candidate: string): boolean {
  const name = candidate.trim();
  if (name.length < 2 || name.length > 24) return false;
  return /^[\p{L}\p{N} ._'-]+$/u.test(name);
}

export function sanitiseName(candidate: string): string | null {
  const name = candidate.trim().replace(/\s+/g, ' ');
  return isUsableName(name) ? name : null;
}

/** Remember what this workspace wants the assistant called. */
export async function rememberAssistantName(input: unknown): Promise<{
  ok: boolean;
  name?: string;
  message: string;
}> {
  const { orgId, name } = (input ?? {}) as { orgId?: string; name?: string };
  if (!orgId || !name) return { ok: false, message: 'A name is required.' };

  const clean = sanitiseName(name);
  if (!clean) {
    return {
      ok: false,
      message:
        'That name will not work — it needs to be 2 to 24 characters, letters and numbers only. ' +
        'It goes into how I introduce myself, so it has to be a name rather than an instruction.',
    };
  }

  try {
    const { rememberFact } = await import('@/lib/server/memwal');
    await rememberFact(`${MARKER} for org ${orgId} is "${clean}".`);
    return { ok: true, name: clean, message: `Noted — I will answer to ${clean} from now on.` };
  } catch {
    // Cosmetic. A memory that did not save is not worth failing a conversation
    // over, and saying so is better than pretending it stuck.
    return {
      ok: false,
      message: `I could not save that just now, so I will still answer to ${DEFAULT_ASSISTANT_NAME}.`,
    };
  }
}

/**
 * What this workspace calls the assistant.
 *
 * Falls back to the default on anything unexpected. A recall that returns
 * another org's memory is filtered out by the org id in the sentence; a recall
 * that returns nothing usable simply means the default name.
 */
export async function recallAssistantName(orgId: string): Promise<string> {
  // Without an org there is nothing to anchor recall to, and an empty id would
  // turn the `org ${orgId}` filter below into a substring that matches every
  // org's memory — one workspace's chosen name answering in another's chat.
  if (!orgId.trim()) return DEFAULT_ASSISTANT_NAME;

  try {
    const { recallMemories } = await import('@/lib/server/memwal');
    const memories = await recallMemories(`${MARKER} for org ${orgId}`, 5);
    for (const memory of memories) {
      const text = typeof memory === 'string' ? memory : memory.text;
      if (!text.includes(`org ${orgId}`)) continue;
      const match = /is "([^"]+)"/.exec(text);
      const candidate = match?.[1] ? sanitiseName(match[1]) : null;
      if (candidate) return candidate;
    }
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_ASSISTANT_NAME;
}
