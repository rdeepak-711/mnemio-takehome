import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig, type Config } from '../../src/config';
import { getNow } from '../../src/clock';
import { createProvider } from '../../src/mock/provider';
import { checkInvariants } from '../../src/invariants';
import { seed } from '../../src/seed/seed';
import { advanceDays, type TickDeps, type TickSummary } from '../../src/engine/tick';
import { fullRun } from '../../src/full-run';
import { deliveryReport, formatDelivery } from '../../src/delivery/report';

// T22: a day is 24 hourly ticks with deliverability on (D65), and the whole run keeps invariants 1–12.
const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
const DAY_MS = 24 * 60 * 60 * 1000;

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, SEED: '42', CONTACT_COUNT: '500', DELIVERABILITY: 'on', ...overrides });
}

function deps(cfg: Config): TickDeps {
  return { pool, provider: createProvider(providerPool, cfg), config: cfg, ai: null };
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await providerPool.end();
  await closePool();
});

describe('advanceDays with deliverability on (D65)', () => {
  it('runs hourly ticks but reports one summary per day', async () => {
    const cfg = config();
    await seed(pool, cfg);
    const seen: TickSummary[] = [];
    const days = await advanceDays(deps(cfg), 2, (s) => seen.push(s));

    expect(days).toHaveLength(2);
    expect(seen).toHaveLength(2);
    expect(days.map((d) => d.now)).toEqual([
      new Date(cfg.simStart.getTime() + DAY_MS),
      new Date(cfg.simStart.getTime() + 2 * DAY_MS),
    ]);
    expect(await getNow(pool)).toEqual(new Date(cfg.simStart.getTime() + 2 * DAY_MS));

    // Sends happen at several hours of the day, not once at the tick hour.
    const hours = await pool.query<{ n: number }>(
      `SELECT count(DISTINCT sent_at)::int AS n FROM sends WHERE mailbox_id IS NOT NULL`,
    );
    expect(hours.rows[0]!.n).toBeGreaterThan(4);

    // Each day's summary is the sum of its 24 ticks.
    const perDay = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sends
        WHERE mailbox_id IS NOT NULL AND outcome = 'accepted' AND sent_at > $1 AND sent_at <= $2`,
      [cfg.simStart, days[0]!.now],
    );
    expect(days[0]!.sent.sent).toBe(perDay.rows[0]!.n);
    expect(await checkInvariants(pool, 50, cfg)).toEqual([]);
  }, 120_000);

  it('with DELIVERABILITY=off a day is still one tick at the tick hour', async () => {
    const cfg = config({ DELIVERABILITY: 'off' });
    await seed(pool, cfg);
    await advanceDays(deps(cfg), 1);
    const { rows } = await pool.query<{ at: Date }>('SELECT DISTINCT sent_at AS at FROM sends WHERE sent_at > $1', [
      cfg.simStart,
    ]);
    expect(rows.map((r) => r.at)).toEqual([new Date(cfg.simStart.getTime() + DAY_MS)]);
  });

  it('30 days on 500 contacts keep invariants 1–12, with real caps binding', async () => {
    // Small mailboxes so the warm-up and the domain cap actually hold sends back.
    const cfg = config({
      MAILBOX_COUNT: '3',
      WARMUP_START: '10',
      WARMUP_STEP: '5',
      WARMUP_MAX: '30',
      DOMAIN_DAILY_CAP: '2',
    });
    await seed(pool, cfg);
    await advanceDays(deps(cfg), 30);
    expect(await checkInvariants(pool, 50, cfg)).toEqual([]);
    const most = await pool.query<{ n: number }>(
      `SELECT max(n)::int AS n FROM (
         SELECT count(*) AS n FROM sends WHERE mailbox_id IS NOT NULL
          GROUP BY mailbox_id, (sent_at AT TIME ZONE 'UTC')::date) x`,
    );
    expect(most.rows[0]!.n).toBe(30); // some day reached the full limit
  }, 300_000);
});

describe('the full run with deliverability on', () => {
  it('finishes on 300 contacts with no violations of 1–12', async () => {
    const cfg = config({ CONTACT_COUNT: '300' });
    const result = await fullRun(deps(cfg));
    expect(result.finished).toBe(true);
    expect(result.violations).toEqual([]);
  }, 300_000);
});

describe('deliveryReport (T22)', () => {
  it('counts mailboxes, pauses, today and capacity', async () => {
    const cfg = config({ MAILBOX_COUNT: '4', WARMUP_START: '20', WARMUP_STEP: '10', WARMUP_MAX: '80' });
    await seed(pool, cfg);
    await advanceDays(deps(cfg), 1);
    const now = await getNow(pool);
    // Pause mailbox 4 by hand for the report.
    await pool.query(`UPDATE mailboxes SET paused_until = $1 WHERE id = 4`, [new Date(now.getTime() + DAY_MS)]);
    await pool.query(
      `INSERT INTO mailbox_pauses (mailbox_id, paused_at, resume_at, bounce_rate, sample) VALUES (4, $1, $2, 0.2, 60)`,
      [now, new Date(now.getTime() + DAY_MS)],
    );

    const r = await deliveryReport(pool, now, cfg.delivery!);
    const today = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sends WHERE mailbox_id IS NOT NULL
          AND (sent_at AT TIME ZONE 'UTC')::date = ($1::timestamptz AT TIME ZONE 'UTC')::date`,
      [now],
    );
    expect(r).toMatchObject({ mailboxes: 4, pausedNow: 1, pauses: 1, sentToday: today.rows[0]!.n });
    expect(r.capacityToday).toBe(3 * 30); // day 2 of the warm-up for the 3 not paused
    expect(formatDelivery(r, cfg.delivery!)).toMatch(/^Deliverability\n/);
    expect(formatDelivery(r, cfg.delivery!)).toContain('mailboxes: 4 (1 paused now, 1 pause so far)');
    expect(formatDelivery(r, cfg.delivery!)).toContain(`engine sends today: ${r.sentToday} of 90 capacity`);
  }, 120_000);
});
