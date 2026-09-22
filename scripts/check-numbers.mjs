/**
 * Every number the site shows carries a source, a URL and a date, or the
 * build fails. Runs under `npm run lint`; content/sea-numbers.ts also refuses
 * to load in production with a bad entry, so this is the early, readable
 * version of the same refusal.
 *
 *   node --experimental-strip-types scripts/check-numbers.mjs
 */
import { SEA_NUMBERS, validateSeaNumbers } from '../content/sea-numbers.ts';

const problems = validateSeaNumbers(SEA_NUMBERS);
if (problems.length > 0) {
  console.error(`content/sea-numbers.ts: ${problems.length} number(s) without provenance:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const waiting = SEA_NUMBERS.filter((n) => n.status === 'needs_verification');
console.log(
  `Numbers carry provenance: ${SEA_NUMBERS.length} entries, ${SEA_NUMBERS.length - waiting.length} verified, ${waiting.length} waiting for verification (preview only).`,
);
