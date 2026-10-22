import type pg from 'pg';
import type { Config } from '../config';
import { transition, type LifecycleEvent, type NextAction, type Status, type Step } from '../lifecycle';
import type { Provider } from '../mock/provider';
import { nextActionAt } from '../schedule';
import { FALLBACK_TEMPLATES } from '../templates/fallback';
import { checkContent, render } from '../templates/render';
import { claimDue, type ClaimedContact } from './claim';

export type Template = { subject: string; body: string; source: 'ai' | 'cache' };
export type SendDeps = {
  provider: Provider; // built on its OWN pool (D43)
  config: Pick<Config, 'waitDays' | 'sendBatchSize'>;
  getTemplate?: (segment: string, step: Step) => Promise<Template | null>; // T17 plugs in here; absent → fallback
  afterProviderCall?: (contact: ClaimedContact) => void | Promise<void>; // test hook for the crash test
};
export type SendSummary = { sent: number; bounced: number; suppressed: number; batches: number };

type Email = { subject: string; body: string; source: 'ai' | 'cache' | 'fallback' };
type Vars = Record<'first_name' | 'last_name' | 'company' | 'role' | 'industry', string>;

// Industry codes as they read in an email (D47).
const INDUSTRY_TEXT: Record<ClaimedContact['industry'], string> = {
  saas: 'SaaS',
  ecommerce: 'e-commerce',
  fintech: 'fintech',
  healthcare: 'healthcare',
  logistics: 'logistics',
};

// Braces carry no meaning in contact data, so a company called {{evil}} can't break a template (D46).
// An empty value gets a stand-in, so missing data never stops the run (D47).
function clean(value: string, standIn: string): string {
  return value.replace(/[{}]/g, '').trim() || standIn;
}

export function contactVars(c: ClaimedContact): Vars {
  return {
    first_name: clean(c.firstName, 'there'),
    last_name: clean(c.lastName, 'there'),
    company: clean(c.company, 'your company'),
    role: clean(c.role, 'your role'),
    industry: INDUSTRY_TEXT[c.industry],
  };
}

// Renders and checks a template; null if it fails to render or has any content problem.
function tryRender(template: { subject: string; body: string }, vars: Vars): { subject: string; body: string } | null {
  try {
    const email = { subject: render(template.subject, vars), body: render(template.body, vars) };
    return checkContent(email).length === 0 ? email : null;
  } catch {
    return null;
  }
}

// An AI template is optional; the fallback is the base (D46). A failing fallback is our bug, so it throws.
async function writeEmail(contact: ClaimedContact, deps: SendDeps): Promise<Email> {
  const step = contact.nextAction;
  const vars = contactVars(contact);
  const template = deps.getTemplate ? await deps.getTemplate(contact.segment, step) : null;
  if (template) {
    const email = tryRender(template, vars);
    if (email) return { ...email, source: template.source };
  }
  const fallback = FALLBACK_TEMPLATES[step];
  const email = { subject: render(fallback.subject, vars), body: render(fallback.body, vars) };
  const problems = checkContent(email);
  if (problems.length > 0) {
    throw new Error(
      `fallback template for ${step} failed checkContent for contact ${contact.id}: ${problems.join('; ')}`,
    );
  }
  return { ...email, source: 'fallback' };
}

function moveOn(status: Status, event: LifecycleEvent): { status: Status; nextAction: NextAction } {
  const next = transition(status, event);
  // 'unchanged' only comes from an out-of-office reply, never from these events.
  if (next.nextAction === 'unchanged') throw new Error(`unexpected unchanged next action for ${event.type}`);
  return { status: next.status, nextAction: next.nextAction };
}

async function updateContact(
  client: pg.PoolClient,
  id: number,
  next: { status: Status; nextAction: NextAction },
  dueAt: Date | null,
  now: Date,
): Promise<void> {
  await client.query(
    'UPDATE contacts SET status = $2, next_action = $3, next_action_at = $4, updated_at = $5 WHERE id = $1',
    [id, next.status, next.nextAction, next.nextAction === null ? null : dueAt, now],
  );
}

async function addEvent(client: pg.PoolClient, contactId: number, type: string, data: object, now: Date) {
  await client.query('INSERT INTO events (contact_id, type, data, occurred_at) VALUES ($1, $2, $3, $4)', [
    contactId,
    type,
    JSON.stringify(data),
    now,
  ]);
}

type Handled = 'sent' | 'bounced' | 'suppressed';

async function handle(client: pg.PoolClient, contact: ClaimedContact, now: Date, deps: SendDeps): Promise<Handled> {
  const from = contact.status;

  // A suppressed address is closed through transition(), never emailed (D34).
  const suppression = await client.query<{ reason: 'bounced' | 'unsubscribed' }>(
    'SELECT reason FROM suppression WHERE email = $1',
    [contact.email],
  );
  const reason = suppression.rows[0]?.reason;
  if (reason) {
    const next = moveOn(from, { type: 'suppressed', reason });
    await updateContact(client, contact.id, next, null, now);
    await addEvent(client, contact.id, 'status_changed', { from, to: next.status, reason: 'suppressed' }, now);
    return 'suppressed';
  }

  const step = contact.nextAction;
  const email = await writeEmail(contact, deps);
  const idempotencyKey = `${contact.id}:${step}`;
  const { outcome } = await deps.provider.send({
    idempotencyKey,
    to: contact.email,
    subject: email.subject,
    body: email.body,
    now,
  });
  await deps.afterProviderCall?.(contact);

  // Plain INSERT: with the claim lock a duplicate can only be a bug, and it must fail loudly (D46).
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO sends (contact_id, step, idempotency_key, outcome, subject, body, template_source, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [contact.id, step, idempotencyKey, outcome, email.subject, email.body, email.source, now],
  );
  await addEvent(client, contact.id, 'sent', { step, outcome, send_id: inserted.rows[0]!.id }, now);

  if (outcome === 'accepted') {
    const next = moveOn(from, { type: 'sent', step });
    await updateContact(client, contact.id, next, nextActionAt(step, now, deps.config.waitDays), now);
    await addEvent(client, contact.id, 'status_changed', { from, to: next.status, reason: 'sent' }, now);
    return 'sent';
  }

  // A bounce closes the contact from any in-sequence status, new included (D46).
  const next = moveOn(from, { type: 'bounced' });
  await client.query(
    `INSERT INTO suppression (email, reason, added_at) VALUES ($1, 'bounced', $2) ON CONFLICT (email) DO NOTHING`,
    [contact.email, now],
  );
  await updateContact(client, contact.id, next, null, now);
  await addEvent(client, contact.id, 'status_changed', { from, to: next.status, reason: 'bounced' }, now);
  return 'bounced';
}

// Claims and handles due contacts batch by batch; each batch commits as one transaction,
// so a failure undoes the whole batch and the claim lock is released with it (D45).
export async function sendDue(pool: pg.Pool, now: Date, deps: SendDeps): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, bounced: 0, suppressed: 0, batches: 0 };
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    for (;;) {
      await client.query('BEGIN');
      try {
        const claimed = await claimDue(client, now, deps.config.sendBatchSize);
        if (claimed.length === 0) {
          await client.query('COMMIT');
          return summary;
        }
        const batch = { sent: 0, bounced: 0, suppressed: 0 };
        for (const contact of claimed) batch[await handle(client, contact, now, deps)] += 1;
        await client.query('COMMIT');
        summary.sent += batch.sent;
        summary.bounced += batch.bounced;
        summary.suppressed += batch.suppressed;
        summary.batches += 1;
      } catch (error) {
        // A connection that can't even roll back is not handed back to the pool for reuse.
        await client.query('ROLLBACK').catch((rollbackError: Error) => {
          broken = rollbackError;
        });
        throw error;
      }
    }
  } finally {
    client.release(broken);
  }
}
