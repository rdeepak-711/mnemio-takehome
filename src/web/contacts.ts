import type { Queryable } from '../clock';
import { STATUSES, type Status } from '../lifecycle';
import { BadRequest } from './errors';

export const PAGE_SIZE = 50;

export type ContactRow = {
  id: number;
  name: string;
  email: string;
  company: string;
  status: Status;
  lastSentAt: Date | null;
  lastReplyAt: Date | null;
  nextAction: string | null;
  nextActionAt: Date | null;
};
export type ContactPage = { page: number; pageSize: number; total: number; rows: ContactRow[] };
export type ContactDetail = {
  contact: ContactRow & {
    firstName: string;
    lastName: string;
    role: string;
    industry: string;
    segment: string;
    timezone: string;
    createdAt: Date;
  };
  sends: {
    id: number;
    step: string;
    outcome: string;
    subject: string;
    body: string;
    templateSource: string;
    sentAt: Date;
  }[];
  replies: {
    id: number;
    sendId: number;
    body: string;
    receivedAt: Date;
    label: string | null;
    labelSource: string | null;
    trueLabel: string; // the mock's hidden label, used for scoring (D12)
    classifiedAt: Date | null;
  }[];
  events: { id: number; type: string; data: unknown; occurredAt: Date }[];
};

// The largest value a Postgres int (contacts.id) holds; a bigger id cannot exist.
const MAX_ID = 2_147_483_647;

// The contact search on contacts `c`, shared with activity.ts: `p` is the parameter holding searchPattern()'s
// result or NULL (no search). `\` escapes % and _ in the pattern.
export const searchSql = (p: string) => `
  (${p}::text IS NULL OR (c.first_name || ' ' || c.last_name) ILIKE ${p} ESCAPE '\\'
                     OR c.email ILIKE ${p} ESCAPE '\\' OR c.company ILIKE ${p} ESCAPE '\\')`;

// $1 = the ILIKE pattern or NULL, $2 = the status or NULL.
const WHERE = `
  WHERE ${searchSql('$1')}
    AND ($2::text IS NULL OR c.status = $2)`;

const COLUMNS = `c.id, c.first_name || ' ' || c.last_name AS name, c.email, c.company, c.status,
  c.next_action AS "nextAction", c.next_action_at AS "nextActionAt"`;

// The page first, then the latest send and reply for just those ids: one grouped query each, never one per row.
const PAGE_SQL = `
  WITH page AS (SELECT ${COLUMNS} FROM contacts c ${WHERE} ORDER BY c.id LIMIT $3 OFFSET $4)
  SELECT p.id, p.name, p.email, p.company, p.status, s.last AS "lastSentAt", r.last AS "lastReplyAt",
         p."nextAction", p."nextActionAt"
    FROM page p
    LEFT JOIN (SELECT contact_id, max(sent_at) AS last FROM sends
                WHERE contact_id IN (SELECT id FROM page) GROUP BY contact_id) s ON s.contact_id = p.id
    LEFT JOIN (SELECT contact_id, max(received_at) AS last FROM replies
                WHERE contact_id IN (SELECT id FROM page) GROUP BY contact_id) r ON r.contact_id = p.id
   ORDER BY p.id`;

const COUNT_SQL = `SELECT count(*)::int AS n FROM contacts c ${WHERE}`;

// Turns a search into a case-insensitive substring pattern with %, _ and \ taken literally.
export function searchPattern(q: string | null | undefined): string | null {
  const trimmed = q?.trim() ?? '';
  return trimmed === '' ? null : `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`;
}

export async function listContacts(
  db: Queryable,
  opts: { q?: string | null; status?: string | null; page?: number },
): Promise<ContactPage> {
  const page = opts.page ?? 1;
  if (!Number.isInteger(page) || page < 1) throw new BadRequest(`page: expected a whole number >= 1, got ${page}`);
  const status = opts.status || null;
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) {
    throw new BadRequest(`status: expected one of ${STATUSES.join(', ')}, got "${status}"`);
  }
  const q = searchPattern(opts.q);

  const [count, rows] = await Promise.all([
    db.query<{ n: number }>(COUNT_SQL, [q, status]),
    db.query<ContactRow>(PAGE_SQL, [q, status, PAGE_SIZE, (page - 1) * PAGE_SIZE]),
  ]);
  return { page, pageSize: PAGE_SIZE, total: count.rows[0]?.n ?? 0, rows: rows.rows };
}

// One contact with every send, reply and event in time order, or null when the id is unknown.
export async function contactDetail(db: Queryable, id: number): Promise<ContactDetail | null> {
  if (!Number.isInteger(id) || id < 1 || id > MAX_ID) return null;
  const [contact, sends, replies, events] = await Promise.all([
    db.query<ContactDetail['contact']>(
      `SELECT ${COLUMNS}, c.first_name AS "firstName", c.last_name AS "lastName", c.role, c.industry, c.segment,
              c.timezone, c.created_at AS "createdAt",
              (SELECT max(sent_at) FROM sends WHERE contact_id = c.id) AS "lastSentAt",
              (SELECT max(received_at) FROM replies WHERE contact_id = c.id) AS "lastReplyAt"
         FROM contacts c WHERE c.id = $1`,
      [id],
    ),
    db.query<ContactDetail['sends'][number]>(
      `SELECT id, step, outcome, subject, body, template_source AS "templateSource", sent_at AS "sentAt"
         FROM sends WHERE contact_id = $1 ORDER BY sent_at, id`,
      [id],
    ),
    db.query<ContactDetail['replies'][number]>(
      `SELECT id, send_id AS "sendId", body, received_at AS "receivedAt", label, label_source AS "labelSource",
              true_label AS "trueLabel", classified_at AS "classifiedAt"
         FROM replies WHERE contact_id = $1 ORDER BY received_at, id`,
      [id],
    ),
    // events.id is a bigint, which pg returns as text; it is turned back into a number below.
    db.query<{ id: string; type: string; data: unknown; occurredAt: Date }>(
      `SELECT id, type, data, occurred_at AS "occurredAt" FROM events WHERE contact_id = $1 ORDER BY occurred_at, id`,
      [id],
    ),
  ]);
  const row = contact.rows[0];
  if (!row) return null;
  return {
    contact: row,
    sends: sends.rows,
    replies: replies.rows,
    events: events.rows.map((e) => ({ ...e, id: Number(e.id) })),
  };
}
