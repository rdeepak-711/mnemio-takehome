import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb } from '../../src/db/migrate';
import { getPool } from '../../src/db/pool';
import { loadWebFixture, type FixtureIds } from '../helpers/web-fixture';

// The route handlers build their runtime from process.env (src/web/runtime.ts). Point it at the test database and
// switch the AI off before any handler runs. Modules are imported inside beforeAll so nothing reads env earlier.
const url = process.env.TEST_DATABASE_URL!;
process.env.DATABASE_URL = url;
process.env.OPENROUTER_API_KEY = '';
process.env.CONTACT_COUNT = '200';
process.env.SEED = '42';
process.env.SIM_START = '2026-11-02T09:00:00Z';

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
let summary: Handler;
let timeline: Handler;
let journey: Handler;
let contacts: Handler;
let contactById: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let advance: Handler;
let reset: Handler;
let closeRuntime: (() => Promise<void>) | undefined;
let ids: FixtureIds;

const pool = getPool(url);
const get = (path: string) => new Request(`http://localhost${path}`);
const post = (path: string, body: string) =>
  new Request(`http://localhost${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
const byId = (id: string) => contactById(get(`/api/contacts/${id}`), { params: Promise.resolve({ id }) });

async function json(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  summary = (await import('../../app/api/summary/route')).GET;
  timeline = (await import('../../app/api/timeline/route')).GET;
  journey = (await import('../../app/api/journey/route')).GET;
  contacts = (await import('../../app/api/contacts/route')).GET;
  contactById = (await import('../../app/api/contacts/[id]/route')).GET;
  advance = (await import('../../app/api/sim/advance/route')).POST;
  reset = (await import('../../app/api/sim/reset/route')).POST;
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

describe('every route file', () => {
  it.each(['summary', 'timeline', 'journey', 'contacts', 'contacts/[id]', 'sim/advance', 'sim/reset'])(
    'app/api/%s is dynamic and runs on Node',
    async (path) => {
      const mod = await import(`../../app/api/${path}/route`);
      expect(mod.dynamic).toBe('force-dynamic');
      expect(mod.runtime).toBe('nodejs');
    },
  );
});

describe('GET /api/summary', () => {
  it('defaults to the sim clock day and returns the slider range', async () => {
    const { status, body } = await json(await summary(get('/api/summary')));
    expect(status).toBe(200);
    expect(body.days).toEqual({ first: '2026-10-30', today: '2026-11-04', simStart: '2026-11-02' });
    expect(body.summary.day).toBe('2026-11-04');
    expect(body.summary.total).toBe(7);
  });

  it('takes a day', async () => {
    const { body } = await json(await summary(get('/api/summary?day=2026-11-01')));
    expect(body.summary).toMatchObject({ day: '2026-11-01', phase: 'history', total: 6 });
  });

  it('answers 400 for a bad day and for a future day', async () => {
    const bad = await json(await summary(get('/api/summary?day=2026-13-01')));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/day/);
    const future = await json(await summary(get('/api/summary?day=2026-11-05')));
    expect(future.status).toBe(400);
    expect(future.body.error).toMatch(/future/);
  });
});

describe('GET /api/timeline and /api/journey', () => {
  it('timeline has one entry per day', async () => {
    const { status, body } = await json(await timeline(get('/api/timeline')));
    expect(status).toBe(200);
    expect(body.days.map((d: { day: string }) => d.day)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('journey takes a day and defaults to today', async () => {
    expect((await json(await journey(get('/api/journey?day=2026-10-30')))).body).toEqual({
      day: '2026-10-30',
      moves: [{ from: 'new', to: 'first_sent', count: 2 }],
    });
    const today = (await json(await journey(get('/api/journey')))).body;
    expect(today.day).toBe('2026-11-04');
    expect(today.moves).toHaveLength(2);
    expect((await journey(get('/api/journey?day=nope'))).status).toBe(400);
  });
});

describe('GET /api/contacts', () => {
  it('lists, searches and filters', async () => {
    const all = await json(await contacts(get('/api/contacts')));
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 50, total: 7 });
    const found = await json(await contacts(get('/api/contacts?q=company%20b&status=replied')));
    expect(found.body.rows.map((r: { id: number }) => r.id)).toEqual([ids.B]);
  });

  it.each(['page=abc', 'page=1.5', 'page=0', 'status=bogus'])('answers 400 for %s', async (query) => {
    const { status, body } = await json(await contacts(get(`/api/contacts?${query}`)));
    expect(status).toBe(400);
    expect(typeof body.error).toBe('string');
  });
});

describe('GET /api/contacts/[id]', () => {
  it('returns the detail', async () => {
    const { status, body } = await json(await byId(String(ids.G)));
    expect(status).toBe(200);
    expect(body.contact.email).toBe('g@fixture.example');
    expect(body.sends).toHaveLength(4);
  });

  it('answers 404 for an unknown contact and 400 for a non-integer id', async () => {
    expect(await json(await byId('999999'))).toEqual({ status: 404, body: { error: 'contact not found' } });
    expect((await byId('abc')).status).toBe(400);
    expect((await byId('1.5')).status).toBe(400);
  });
});

describe('POST /api/sim/advance and /api/sim/reset', () => {
  it('refuses a missing, bad or out-of-range body with 400', async () => {
    for (const body of ['', 'not json', '{}', '{"days":0}', '{"days":"7"}', '{"days":366}']) {
      expect((await advance(post('/api/sim/advance', body))).status, body).toBe(400);
    }
  });

  it('advances the clock and returns each day and the invariant check', async () => {
    const { status, body } = await json(await advance(post('/api/sim/advance', '{"days":1}')));
    expect(status).toBe(200);
    expect(body.days).toHaveLength(1);
    expect(Array.isArray(body.violations)).toBe(true);
    expect((await json(await summary(get('/api/summary')))).body.days.today).toBe('2026-11-05');
  });

  it('answers 409 to a second request while one is running', async () => {
    const results = await Promise.all([
      advance(post('/api/sim/advance', '{"days":1}')),
      advance(post('/api/sim/advance', '{"days":1}')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await json(await summary(get('/api/summary')))).body.days.today).toBe('2026-11-06');
  });

  it('reset reseeds CONTACT_COUNT contacts', async () => {
    const { status, body } = await json(await reset(post('/api/sim/reset', '')));
    expect(status).toBe(200);
    expect(body).toEqual({ contacts: 200 });
    expect((await json(await contacts(get('/api/contacts')))).body.total).toBe(200);
  });
});
