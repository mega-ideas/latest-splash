/**
 * One place where money-shaped values become JSON.
 *
 * Phase 2 moved every amount and rate to `bigint` — minor units and
 * scaled-integer rates, so nothing is ever a float. That was right, and it left
 * a sharp edge at the wire: `JSON.stringify` throws on a bigint rather than
 * coercing it, so any route that returned one 500'd with
 * "Do not know how to serialize a BigInt". `/api/quotes/peg-status` did exactly
 * that, in production code, and nothing caught it because no test called the
 * route and the type system is happy to hand a `Rate` to `NextResponse.json`.
 *
 * Bigints serialise as STRINGS, not numbers. A number would silently lose
 * precision above 2^53 — which for 6-decimal minor units is about 9 billion
 * dollars, close enough to real batch volumes to be a real risk, and a rounding
 * error that appears only above a threshold is the worst kind. A string is
 * exact, and a caller that wants arithmetic must opt into it by parsing.
 */

/**
 * Deep copy with every `bigint` replaced by its decimal string.
 *
 * Handles the shapes that actually appear in these payloads — plain objects,
 * arrays, dates — and leaves everything else alone. Not a general-purpose
 * serialiser: it is the money boundary, and it should stay small enough to read.
 */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = jsonSafe(item);
  }
  return out;
}

/**
 * `NextResponse.json` for payloads that may carry money.
 *
 * Deliberately not a wrapper every route must remember to use — routes that
 * never touch a bigint are fine as they are. Use it wherever a `Rate`, a minor
 * unit, or anything derived from `lib/money.ts` can reach the response.
 */
export function moneyJson(payload: unknown, init?: ResponseInit): Response {
  return Response.json(jsonSafe(payload), init);
}
