import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPool, closePool } from '../../src/db/pool';
import { migrate, resetDb, MIGRATIONS_DIR } from '../../src/db/migrate';

const pool = getPool(process.env.TEST_DATABASE_URL!);

async function n(sql: string): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT (${sql})::int AS n`)).rows[0]!.n;
}

async function saveAiRows() {
  await pool.query(
    `INSERT INTO ai.llm_cache (key, kind, response, model) VALUES ('k1', 'sequence', '{"a":1}', 'vendor/alpha:free')`,
  );
  await pool.query(`INSERT INTO ai.llm_usage (day, calls) VALUES ('2026-10-23', 7)`);
}

async function addContact() {
  await pool.query(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', 'ann@acme.example', 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas',
       'new', 'first', now(), now(), now())`,
  );
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('the AI tables live in their own schema', () => {
  it('ai.llm_cache and ai.llm_usage exist, and public has no llm tables', async () => {
    const { rows } = await pool.query<{ s: string; t: string }>(
      `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
        WHERE table_name IN ('llm_cache', 'llm_usage') ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { s: 'ai', t: 'llm_cache' },
      { s: 'ai', t: 'llm_usage' },
    ]);
  });

  it('keeps the same rules: kind is sequence or classification, calls never below 0', async () => {
    await expect(
      pool.query(`INSERT INTO ai.llm_cache (key, kind, response, model) VALUES ('k', 'other', '{}', 'm')`),
    ).rejects.toThrow();
    await expect(pool.query(`INSERT INTO ai.llm_usage (day, calls) VALUES ('2026-10-23', -1)`)).rejects.toThrow();
  });
});

describe('resetDb', () => {
  it('with keepAi, the business data is wiped but saved AI answers and the call count stay', async () => {
    await saveAiRows();
    await addContact();
    await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
    expect(await n('SELECT count(*) FROM contacts')).toBe(0);
    expect(await n('SELECT count(*) FROM ai.llm_cache')).toBe(1);
    expect(await n(`SELECT calls FROM ai.llm_usage WHERE day = '2026-10-23'`)).toBe(7);
  });

  it('with keepAi twice in a row, still kept', async () => {
    await saveAiRows();
    await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
    await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
    expect(await n('SELECT count(*) FROM ai.llm_cache')).toBe(1);
    expect(await n(`SELECT calls FROM ai.llm_usage WHERE day = '2026-10-23'`)).toBe(7);
  });

  it('by default it wipes the AI tables too (tests start from nothing)', async () => {
    await saveAiRows();
    await resetDb(pool);
    expect(await n('SELECT count(*) FROM ai.llm_cache')).toBe(0);
    expect(await n('SELECT count(*) FROM ai.llm_usage')).toBe(0);
  });
});

describe('upgrading a database made before the ai schema', () => {
  it('rows saved in public.llm_cache and public.llm_usage move to the ai schema', async () => {
    // Build the old layout: only the first migration, with AI rows in public.
    await pool.query('DROP SCHEMA IF EXISTS ai CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dir = await mkdtemp(join(tmpdir(), 'mnemio-001-'));
    await copyFile(join(MIGRATIONS_DIR, '001_init.sql'), join(dir, '001_init.sql'));
    await migrate(pool, dir);
    await pool.query(
      `INSERT INTO public.llm_cache (key, kind, response, model) VALUES ('old', 'classification', '{"label":"interested"}', 'm:free')`,
    );
    await pool.query(`INSERT INTO public.llm_usage (day, calls) VALUES ('2026-10-23', 3)`);

    expect(await migrate(pool)).toEqual(['002_ai_schema.sql']);
    expect(await n(`SELECT count(*) FROM ai.llm_cache WHERE key = 'old'`)).toBe(1);
    expect(await n(`SELECT calls FROM ai.llm_usage WHERE day = '2026-10-23'`)).toBe(3);
    expect(
      await n(
        `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'llm_%'`,
      ),
    ).toBe(0);
  });

  it('a kept count is never lowered when the old rows are copied in again', async () => {
    await pool.query(`INSERT INTO ai.llm_usage (day, calls) VALUES ('2026-10-23', 9)`);
    await resetDb(pool, MIGRATIONS_DIR, { keepAi: true });
    expect(await n(`SELECT calls FROM ai.llm_usage WHERE day = '2026-10-23'`)).toBe(9);
  });
});
