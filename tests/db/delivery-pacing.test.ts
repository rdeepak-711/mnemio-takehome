import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { createProvider } from '../../src/mock/provider';
import { sendDue } from '../../src/engine/send';
import { checkInvariants } from '../../src/invariants';

// T22c: hourly pacing (D72). London contacts, a 9–17 window, so a day's limit is spread over 8 hours.
const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
const NOW = new Date('2026-11-02T09:00:00Z'); // Monday 09:00 in London
const HOUR_MS = 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: url,
    BOUNCE_RATE: '0',
    REPLY_RATE: '0',
    DELIVERABILITY: 'on',
    SEND_PACING: 'on',
    MAILBOX_COUNT: '1',
    WARMUP_START: '80',
    WARMUP_STEP: '0',
    WARMUP_MAX: '80',
    SEND_WINDOW: '9-17',
    DOMAIN_DAILY_CAP: '1000',
    ...overrides,
  });
}

let n = 0;
async function contacts(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    n += 1;
    await pool.query(
      `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
         status, next_action, next_action_at, created_at, updated_at)
       VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', 'Europe/London', 'tech:saas', 'new', 'first', $2, $2, $2)`,
      [`p${n}@co${n}.example`, at(-HOUR_MS)],
    );
  }
}

const send = (cfg: Config, t: Date) => sendDue(pool, t, { provider: createProvider(providerPool, cfg), config: cfg });

async function perMailbox(): Promise<Record<number, number>> {
  const { rows } = await pool.query<{ id: number; n: number }>(
    'SELECT mailbox_id AS id, count(*)::int AS n FROM sends GROUP BY 1 ORDER BY 1',
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

const total = async () => Object.values(await perMailbox()).reduce((a, b) => a + b, 0);

beforeEach(async () => {
  await resetDb(pool);
  n = 0;
});

afterAll(async () => {
  await providerPool.end();
  await closePool();
});

describe('hourly pacing (D72)', () => {
  it('80 a day in a 9–17 window is 10 an hour, counted per UTC hour', async () => {
    const cfg = config();
    await contacts(30);
    await send(cfg, NOW);
    expect(await total()).toBe(10);
    await send(cfg, at(HOUR_MS / 2)); // same hour
    expect(await total()).toBe(10);
    await send(cfg, at(HOUR_MS));
    expect(await total()).toBe(20);
    await send(cfg, at(2 * HOUR_MS));
    expect(await total()).toBe(30);
    expect(await checkInvariants(pool, 50, cfg)).toEqual([]);
  });

  it('a mailbox that used its hour stops taking new contacts, so they spread over mailboxes', async () => {
    const cfg = config({ MAILBOX_COUNT: '3' });
    await contacts(25);
    await send(cfg, NOW);
    expect(await perMailbox()).toEqual({ 1: 10, 2: 10, 3: 5 });
  });

  it('the daily limit still applies on top: 12 a day is 2 an hour and stops at 12', async () => {
    const cfg = config({ WARMUP_START: '12', WARMUP_MAX: '12' });
    await contacts(40);
    const counts: number[] = [];
    for (let h = 0; h < 8; h++) {
      await send(cfg, at(h * HOUR_MS));
      counts.push(await total());
    }
    expect(counts).toEqual([2, 4, 6, 8, 10, 12, 12, 12]);
  });

  it('with SEND_PACING=off the whole daily limit can go in one hour', async () => {
    const cfg = config({ SEND_PACING: 'off' });
    await contacts(30);
    await send(cfg, NOW);
    expect(await total()).toBe(30);
  });
});

describe('invariant 13 (D72)', () => {
  it('reports a mailbox over its hourly share, only when pacing is on', async () => {
    await contacts(10);
    await send(config(), NOW); // 10 in the 09:00 hour, the most allowed at 80 a day
    expect(await checkInvariants(pool, 50, config())).toEqual([]);

    // Checked against 40 a day (5 an hour), the same 10 sends are over the hourly share but not the daily limit.
    const stricter = config({ WARMUP_START: '40', WARMUP_MAX: '40' });
    const violations = await checkInvariants(pool, 50, stricter);
    expect(violations.map((v) => v.invariant)).toEqual([13]);
    expect(violations[0]!.contactId).toBeNull();
    expect(violations[0]!.message).toMatch(/outreach-01@mail1\.mnemio\.example/);

    expect(
      await checkInvariants(pool, 50, config({ WARMUP_START: '40', WARMUP_MAX: '40', SEND_PACING: 'off' })),
    ).toEqual([]);
  });
});
