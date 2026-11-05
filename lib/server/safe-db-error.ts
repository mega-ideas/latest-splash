/**
 * A label for a database error that is safe to log.
 *
 * drizzle-orm wraps a failed query in DrizzleQueryError, whose message is
 * "Failed query: <sql>\nparams: <params>". The params are whatever the query
 * bound: an email, a user id, an amount. Logging `error.message` therefore
 * logs personal data whenever Postgres times out or drops a connection (v2
 * brief §0.7, review C4). This gives the error's class and, when the driver
 * set one, its SQLSTATE or Node error code (for example 57014, ECONNREFUSED),
 * which is what an operator needs to tell a timeout from a refused
 * connection, and never the message, the query or the params.
 */
export function safeDbErrorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = errorCode(error) ?? errorCode((error as { cause?: unknown }).cause);
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  return code ? `${name} (${code})` : name;
}

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const code = (value as { code?: unknown }).code;
  // SQLSTATEs are five characters; Node's are upper-case words. Anything else
  // is not a code and is not logged.
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null;
}
