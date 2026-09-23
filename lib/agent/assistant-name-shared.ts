/**
 * The name the assistant answers to when nobody has chosen one.
 *
 * Separate from `assistant-name.ts` so a client component can import the
 * default without pulling in MemWal and the server-only module graph behind it.
 */
export const DEFAULT_ASSISTANT_NAME = '0xWal';
