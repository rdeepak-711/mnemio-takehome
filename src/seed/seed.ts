import { Faker, base, en } from '@faker-js/faker';
import type pg from 'pg';
import { setNow } from '../clock';
import type { Config } from '../config';
import {
  STATUSES,
  STEPS,
  transition,
  type LifecycleEvent,
  type NextAction,
  type Status,
  type Step,
} from '../lifecycle';
import { nextActionAt } from '../schedule';
import { INDUSTRIES, ROLE_FAMILIES, ROLE_TITLES, segmentOf, type Industry, type RoleFamily } from '../segments';

export const STATUS_MIX: Record<Status, number> = {
  new: 0.6,
  first_sent: 0.12,
  follow_up_1_sent: 0.08,
  follow_up_2_sent: 0.05,
  follow_up_3_sent: 0.03,
  replied: 0.05,
  bounced: 0.02,
  unsubscribed: 0.02,
  deactivated: 0.03,
};

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
] as const;

const ALREADY_SEEDED = 'database already seeded; run npm run db:reset first';
const BATCH_ROWS = 1000;
const NEW_WAVE = 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const REPLY_BODIES = {
  interested: 'Sounds interesting. Can you send me more details?',
  not_interested: 'Thanks, but this is not a fit for us right now.',
  unsubscribe: 'Please unsubscribe me from these emails.',
} as const;
type SeedReplyLabel = keyof typeof REPLY_BODIES;

type PlannedSend = { step: Step; outcome: 'accepted' | 'bounced'; sentAt: Date; id: number };
type PlannedReply = { label: SeedReplyLabel; receivedAt: Date; id: number };
// What happened to one contact, in time order; ids are filled in once they are reserved.
type Action =
  | { kind: 'send'; send: PlannedSend }
  | { kind: 'reply'; reply: PlannedReply; send: PlannedSend }
  | { kind: 'change'; from: Status; to: Status; reason: string; at: Date };

type PlannedContact = {
  id: number;
  firstName: string;
  lastName: string;
  company: { name: string; slug: string; industry: Industry };
  family: RoleFamily;
  role: string;
  timezone: string;
  status: Status;
  nextAction: NextAction;
  nextActionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  actions: Action[];
};

// Exact counts that add up to n: floors first, then the largest remainders (ties in STATUSES order).
function statusCounts(n: number): Record<Status, number> {
  const parts = STATUSES.map((status, index) => {
    const scaled = Math.round(STATUS_MIX[status] * 10_000) * n; // integer math, no float drift
    return { status, index, count: Math.floor(scaled / 10_000), remainder: scaled % 10_000 };
  });
  let left = n - parts.reduce((sum, p) => sum + p.count, 0);
  for (const p of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break;
    p.count += 1;
    left -= 1;
  }
  return Object.fromEntries(parts.map((p) => [p.status, p.count])) as Record<Status, number>;
}

// Folds accents (NFD, then drop combining marks) and lowercases.
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Letters and digits only, for the name parts of an email.
const plain = (text: string) => fold(text).replace(/[^a-z0-9]/g, '');

// Letters, digits and single hyphens, for the company domain.
function companySlug(name: string): string {
  return (
    fold(name)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'company'
  );
}

const at = (ms: number) => new Date(ms);

// How many sends an in-sequence status has behind it.
const SENDS_IN_SEQUENCE = { first_sent: 1, follow_up_1_sent: 2, follow_up_2_sent: 3, follow_up_3_sent: 4 } as const;

// Walks one contact from `new` to its target status through transition(), recording every send and change.
function planHistory(
  faker: Faker,
  target: Status,
  config: Config,
  anchor: number, // 09:00 UTC on SIM_START's date
): Pick<PlannedContact, 'status' | 'nextAction' | 'nextActionAt' | 'actions'> {
  const waits = config.waitDays;
  const actions: Action[] = [];
  let status: Status = 'new';
  let nextAction: NextAction = 'first';

  const apply = (event: LifecycleEvent, reason: string, when: Date) => {
    const result = transition(status, event);
    actions.push({ kind: 'change', from: status, to: result.status, reason, at: when });
    status = result.status;
    if (result.nextAction !== 'unchanged') nextAction = result.nextAction;
  };

  // Sends `count` accepted steps, the last one `daysBack` days before the anchor, earlier ones back-dated by the waits.
  const sendSteps = (count: number, daysBack: number, minute: number): PlannedSend[] => {
    const times: number[] = new Array(count);
    times[count - 1] = anchor + minute * MINUTE_MS - daysBack * DAY_MS;
    for (let i = count - 2; i >= 0; i -= 1) times[i] = times[i + 1]! - waits[i]! * DAY_MS;
    return times.map((t, i) => {
      const send: PlannedSend = { step: STEPS[i]!, outcome: 'accepted', sentAt: at(t), id: 0 };
      actions.push({ kind: 'send', send });
      apply({ type: 'sent', step: send.step }, 'sent', send.sentAt);
      return send;
    });
  };

  const minute = faker.number.int({ min: 0, max: 59 });
  let nextAt: Date | null = null;

  switch (target) {
    case 'new':
      break;
    case 'first_sent':
    case 'follow_up_1_sent':
    case 'follow_up_2_sent':
    case 'follow_up_3_sent': {
      // The last send is a 09:xx UTC slot before SIM_START, picked so next_action_at lands in
      // [SIM_START - 2 days, SIM_START] (due, about a third) or (SIM_START, SIM_START + wait] (not yet due),
      // measured from SIM_START itself so any time of day works.
      const sends = SENDS_IN_SEQUENCE[target];
      const wait = waits[sends - 1]!;
      const due = faker.number.int({ min: 1, max: 3 }) === 1;
      const start = config.simStart.getTime();
      const slots = { due: [] as number[], later: [] as number[] };
      for (let back = 0; back <= wait + 3; back += 1) {
        const sentAt = anchor + minute * MINUTE_MS - back * DAY_MS;
        const next = sentAt + wait * DAY_MS;
        if (sentAt >= start) continue;
        if (next <= start && next >= start - 2 * DAY_MS) slots.due.push(back);
        else if (next > start) slots.later.push(back);
      }
      // A 1-day wait with SIM_START exactly on this minute leaves no later slot; fall back to due.
      const daysBack = faker.helpers.arrayElement(due || slots.later.length === 0 ? slots.due : slots.later);
      const planned = sendSteps(sends, daysBack, minute);
      const last = planned[planned.length - 1]!;
      nextAt = nextActionAt(last.step, last.sentAt, waits);
      break;
    }
    case 'replied':
    case 'unsubscribed': {
      const sends = faker.number.int({ min: 1, max: 4 });
      const daysBack = faker.number.int({ min: 4, max: 20 });
      const label: SeedReplyLabel =
        target === 'unsubscribed' ? 'unsubscribe' : faker.helpers.arrayElement(['interested', 'not_interested']);
      // 0.5–3 days, in minutes, and strictly before the next step (or deactivation) would have been due.
      const maxDelay = Math.min(72 * 60, waits[sends - 1]! * 24 * 60 - 1);
      const delay = faker.number.int({ min: Math.min(12 * 60, maxDelay), max: maxDelay });
      const planned = sendSteps(sends, daysBack, minute);
      const last = planned[planned.length - 1]!;
      const reply: PlannedReply = { label, receivedAt: at(last.sentAt.getTime() + delay * MINUTE_MS), id: 0 };
      actions.push({ kind: 'reply', reply, send: last });
      apply({ type: 'reply', label }, label === 'unsubscribe' ? 'unsubscribe' : 'reply', reply.receivedAt);
      break;
    }
    case 'bounced': {
      const daysBack = faker.number.int({ min: 1, max: 20 });
      const send: PlannedSend = {
        step: 'first',
        outcome: 'bounced',
        sentAt: at(anchor + minute * MINUTE_MS - daysBack * DAY_MS),
        id: 0,
      };
      actions.push({ kind: 'send', send });
      apply({ type: 'bounced' }, 'bounced', send.sentAt);
      break;
    }
    case 'deactivated': {
      // Deactivation falls 1–20 days before the anchor, a follow_up_3 wait after the last send.
      const daysBack = waits[3] + faker.number.int({ min: 1, max: 20 });
      const planned = sendSteps(4, daysBack, minute);
      const last = planned[3]!;
      apply({ type: 'deactivate_due' }, 'deactivate_due', nextActionAt(last.step, last.sentAt, waits));
      break;
    }
  }

  if (status !== target) throw new Error(`seed: planned ${target} but the rulebook reached ${status}`);
  return { status, nextAction, nextActionAt: nextAt, actions };
}

// Multi-row INSERTs of up to BATCH_ROWS rows each, in the given order.
async function insertRows(db: pg.PoolClient, table: string, columns: readonly string[], rows: unknown[][]) {
  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const chunk = rows.slice(start, start + BATCH_ROWS);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const slots = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${slots.join(', ')})`;
    });
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

// Takes the next `count` values of a table's serial, in order, so rows can be linked before they are inserted.
async function reserveIds(db: pg.PoolClient, table: string, count: number): Promise<number[]> {
  if (count === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT nextval(pg_get_serial_sequence($1, 'id')) AS id FROM generate_series(1, $2) ORDER BY 1`,
    [table, count],
  );
  return rows.map((r) => Number(r.id));
}

// Every random draw happens here, from one seeded Faker, in a fixed order.
function plan(config: Config, ids: number[]): PlannedContact[] {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(config.seed);
  const n = config.contactCount;
  const start = config.simStart;
  const anchor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 9);

  const companies = Array.from({ length: Math.max(50, Math.floor(n / 12)) }, (_, i) => {
    const name = faker.company.name();
    return { name, slug: companySlug(name), industry: INDUSTRIES[i % INDUSTRIES.length]! };
  });

  const counts = statusCounts(n);
  const statuses = faker.helpers.shuffle(STATUSES.flatMap((s) => Array.from({ length: counts[s] }, () => s)));
  const families = faker.helpers.shuffle(Array.from({ length: n }, (_, i) => ROLE_FAMILIES[i % ROLE_FAMILIES.length]!));

  let newIndex = 0;
  return ids.map((id, i) => {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const company = faker.helpers.arrayElement(companies);
    const family = families[i]!;
    const role = faker.helpers.arrayElement(ROLE_TITLES[family]);
    const timezone = faker.helpers.arrayElement(TIMEZONES);
    const history = planHistory(faker, statuses[i]!, config, anchor);
    const leadDays = faker.number.int({ min: 1, max: 30 });

    const times = history.actions.map((a) =>
      a.kind === 'send' ? a.send.sentAt : a.kind === 'reply' ? a.reply.receivedAt : a.at,
    );
    // Created some days before its first event (or before SIM_START if it has none).
    const first = times[0] ?? start;
    const createdAt = at(first.getTime() - leadDays * DAY_MS);
    const updatedAt = times[times.length - 1] ?? createdAt;

    let nextActionAtValue = history.nextActionAt;
    if (history.status === 'new') {
      // Daily waves of NEW_WAVE, in id order, the first one due at SIM_START.
      nextActionAtValue = at(start.getTime() + Math.floor(newIndex / NEW_WAVE) * DAY_MS);
      newIndex += 1;
    }

    return {
      id,
      firstName,
      lastName,
      company,
      family,
      role,
      timezone,
      status: history.status,
      nextAction: history.nextAction,
      nextActionAt: nextActionAtValue,
      createdAt,
      updatedAt,
      actions: history.actions,
    };
  });
}

const CONTACT_COLUMNS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'company',
  'industry',
  'role',
  'role_family',
  'timezone',
  'segment',
  'priority',
  'status',
  'next_action',
  'next_action_at',
  'created_at',
  'updated_at',
] as const;

export async function seed(pool: pg.Pool, config: Config): Promise<{ contacts: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ seeded: boolean }>('SELECT EXISTS (SELECT 1 FROM contacts) AS seeded');
    if (rows[0]?.seeded) throw new Error(ALREADY_SEEDED);

    const contacts = plan(config, await reserveIds(client, 'contacts', config.contactCount));

    // Link sends and replies to their reserved ids, in contact then time order.
    const sends = contacts.flatMap((c) => c.actions.flatMap((a) => (a.kind === 'send' ? [a.send] : [])));
    const sendIds = await reserveIds(client, 'sends', sends.length);
    sends.forEach((s, i) => (s.id = sendIds[i]!));
    const replies = contacts.flatMap((c) => c.actions.flatMap((a) => (a.kind === 'reply' ? [a.reply] : [])));
    const replyIds = await reserveIds(client, 'replies', replies.length);
    replies.forEach((r, i) => (r.id = replyIds[i]!));

    const contactRows: unknown[][] = [];
    const sendRows: unknown[][] = [];
    const outboxRows: unknown[][] = [];
    const replyRows: unknown[][] = [];
    const suppressionRows: unknown[][] = [];
    const eventRows: unknown[][] = [];

    for (const c of contacts) {
      const email = `${plain(c.firstName) || 'x'}.${plain(c.lastName) || 'x'}.${c.id}@${c.company.slug}.example`;
      contactRows.push([
        c.id,
        c.firstName,
        c.lastName,
        email,
        c.company.name,
        c.company.industry,
        c.role,
        c.family,
        c.timezone,
        segmentOf(c.family, c.company.industry),
        false,
        c.status,
        c.nextAction,
        c.nextActionAt,
        c.createdAt,
        c.updatedAt,
      ]);

      for (const a of c.actions) {
        if (a.kind === 'send') {
          const { send } = a;
          const key = `${c.id}:${send.step}`;
          sendRows.push([
            send.id,
            c.id,
            send.step,
            key,
            send.outcome,
            `Quick note for ${c.company.name} (${send.step})`,
            `Hi ${c.firstName}, this is the seeded ${send.step} email.`,
            'fallback',
            send.sentAt,
          ]);
          outboxRows.push([key, send.outcome, send.sentAt]);
          eventRows.push([
            c.id,
            'sent',
            JSON.stringify({ step: send.step, outcome: send.outcome, send_id: send.id }),
            send.sentAt,
          ]);
          if (send.outcome === 'bounced') suppressionRows.push([email, 'bounced', send.sentAt]);
        } else if (a.kind === 'reply') {
          const { reply } = a;
          const source = reply.label === 'unsubscribe' ? 'rule' : 'ai';
          replyRows.push([
            reply.id,
            c.id,
            a.send.id,
            REPLY_BODIES[reply.label],
            reply.receivedAt,
            reply.label,
            reply.label,
            source,
            reply.receivedAt,
          ]);
          eventRows.push([
            c.id,
            'reply_received',
            JSON.stringify({ reply_id: reply.id, label: reply.label, label_source: source }),
            reply.receivedAt,
          ]);
          if (reply.label === 'unsubscribe') suppressionRows.push([email, 'unsubscribed', reply.receivedAt]);
        } else {
          eventRows.push([c.id, 'status_changed', JSON.stringify({ from: a.from, to: a.to, reason: a.reason }), a.at]);
        }
      }
    }

    await insertRows(client, 'contacts', CONTACT_COLUMNS, contactRows);
    await insertRows(
      client,
      'sends',
      ['id', 'contact_id', 'step', 'idempotency_key', 'outcome', 'subject', 'body', 'template_source', 'sent_at'],
      sendRows,
    );
    await insertRows(client, 'mock_outbox', ['idempotency_key', 'outcome', 'received_at'], outboxRows);
    await insertRows(
      client,
      'replies',
      ['id', 'contact_id', 'send_id', 'body', 'received_at', 'true_label', 'label', 'label_source', 'classified_at'],
      replyRows,
    );
    await insertRows(client, 'suppression', ['email', 'reason', 'added_at'], suppressionRows);
    await insertRows(client, 'events', ['contact_id', 'type', 'data', 'occurred_at'], eventRows);
    await setNow(client, config.simStart);

    await client.query('COMMIT');
    return { contacts: contacts.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
