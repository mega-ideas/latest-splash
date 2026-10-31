/**
 * What a paste adds to a value, removed. A leaf module (no imports) so the
 * Send desk's address rule (lib/payments/stablecoin-lane.ts) and the Transfer
 * page's (lib/transfer/addresses.ts) share it without an import cycle.
 */

/** Zero-width and format characters a copy from a web page or an app can carry. */
const INVISIBLE = /[​-‍⁠﻿­]/g;

/**
 * What a paste adds, removed: every kind of white space (an address has none
 * inside it), invisible characters, and a pair of quotes or angle brackets
 * around the whole value. The `0X` some tools write becomes `0x`. Nothing
 * else is changed: a wrong character stays wrong.
 */
export function cleanPaste(raw: string): string {
  let value = String(raw ?? '').replace(INVISIBLE, '').replace(/\s+/g, '');
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['<', '>'], ['`', '`']];
  for (const [open, close] of pairs) {
    if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(1, -1);
      break;
    }
  }
  return value.replace(/^0X/, '0x');
}
