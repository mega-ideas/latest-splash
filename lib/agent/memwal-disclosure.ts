/**
 * What the Zeke page's "What MemWal stores" card says, tied to the code that
 * writes it (v2 brief 5.3).
 *
 * A privacy statement has to match the data flow, so each "Stored" line names
 * the one file that writes that memory with `rememberForOrg`, and
 * tests/zeke-desk-review.test.mjs walks lib/, app/ and components/ for every
 * call: a new writer that is not on this list fails the build, and so does a
 * line here whose writer writes nothing.
 *
 * The demo workspace's seeded habits ("Batches on Friday") are written only
 * for the demo org, so they are not a statement about anyone else's data.
 */

export type MemWalStoredItem = { label: string; writer: string };

export const MEMWAL_STORED: readonly MemWalStoredItem[] = [
  { label: 'What you call this assistant', writer: 'lib/agent/assistant-name.ts' },
  { label: 'Invoice vendor names and the currency they settle in', writer: 'lib/server/copilot.ts' },
];

export const MEMWAL_NEVER_STORED: readonly string[] = [
  'Invoice files, amounts and line items',
  'Recipient bank details',
  'Account numbers',
  'KYB documents',
];

/** Seeds the demo workspace's habits; writes for DEMO_ORG_ID only. */
export const MEMWAL_DEMO_SEED_WRITER = 'lib/server/operations.ts';
