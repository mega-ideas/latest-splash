/**
 * Reading a request body with a ceiling, while it is read.
 *
 * `request.json()` buffers whatever arrives. A route that takes an uploaded
 * sheet cannot wait for the whole body to learn it was too large, and a
 * declared Content-Length is the client's word. This stops at the cap: a
 * length over it is refused before a byte is read, and a stream is cancelled
 * the moment it passes it.
 */
export type CappedText = { ok: true; text: string } | { ok: false; reason: 'too_large' };

export async function readCappedText(request: Request, maxBytes: number): Promise<CappedText> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
