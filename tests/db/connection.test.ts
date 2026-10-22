import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';

const url = process.env.TEST_DATABASE_URL;

describe('db connection', () => {
  afterAll(async () => {
    await closePool();
  });

  it('has TEST_DATABASE_URL set', () => {
    expect(url).toBeTruthy();
  });

  it('runs SELECT 1 against the test database', async () => {
    const pool = getPool(url!);
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
  });

  it('returns the same pool for the same URL', () => {
    expect(getPool(url!)).toBe(getPool(url!));
  });

  it('closePool can be called twice without throwing', async () => {
    await closePool();
    await expect(closePool()).resolves.toBeUndefined();
  });
});
