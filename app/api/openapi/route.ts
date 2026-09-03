import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';

/** Serves docs/openapi.yaml (the admin API contract) for the docs page. */
export async function GET() {
  const file = await readFile(path.join(process.cwd(), 'docs', 'openapi.yaml'), 'utf8');
  return new Response(file, {
    headers: { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
