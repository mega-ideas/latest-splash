/**
 * Every migration on disk is listed in the journal.
 *
 * `drizzle-kit migrate` — the command `docs/W1-BACKUPS.md` tells an operator to
 * run against the production cluster — does not read the `drizzle/` directory.
 * It reads `drizzle/meta/_journal.json` and applies only what is listed there.
 *
 * The migrations in this repo are hand-written, because `drizzle-kit generate`
 * wants a TTY that CI and this environment do not have. A hand-written file
 * gets no journal entry unless somebody remembers to add one, and forgetting is
 * silent in the worst possible way: `drizzle-kit migrate` reports success with
 * nothing to do, the deploy goes green, and the application meets its first
 * request with `column "recipient_name" does not exist`.
 *
 * It is silent locally too, which is what makes it worth a guard rather than a
 * note. `scripts/dev-db.mjs` and `tests/transfer-persistence.test.mjs` both
 * apply migrations by listing the directory and sorting, so an unjournalled
 * migration passes every test on this machine and exists only here.
 *
 * The check is deliberately blunt: names, order, and nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'drizzle');
const JOURNAL = path.join(DIR, 'meta', '_journal.json');

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => f.replace(/\.sql$/, ''));

const journal = JSON.parse(readFileSync(JOURNAL, 'utf8'));
const entries = journal.entries ?? [];
const tags = entries.map((e) => e.tag);

const problems = [];

for (const file of files) {
  if (!tags.includes(file)) {
    problems.push(
      `drizzle/${file}.sql has no entry in meta/_journal.json — ` +
        '`drizzle-kit migrate` will skip it and report success.',
    );
  }
}

for (const tag of tags) {
  if (!files.includes(tag)) {
    problems.push(
      `meta/_journal.json lists "${tag}" but drizzle/${tag}.sql does not exist — ` +
        'a migrate against a fresh database will fail.',
    );
  }
}

// Order matters as much as presence: drizzle applies entries by `idx`, so a
// journal that lists a later migration before an earlier one runs them out of
// order against a fresh database.
const idxs = entries.map((e) => e.idx);
for (let i = 0; i < idxs.length; i += 1) {
  if (idxs[i] !== i) {
    problems.push(
      `meta/_journal.json entry ${i} ("${tags[i]}") has idx ${idxs[i]} — ` +
        'entries must be contiguous from 0, in file order.',
    );
    break;
  }
}

for (let i = 0; i < Math.min(tags.length, files.length); i += 1) {
  if (tags[i] !== files[i]) {
    problems.push(
      `meta/_journal.json applies "${tags[i]}" at position ${i}, but sorted by ` +
        `filename that position is "${files[i]}" — the journal and the directory disagree on order.`,
    );
    break;
  }
}

if (problems.length > 0) {
  console.error('Migration journal is out of step with drizzle/:\n');
  for (const problem of problems) console.error(`  ✖ ${problem}`);
  console.error(
    '\nAdd the missing entry by hand — {"idx", "version": "7", "when", "tag", "breakpoints": true} —\n' +
      'keeping idx contiguous and the tag equal to the filename without .sql.',
  );
  process.exit(1);
}

console.log(
  `Migration journal is complete: ${files.length} migration(s), all listed and in order.`,
);
