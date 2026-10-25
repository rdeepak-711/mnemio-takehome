import type { Status } from '../../src/lifecycle';
import type { Count } from '../../src/report';

// What a src/web type looks like after Response.json: every Date becomes an ISO string.
export type Wire<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Fetches one of the dashboard's own routes; a non-2xx answer throws its { error } message.
export async function getJson<T>(url: string, init?: RequestInit): Promise<Wire<T>> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) throw new ApiError(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`, res.status);
  return body as Wire<T>;
}

// The clock or the tables are missing: the empty state, not a crash.
export function isUnseeded(err: unknown): boolean {
  return err instanceof Error && /npm run seed|does not exist/.test(err.message);
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

// One decimal place, as in the report; n/a when there is nothing to divide by.
export const fmtPct = (c: Count) => (c.of === 0 ? 'n/a' : `${((c.count / c.of) * 100).toFixed(1)}%`);

// Simulated time, always shown in UTC so the browser's timezone never changes a date.
export function fmtTime(iso: string | null): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—';
}

export function fmtDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const STATUS_LABEL: Record<Status, string> = {
  new: 'New',
  first_sent: 'First sent',
  follow_up_1_sent: 'Follow-up 1',
  follow_up_2_sent: 'Follow-up 2',
  follow_up_3_sent: 'Follow-up 3',
  replied: 'Replied',
  bounced: 'Bounced',
  unsubscribed: 'Unsubscribed',
  deactivated: 'Deactivated',
};

export const NEXT_LABEL: Record<string, string> = {
  first: 'First email',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
  deactivate: 'Deactivate',
};

// The classifier's labels, as the classifier page and the overview card name them.
export const LABEL_NAME: Record<string, string> = {
  interested: 'Interested',
  not_interested: 'Not interested',
  out_of_office: 'Out of office',
  unsubscribe: 'Unsubscribe request',
  needs_review: 'Uncertain (needs review)',
};

// Which mechanism labelled a reply: the only "explanation" the engine stores (D60).
export const SOURCE_WORDS: Record<string, string> = {
  rule: 'a rule matched',
  ai: 'the AI answered',
  fallback: 'the fallback, because the AI gave no answer',
};

// The activity log's kinds (D61), by human name.
export const KIND_LABEL: Record<string, string> = {
  sent: 'Email sent',
  bounced: 'Bounced',
  reply: 'Reply',
  unsubscribed: 'Unsubscribed',
  rescheduled: 'Rescheduled',
  deactivated: 'Deactivated',
  suppressed: 'Suppressed',
};

// Why a contact entered its stage: the status_changed event's reason (D62); null is a contact never contacted.
export function reasonWords(reason: string | null): string {
  if (reason === null) return 'not contacted yet';
  const words: Record<string, string> = {
    sent: 'email sent',
    reply: 'replied',
    unsubscribe: 'asked to unsubscribe',
    bounced: 'email bounced',
    deactivate_due: 'no reply after the last follow-up',
    suppressed: 'on the do-not-email list',
  };
  return words[reason] ?? reason;
}
