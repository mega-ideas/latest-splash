/**
 * What a card that reads one address shows (v2 brief 5.9). A card whose address
 * is not known yet (Settings reads the team only once it knows the business has
 * a wallet) is waiting, not finished: it used to show an empty error alert for
 * the length of the first request. An answer belongs to the address it came
 * from, so a new address starts over. Pure and client-safe.
 */
export type LoadState<T> = { url: string | null; data: T | null; error: string | null };

export function loadView<T>(state: LoadState<T>, url: string | null): { data: T | null; error: string | null; loading: boolean } {
  if (url === null) return { data: null, error: null, loading: false };
  if (state.url !== url) return { data: null, error: null, loading: true };
  return { data: state.data, error: state.error, loading: false };
}
