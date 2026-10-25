import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb } from '../../src/db/migrate';
import { getPool } from '../../src/db/pool';
import { loadWebFixture, type FixtureIds } from '../helpers/web-fixture';

// Same setup as web-routes.test.ts: point the handlers' runtime at the test database, AI off, before any import.
const url = process.env.TEST_DATABASE_URL!;
process.env.DATABASE_URL = url;
process.env.OPENROUTER_API_KEY = '';
process.env.SIM_START = '2026-11-02T09:00:00Z';

type Handler = (req: Request) => Promise<Response>;
let classifier: Handler;
let activity: Handler;
let stage: Handler;
let closeRuntime: (() => Promise<void>) | undefined;
let ids: FixtureIds;

const pool = getPool(url);
const get = (path: string) => new Request(`http://localhost${path}`);

async function json(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  classifier = (await import('../../app/api/classifier/route')).GET;
  activity = (await import('../../app/api/activity/route')).GET;
  stage = (await import('../../app/api/stage/route')).GET;
  const web = await import('../../src/web/runtime');
  closeRuntime = web.closeRuntime;
  // A guard before anything is wiped: the handlers must be talking to the test database.
  expect(web.getRuntime().config.databaseUrl).toBe(url);
  await resetDb(pool);
  ids = await loadWebFixture(pool);
});

afterAll(async () => {
  await resetDb(pool);
  await closeRuntime?.();
});

describe('the new route files', () => {
  it.each(['classifier', 'activity', 'stage'])('app/api/%s is dynamic and runs on Node', async (path) => {
    const mod = await import(`../../app/api/${path}/route`);
    expect(mod.dynamic).toBe('force-dynamic');
    expect(mod.runtime).toBe('nodejs');
  });
});

describe('GET /api/classifier', () => {
  it('returns the stats for labels written since SIM_START', async () => {
    const { status, body } = await json(await classifier(get('/api/classifier')));
    expect(status).toBe(200);
    expect(body.simStart).toBe('2026-11-02');
    // The fixture's two replies: F's at 2 Nov 00:00 is before SIM_START, B's on 3 Nov is after.
    expect(body.total).toBe(1);
    expect(body.excludedSeeded).toBe(1);
    expect(body.byLabel.interested).toBe(1);
  });
});

describe('GET /api/activity', () => {
  it('lists, filters and pages', async () => {
    const all = await json(await activity(get('/api/activity')));
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 50, total: 13 });
    expect(all.body.rows[0]).toMatchObject({ kind: 'deactivated', contactId: ids.G });
    const day = await json(await activity(get('/api/activity?day=2026-11-02&kind=bounced')));
    expect(day.body.rows.map((r: { contactId: number }) => r.contactId)).toEqual([ids.C]);
  });

  it.each(['kind=nope', 'page=abc', 'page=0', 'day=2026-13-01', 'day=2026-11-05'])('answers 400 for %s', async (q) => {
    expect((await activity(get(`/api/activity?${q}`))).status).toBe(400);
  });
});

describe('GET /api/stage', () => {
  it('takes a day and a status, and defaults the day to today', async () => {
    const one = await json(await stage(get('/api/stage?day=2026-11-02&status=first_sent')));
    expect(one.status).toBe(200);
    expect(one.body.total).toBe(2);
    const today = await json(await stage(get('/api/stage?status=deactivated')));
    expect(today.body).toMatchObject({ day: '2026-11-04', total: 1 });
    expect(today.body.rows[0].id).toBe(ids.G);
  });

  it.each(['', 'status=nope', 'status=new&page=0', 'status=new&day=2026-11-05'])('answers 400 for %j', async (q) => {
    expect((await stage(get(`/api/stage?${q}`))).status).toBe(400);
  });
});
