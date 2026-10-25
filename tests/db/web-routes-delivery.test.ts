import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb } from '../../src/db/migrate';
import { getPool } from '../../src/db/pool';
import { loadWebFixture } from '../helpers/web-fixture';

// T22b (D71). Same setup as web-routes.test.ts: the handlers' runtime on the test database, AI off, deliverability
// on (the default), before any import.
const url = process.env.TEST_DATABASE_URL!;
process.env.DATABASE_URL = url;
process.env.OPENROUTER_API_KEY = '';
process.env.SIM_START = '2026-11-02T09:00:00Z';
delete process.env.DELIVERABILITY;

type Handler = (req: Request) => Promise<Response>;
let delivery: Handler;
let closeRuntime: (() => Promise<void>) | undefined;

const pool = getPool(url);
const get = (path: string) => new Request(`http://localhost${path}`);

beforeAll(async () => {
  delivery = (await import('../../app/api/delivery/route')).GET;
  const web = await import('../../src/web/runtime');
  closeRuntime = web.closeRuntime;
  expect(web.getRuntime().config.databaseUrl).toBe(url);
  await resetDb(pool);
  await loadWebFixture(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closeRuntime?.();
});

describe('GET /api/delivery', () => {
  it('is dynamic and runs on Node', async () => {
    const mod = await import('../../app/api/delivery/route');
    expect(mod.dynamic).toBe('force-dynamic');
    expect(mod.runtime).toBe('nodejs');
  });

  it('answers for a given day, with the configured window and cap', async () => {
    const res = await delivery(get('/api/delivery?day=2026-11-03'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: true,
      day: '2026-11-03',
      window: { startHour: 9, endHour: 17 },
      cap: 10,
      mailboxes: [], // the fixture's sends are not engine sends, so no mailbox exists
      domains: [],
      pauses: [],
    });
    expect(body.hours).toHaveLength(24);
  });

  it('with no day it answers for the sim clock day', async () => {
    const { rows } = await pool.query<{ day: string }>(
      `SELECT to_char(now AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM sim_clock`,
    );
    const body = await (await delivery(get('/api/delivery'))).json();
    expect(body.day).toBe(rows[0]!.day);
  });

  it.each(['2026-13-01', 'yesterday', '2026-02-30'])('day=%s is a 400 naming day', async (day) => {
    const res = await delivery(get(`/api/delivery?day=${day}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/day/);
  });
});
