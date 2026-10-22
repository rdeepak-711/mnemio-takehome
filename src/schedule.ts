import type { Step } from './lifecycle';

const DAY_MS = 24 * 60 * 60 * 1000;

// Which entry of the waits tuple each step uses.
const WAIT_INDEX: Record<Step, 0 | 1 | 2 | 3> = {
  first: 0,
  follow_up_1: 1,
  follow_up_2: 2,
  follow_up_3: 3,
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function nextActionAt(step: Step, sentAt: Date, waits: [number, number, number, number]): Date {
  return addDays(sentAt, waits[WAIT_INDEX[step]]);
}

// Never returns earlier than currentDue, so an out-of-office can only push an email later.
export function oooReschedule(currentDue: Date, now: Date, returnDate: Date | null, defaultDays: number): Date {
  const afterReturn = returnDate ? addDays(returnDate, 1) : null;
  const candidate = afterReturn && afterReturn.getTime() > now.getTime() ? afterReturn : addDays(now, defaultDays);
  return new Date(Math.max(candidate.getTime(), currentDue.getTime()));
}
