import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// Absolute path of src/db/migrations, wherever the process was started from.
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

// Applies every *.sql file in `dir` not yet recorded in schema_migrations, in file-name order.
// Each file runs in its own transaction together with its schema_migrations row, so a file that
// fails leaves nothing behind and is not recorded. Returns the names it applied.
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${file} failed: ${message}`, { cause: err });
    } finally {
      client.release();
    }
    applied.push(file);
  }
  return applied;
}

// Drops everything in the public schema and re-applies every migration.
// The ai schema (saved AI answers and the day's call count) is dropped too, unless keepAi (D52).
// With keepAi, migrate runs first, so 002 moves rows from an old-layout public schema into ai before the drop.
export async function resetDb(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
  opts: { keepAi?: boolean } = {},
): Promise<void> {
  if (opts.keepAi) await migrate(pool, dir);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  if (!opts.keepAi) await pool.query('DROP SCHEMA IF EXISTS ai CASCADE');
  await migrate(pool, dir);
}
