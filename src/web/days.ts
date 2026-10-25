import { BadRequest } from './errors';

// A dashboard day is a simulated UTC calendar day, written YYYY-MM-DD (D57).
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Phase = 'history' | 'simulated';

export function dayKey(t: Date): string {
  return t.toISOString().slice(0, 10);
}

export function dayStart(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

export function nextDay(key: string): string {
  return dayKey(new Date(dayStart(key).getTime() + DAY_MS));
}

// null or '' means "no day given". Anything else must be a real calendar date in exactly YYYY-MM-DD form:
// the round trip through Date catches 2026-02-30, which Date would otherwise roll over to 2 March.
export function parseDay(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = DAY_RE.test(raw) ? dayStart(raw) : null;
  if (!t || Number.isNaN(t.getTime()) || dayKey(t) !== raw) {
    throw new BadRequest(`day: expected a real date as YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

// history when the whole day ended at or before SIM_START (the seed made it up), else simulated (the engine ran it).
export function phaseOf(key: string, simStart: Date): Phase {
  return dayStart(nextDay(key)).getTime() <= simStart.getTime() ? 'history' : 'simulated';
}
