/** The intent id of one batch: made once for a sheet, and again whenever the sheet changes. Client-safe. */
export function newBatchKey(random: (bytes: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return `batch_${Array.from(random(12), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
