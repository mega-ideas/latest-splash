/**
 * How a confidence score reaches the screen. Import-free, so client
 * components can use it.
 *
 * The rule is "state confidence honestly" (lib/agent/oxwal.ts). A producer
 * that measured nothing sets `confidence: null`, and this turns that into no
 * percentage rather than a made-up one. It formats what it is given; whether
 * a producer's number was measured is the producer's job. The copilot page used to show `?? 0.6` (60%) for any missing value,
 * and InvoiceLoop multiplied whatever arrived by 100, so a null would have
 * read "0%".
 */

/** A 0..1 score as a whole percentage, or null when there is no finite score. */
export function confidencePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}
