import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, closePool } from '../../src/db/pool';
import { resetDb } from '../../src/db/migrate';
import { setNow } from '../../src/clock';
import { report, formatReport } from '../../src/report';

const pool = getPool(process.env.TEST_DATABASE_URL!);
const SIM_START = new Date('2026-11-02T09:00:00Z');
const NOW = new Date('2026-11-05T09:00:00Z');
const OPTS = { simStart: SIM_START, dailyAiBudget: 45 };

let emailN = 0;
async function contact(status: string, nextAction: string | null = null, nextAt: string | null = null) {
  emailN += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contacts (first_name, last_name, email, company, industry, role, role_family, timezone, segment,
       status, next_action, next_action_at, created_at, updated_at)
     VALUES ('A', 'B', $1, 'Acme', 'saas', 'CTO', 'tech', 'UTC', 'tech:saas', $2, $3, $4, $5, $5) RETURNING id`,
    [`p${emailN}@acme.example`, status, nextAction, nextAt, SIM_START],
  );
  return rows[0]!.id;
}

async function send(contactId: number, step: string, outcome: string, source: string, sentAt: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
     VALUES ($1, $2, $1::int::text || ':' || $2, $3, 's', 'b', $4, $5) RETURNING id`,
    [contactId, step, outcome, source, sentAt],
  );
  return rows[0]!.id;
}

async function reply(
  contactId: number,
  sendId: number,
  trueLabel: string,
  label: string | null,
  source: string | null,
  classifiedAt: string | null,
) {
  await pool.query(
    `INSERT INTO replies (contact_id, send_id, body, received_at, true_label, label, label_source, classified_at)
     VALUES ($1, $2, 'text', $3, $4, $5, $6, $7)`,
    [contactId, sendId, classifiedAt ?? '2026-11-05T08:00:00Z', trueLabel, label, source, classifiedAt],
  );
}

async function inbox(key: string, deliverAt: string, delivered: boolean) {
  await pool.query(
    `INSERT INTO mock_inbox (idempotency_key, body, true_label, deliver_at, delivered) VALUES ($1, 'x', 'interested', $2, $3)`,
    [key, deliverAt, delivered],
  );
}

// The fixed dataset. Every number in the expected report below is worked out from it by hand.
async function fixture() {
  await setNow(pool, NOW);
  await contact('new', 'first', '2026-11-05T12:00:00Z'); // due later today
  await contact('new', 'first', '2026-11-04T09:00:00Z'); // overdue: still due today
  const c3 = await contact('first_sent', 'follow_up_1', '2026-11-06T08:00:00Z'); // due tomorrow
  const c4 = await contact('follow_up_3_sent', 'deactivate', '2026-11-05T10:00:00Z'); // never "due"
  const c5 = await contact('replied');
  const c6 = await contact('bounced');
  const c7 = await contact('deactivated');
  const c8 = await contact('unsubscribed');
  const c9 = await contact('first_sent', 'follow_up_1', '2026-11-08T09:00:00Z'); // not due yet

  const s3 = await send(c3, 'first', 'accepted', 'ai', '2026-11-05T08:00:00Z'); // today
  for (const [i, step] of ['first', 'follow_up_1', 'follow_up_2', 'follow_up_3'].entries()) {
    await send(c4, step, 'accepted', 'fallback', `2026-10-0${i + 1}T09:00:00Z`); // seeded, before start
  }
  const s5 = await send(c5, 'first', 'accepted', 'cache', '2026-11-03T09:00:00Z');
  await send(c6, 'first', 'bounced', 'fallback', '2026-11-05T07:00:00Z'); // today
  const s7 = await send(c7, 'first', 'accepted', 'fallback', '2026-10-10T09:00:00Z'); // seeded
  const s8 = await send(c8, 'first', 'accepted', 'fallback', '2026-11-03T10:00:00Z');
  const s9 = await send(c9, 'first', 'accepted', 'ai', '2026-11-04T23:59:59Z'); // yesterday, not today

  await reply(c5, s5, 'interested', 'interested', 'ai', '2026-11-04T09:00:00Z'); // ai, correct
  await reply(c8, s8, 'unsubscribe', 'unsubscribe', 'rule', '2026-11-04T10:00:00Z'); // rule, correct
  await reply(c9, s9, 'not_interested', 'interested', 'ai', '2026-11-05T09:00:00Z'); // ai, wrong
  await reply(c3, s3, 'out_of_office', 'needs_review', 'fallback', '2026-11-05T09:00:00Z'); // fallback
  await reply(c7, s7, 'interested', 'interested', 'ai', '2026-10-12T09:00:00Z'); // seeded: not in the classifier
  await reply(c9, s9, 'interested', null, null, null); // unlabelled

  await inbox(`${c7}:follow_up_1`, '2026-11-04T09:00:00Z', false); // no such send: orphaned
  await inbox(`${c9}:first`, '2026-11-06T09:00:00Z', false); // in the future: not orphaned
  await inbox(`${c3}:first`, '2026-11-04T09:00:00Z', true); // delivered: not orphaned
  await inbox(`${c5}:first`, '2026-11-04T09:00:00Z', false); // its send exists: waiting, not orphaned

  await pool.query(`INSERT INTO ai.llm_usage (day, calls) VALUES ((now() AT TIME ZONE 'UTC')::date, 7)`);
}

beforeEach(async () => {
  await resetDb(pool);
  emailN = 0;
});

afterAll(async () => {
  await resetDb(pool);
  await closePool();
});

describe('report', () => {
  it('works out every number from the fixed dataset', async () => {
    await fixture();
    expect(await report(pool, OPTS)).toEqual({
      now: NOW,
      statuses: {
        new: 2,
        first_sent: 2,
        follow_up_1_sent: 0,
        follow_up_2_sent: 0,
        follow_up_3_sent: 1,
        replied: 1,
        bounced: 1,
        unsubscribed: 1,
        deactivated: 1,
      },
      inSequence: 5,
      sentToday: 2,
      dueToday: 2,
      dueTomorrow: 1,
      replyRate: { count: 5, of: 6 },
      bounceRate: { count: 1, of: 10 },
      templateSources: { ai: 2, cache: 1, fallback: 2 },
      classifier: { rule: { labelled: 1, correct: 1 }, ai: { labelled: 2, correct: 1 }, fallback: 1 },
      needsReview: 1,
      unlabelled: 1,
      orphaned: 1,
      aiCalls: { today: 7, budget: 45 },
    });
  });

  it('writes nothing', async () => {
    await fixture();
    const count = async () =>
      (
        await pool.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM contacts) + (SELECT count(*) FROM sends) + (SELECT count(*) FROM replies)
                + (SELECT count(*) FROM events) + (SELECT count(*) FROM mock_inbox) AS n`,
        )
      ).rows[0]!.n;
    const before = await count();
    await report(pool, OPTS);
    expect(await count()).toBe(before);
  });

  it('an empty database with only a clock gives zeros', async () => {
    await setNow(pool, NOW);
    const r = await report(pool, OPTS);
    expect(r.inSequence).toBe(0);
    expect(r.replyRate).toEqual({ count: 0, of: 0 });
    expect(r.bounceRate).toEqual({ count: 0, of: 0 });
    expect(r.classifier).toEqual({ rule: { labelled: 0, correct: 0 }, ai: { labelled: 0, correct: 0 }, fallback: 0 });
    expect(r.aiCalls).toEqual({ today: 0, budget: 45 });
    expect(Object.values(r.statuses)).toEqual(Array(9).fill(0));
  });

  it('refuses to run before the clock is set', async () => {
    await expect(report(pool, OPTS)).rejects.toThrow(/npm run seed/);
  });
});

describe('formatReport', () => {
  it('prints the agreed lines', async () => {
    await fixture();
    expect(formatReport(await report(pool, OPTS))).toBe(
      [
        'Report for 2026-11-05 (simulated)',
        'Contacts: 9 · new 2 · first_sent 2 · follow_up_1_sent 0 · follow_up_2_sent 0 · follow_up_3_sent 1 · replied 1 · bounced 1 · unsubscribed 1 · deactivated 1',
        'In sequence: 5 · sent today: 2 · due today: 2 · due tomorrow: 1',
        'Reply rate: 83.3% (5 of 6 contacts with an accepted send)',
        'Bounce rate: 10.0% (1 of 10 sends)',
        'Emails since start by template: ai 2 · cache 1 · fallback 2',
        "Classifier since start, against the mock's true label: rule 1 of 1 correct (100.0%) · ai 1 of 2 correct (50.0%) · fallback 1",
        'Needs review: 1 · unlabelled: 1 · orphaned mock replies: 1',
        'AI calls today: 7/45',
      ].join('\n'),
    );
  });

  it('prints n/a for a rate with nothing to divide by', async () => {
    await setNow(pool, NOW);
    const text = formatReport(await report(pool, OPTS));
    expect(text).toContain('Reply rate: n/a (0 of 0 contacts with an accepted send)');
    expect(text).toContain('Bounce rate: n/a (0 of 0 sends)');
    expect(text).toContain('rule 0 of 0 correct (n/a) · ai 0 of 0 correct (n/a) · fallback 0');
  });
});
