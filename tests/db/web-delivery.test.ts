import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { loadConfig } from '../../src/config';
import { createProvider } from '../../src/mock/provider';
import { sendDue } from '../../src/engine/send';
import { mailboxAddress } from '../../src/delivery/rules';
import { deliveryDay } from '../../src/web/delivery';

// T22b (D71): deliveryDay on engine-made sends. 8 contacts, 3 mailboxes of 4 a day (+2 a day), a domain cap of 3,
// two sending hours on Tue 3 Nov 2026 (10:00 and 15:00 UTC).
const url = process.env.TEST_DATABASE_URL!;
const pool = getPool(url);
const providerPool = new pg.Pool({ connectionString: url });
const cfg = loadConfig({
  DATABASE_URL: url,
  BOUNCE_RATE: '0',
  REPLY_RATE: '0',
  DELIVERABILITY: 'on',
  MAILBOX_COUNT: '3',
  WARMUP_START: '4',
  WARMUP_STEP: '2',
  WARMUP_MAX: '10',
  SEND_WINDOW: '0-24',
  DOMAIN_DAILY_CAP: '3',
});
const delivery = cfg.delivery!;
const T = (iso: string) => new Date(iso);
const ids: Record<string, number> = {};

async function contact(key: string, tz: string, domain: string, due: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('Ann', 'Lee', $1, 'Acme', 'saas', 'CTO', 'tech', $2, 'tech:saas', 'new', 'first', $3, $4, $4)
     RETURNING id`,
    [`${key}@${domain}`, tz, T(due), T('2026-10-01T00:00:00Z')],
  );
  ids[key] = rows[0]!.id;
}

beforeAll(async () => {
  await resetDb(pool);
  await contact('c1', 'Europe/London', 'shared.example', '2026-11-03T08:00:00Z');
  await contact('c2', 'Europe/London', 'shared.example', '2026-11-03T08:00:00Z');
  await contact('c3', 'America/New_York', 'shared.example', '2026-11-03T08:00:00Z');
  await contact('c4', 'America/New_York', 'shared.example', '2026-11-03T08:00:00Z'); // 4th to shared: capped
  await contact('c5', 'Asia/Kolkata', 'kolkata.example', '2026-11-03T08:00:00Z');
  await contact('c6', 'Australia/Sydney', 'sydney-a.example', '2026-11-03T14:30:00Z');
  await contact('c7', 'Australia/Sydney', 'sydney-b.example', '2026-11-03T14:30:00Z');
  await contact('c8', 'Europe/Berlin', 'berlin.example', '2026-11-03T14:30:00Z');
  const deps = { provider: createProvider(providerPool, cfg), config: cfg };
  await sendDue(pool, T('2026-11-03T10:00:00Z'), deps); // c1, c2, c3, c5 from mailbox 1 (its 4 for the day)
  await sendDue(pool, T('2026-11-03T15:00:00Z'), deps); // c6, c7, c8 from mailbox 2; c4 still capped
  // A pause on mailbox 3 from 16:00 on 3 Nov to 16:00 on 6 Nov, written by hand.
  // deliveryDay must read the history (created_at + mailbox_pauses), not today's warmup_started_at.
  await pool.query('UPDATE mailboxes SET paused_until = $1, warmup_started_at = $1 WHERE id = 3', [
    T('2026-11-06T16:00:00Z'),
  ]);
  await pool.query(
    `INSERT INTO mailbox_pauses (mailbox_id, paused_at, resume_at, bounce_rate, sample) VALUES (3, $1, $2, 0.125, 64)`,
    [T('2026-11-03T16:00:00Z'), T('2026-11-06T16:00:00Z')],
  );
});

afterAll(async () => {
  await resetDb(pool);
  await providerPool.end();
  await closePool();
});

const zeroRegions = { americas: 0, europe: 0, asia: 0, australia: 0 };

describe('deliveryDay (D71)', () => {
  it('the sending day: totals, mailboxes, hours by region, domains, pauses', async () => {
    const d = await deliveryDay(pool, '2026-11-03', delivery);
    expect(d.enabled).toBe(true);
    expect(d.day).toBe('2026-11-03');
    expect(d.window).toEqual({ startHour: 0, endHour: 24 });
    expect(d.cap).toBe(3);
    expect(d.totals).toEqual({ emails: 7, bounced: 0, capacity: 12, mailboxes: 3, paused: 1 });
    expect(d.mailboxes).toEqual([
      { id: 1, address: mailboxAddress(1), limit: 4, emails: 4, bounced: 0, paused: false, pausedUntil: null },
      { id: 2, address: mailboxAddress(2), limit: 4, emails: 3, bounced: 0, paused: false, pausedUntil: null },
      {
        id: 3,
        address: mailboxAddress(3),
        limit: 4,
        emails: 0,
        bounced: 0,
        paused: true,
        pausedUntil: T('2026-11-06T16:00:00Z'),
      },
    ]);

    expect(d.hours).toHaveLength(24);
    expect(d.hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(d.hours[10]).toEqual({
      hour: 10,
      emails: 4,
      bounced: 0,
      regions: { americas: 1, europe: 2, asia: 1, australia: 0 },
    });
    expect(d.hours[15]).toEqual({
      hour: 15,
      emails: 3,
      bounced: 0,
      regions: { americas: 0, europe: 1, asia: 0, australia: 2 },
    });
    for (const h of d.hours.filter((x) => x.hour !== 10 && x.hour !== 15)) {
      expect(h).toEqual({ hour: h.hour, emails: 0, bounced: 0, regions: zeroRegions });
    }

    expect(d.domains).toEqual([
      { domain: 'shared.example', emails: 3 },
      { domain: 'berlin.example', emails: 1 },
      { domain: 'kolkata.example', emails: 1 },
      { domain: 'sydney-a.example', emails: 1 },
      { domain: 'sydney-b.example', emails: 1 },
    ]);
    expect(d.pauses).toEqual([
      {
        mailboxId: 3,
        address: mailboxAddress(3),
        pausedAt: T('2026-11-03T16:00:00Z'),
        resumeAt: T('2026-11-06T16:00:00Z'),
        bounceRate: 0.125,
        sample: 64,
      },
    ]);
  });

  it('the next day: limits grow with the warm-up, the pause still covers the end of the day, nothing sent', async () => {
    const d = await deliveryDay(pool, '2026-11-04', delivery);
    expect(d.totals).toEqual({ emails: 0, bounced: 0, capacity: 18, mailboxes: 3, paused: 1 });
    expect(d.mailboxes.map((m) => [m.id, m.limit, m.emails, m.paused])).toEqual([
      [1, 6, 0, false],
      [2, 6, 0, false],
      [3, 6, 0, true],
    ]);
    expect(d.hours.every((h) => h.emails === 0)).toBe(true);
    expect(d.domains).toEqual([]);
    expect(d.pauses).toHaveLength(1);
  });

  it('the restart day: the paused mailbox is back at the start of its warm-up', async () => {
    const d = await deliveryDay(pool, '2026-11-06', delivery);
    expect(d.mailboxes.map((m) => [m.id, m.limit, m.paused])).toEqual([
      [1, 10, false],
      [2, 10, false],
      [3, 4, false],
    ]);
    expect(d.totals.capacity).toBe(24);
    expect(d.totals.paused).toBe(0);
  });

  it('a day before the mailboxes existed has no mailboxes and no pauses', async () => {
    const d = await deliveryDay(pool, '2026-11-02', delivery);
    expect(d.mailboxes).toEqual([]);
    expect(d.pauses).toEqual([]);
    expect(d.totals).toEqual({ emails: 0, bounced: 0, capacity: 0, mailboxes: 0, paused: 0 });
    expect(d.hours).toHaveLength(24);
  });

  it('bounces are counted in the mailbox, the hour and the totals', async () => {
    await pool.query(`UPDATE sends SET outcome = 'bounced' WHERE contact_id = $1`, [ids.c5]);
    try {
      const d = await deliveryDay(pool, '2026-11-03', delivery);
      expect(d.totals).toMatchObject({ emails: 7, bounced: 1 });
      expect(d.mailboxes[0]).toMatchObject({ id: 1, emails: 4, bounced: 1 });
      expect(d.hours[10]).toMatchObject({ emails: 4, bounced: 1 });
    } finally {
      await pool.query(`UPDATE sends SET outcome = 'accepted' WHERE contact_id = $1`, [ids.c5]);
    }
  });

  it('with deliverability off it says so and returns nothing else', async () => {
    expect(await deliveryDay(pool, '2026-11-03', null)).toEqual({
      enabled: false,
      day: '2026-11-03',
      window: null,
      cap: null,
      totals: { emails: 0, bounced: 0, capacity: 0, mailboxes: 0, paused: 0 },
      mailboxes: [],
      hours: [],
      domains: [],
      pauses: [],
    });
  });
});
