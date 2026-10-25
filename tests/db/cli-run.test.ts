import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig } from '../../src/config';
import { getNow } from '../../src/clock';
import { seed } from '../../src/seed/seed';

const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const root = join(import.meta.dirname, '..', '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const DAY_MS = 24 * 60 * 60 * 1000;
const cfg = loadConfig({ DATABASE_URL: url, SEED: '42', CONTACT_COUNT: '200' });

type Run = { code: number; stdout: string; stderr: string };

// Runs src/main.ts as `npm run …` would, against the test database and with no OpenRouter key.
async function cli(...args: string[]): Promise<Run> {
  const env = { ...process.env, DATABASE_URL: url, OPENROUTER_API_KEY: '' };
  try {
    const { stdout, stderr } = await promisify(execFile)(tsx, ['src/main.ts', ...args], { cwd: root, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const dayLines = (out: string) => out.split('\n').filter((line) => /^\d{4}-\d{2}-\d{2} {2}delivered /.test(line));

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('the command line', () => {
  it('has the three npm scripts', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.tick).toBe('tsx src/main.ts run');
    expect(pkg.scripts.advance).toBe('tsx src/main.ts advance');
    expect(pkg.scripts['ai:warm']).toBe('tsx src/main.ts ai:warm');
  });

  it('advance --days 2 prints two day lines, checks the invariants and moves the clock 2 days', async () => {
    await seed(pool, cfg);
    const run = await cli('advance', '--days', '2');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(dayLines(run.stdout)).toHaveLength(2);
    expect(run.stdout).toMatch(/AI calls today \d+\/\d+/);
    expect(run.stdout).toContain('invariants: ok');
    expect((await getNow(pool)).getTime()).toBe(cfg.simStart.getTime() + 2 * DAY_MS);
  }, 30_000);

  it('run ticks once without moving the clock', async () => {
    await seed(pool, cfg);
    const run = await cli('run');
    expect(run.code).toBe(0);
    expect(dayLines(run.stdout)).toHaveLength(1);
    expect(run.stdout).toContain('invariants: ok');
    expect((await getNow(pool)).getTime()).toBe(cfg.simStart.getTime());
  }, 30_000);

  it('advance --days 0 exits 1 with the usage and leaves the clock alone', async () => {
    await seed(pool, cfg);
    const run = await cli('advance', '--days', '0');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('usage:');
    expect((await getNow(pool)).getTime()).toBe(cfg.simStart.getTime());
  }, 30_000);

  it('run on an unseeded database exits 1 and says to seed', async () => {
    const run = await cli('run');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('npm run seed');
  }, 30_000);

  it('ai:warm with no key reports all 20 segments as fallback', async () => {
    const run = await cli('ai:warm');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('no OPENROUTER_API_KEY');
    expect(run.stdout.split('\n').filter((line) => /^\S+:\S+ {2}fallback$/.test(line))).toHaveLength(20);
    expect(run.stdout).toContain('warmed 20 segments: 0 ai, 0 cache, 20 fallback');
  }, 30_000);
});
