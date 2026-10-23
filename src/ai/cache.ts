import { createHash } from 'node:crypto';
import type { Queryable } from '../clock';

export type CacheKind = 'sequence' | 'classification';

// Replies that differ only in case and spacing share one cache entry.
export function normaliseReply(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

// No model in the key (D50): an answer saved from one model is found whichever model is first today.
// The NUL separator keeps ("v1", "2x") apart from ("v12", "x").
export function cacheKey(kind: CacheKind, promptVersion: string, input: string): string {
  return createHash('sha256').update([kind, promptVersion, input].join('\u0000')).digest('hex');
}

export async function cacheGet(db: Queryable, key: string): Promise<{ response: unknown; model: string } | null> {
  const { rows } = await db.query<{ response: unknown; model: string }>(
    'SELECT response, model FROM ai.llm_cache WHERE key = $1',
    [key],
  );
  return rows[0] ?? null;
}

// First answer wins; a parallel caller saving the same key changes nothing.
// The response is stringified here, because pg would turn a top-level array into a Postgres array, not jsonb.
export async function cacheSet(
  db: Queryable,
  key: string,
  kind: CacheKind,
  response: unknown,
  model: string,
): Promise<void> {
  await db.query(
    'INSERT INTO ai.llm_cache (key, kind, response, model) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
    [key, kind, JSON.stringify(response), model],
  );
}
