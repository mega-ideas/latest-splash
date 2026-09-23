/**
 * The terms version of record.
 *
 * One constant, one place: onboarding step 1 writes it into a
 * `terms_acceptances` row, and the money gate asks for a row at THIS value —
 * so editing the terms and bumping this string re-asks every workspace for
 * acceptance without touching a migration. Date-stamped rather than semver
 * because "what did they agree to, and when" is the only question a reviewer
 * ever asks of it.
 */
export const TERMS_VERSION = '2026-09-23';
