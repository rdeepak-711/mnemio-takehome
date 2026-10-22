import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { nextActionAt, oooReschedule } from '../../src/schedule';

const d = (iso: string) => new Date(iso);
const waits: [number, number, number, number] = [3, 5, 7, 7];

describe('nextActionAt', () => {
  it.each([
    ['first', '2026-11-05T09:00:00.000Z'],
    ['follow_up_1', '2026-11-07T09:00:00.000Z'],
    ['follow_up_2', '2026-11-09T09:00:00.000Z'],
    ['follow_up_3', '2026-11-09T09:00:00.000Z'],
  ] as const)('%s sent 2026-11-02T09:00Z with [3,5,7,7] → %s', (step, expected) => {
    expect(nextActionAt(step, d('2026-11-02T09:00:00Z'), waits).toISOString()).toBe(expected);
  });

  it('uses each step’s own wait (distinct waits)', () => {
    const sent = d('2026-11-02T09:00:00Z');
    const distinct: [number, number, number, number] = [1, 2, 3, 4];
    expect(nextActionAt('first', sent, distinct).toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect(nextActionAt('follow_up_1', sent, distinct).toISOString()).toBe('2026-11-04T09:00:00.000Z');
    expect(nextActionAt('follow_up_2', sent, distinct).toISOString()).toBe('2026-11-05T09:00:00.000Z');
    expect(nextActionAt('follow_up_3', sent, distinct).toISOString()).toBe('2026-11-06T09:00:00.000Z');
  });

  it('rolls over a month end (2026-11-28 + 5 → 2026-12-03)', () => {
    expect(nextActionAt('follow_up_1', d('2026-11-28T09:00:00Z'), waits).toISOString()).toBe(
      '2026-12-03T09:00:00.000Z',
    );
  });

  it('rolls over a year end (2026-12-29 + 7 → 2027-01-05)', () => {
    expect(nextActionAt('follow_up_2', d('2026-12-29T09:00:00Z'), waits).toISOString()).toBe(
      '2027-01-05T09:00:00.000Z',
    );
  });

  it('keeps the time of day exactly (24-hour steps in UTC)', () => {
    expect(nextActionAt('first', d('2026-11-02T23:59:30.250Z'), waits).toISOString()).toBe('2026-11-05T23:59:30.250Z');
  });

  it('does not change the sentAt it was given, and returns a new Date', () => {
    const sent = d('2026-11-02T09:00:00Z');
    const result = nextActionAt('first', sent, waits);
    expect(sent.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(result).not.toBe(sent);
  });
});

describe('oooReschedule', () => {
  const now = d('2026-11-04T09:00:00Z');

  it('uses returnDate + 1 day when that is in the future and later than currentDue', () => {
    const due = d('2026-11-05T09:00:00Z');
    expect(oooReschedule(due, now, d('2026-11-10T00:00:00Z'), 7).toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });

  it('a return date in the past uses now + defaultDays', () => {
    const due = d('2026-11-05T09:00:00Z');
    expect(oooReschedule(due, now, d('2026-11-01T00:00:00Z'), 7).toISOString()).toBe('2026-11-11T09:00:00.000Z');
  });

  it('a return date of today uses returnDate + 1 day, not now + defaultDays', () => {
    const due = d('2026-11-04T09:00:00Z');
    expect(oooReschedule(due, now, d('2026-11-04T00:00:00Z'), 7).toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('a return date of today still gives currentDue when that is later', () => {
    const due = d('2026-11-06T09:00:00Z');
    expect(oooReschedule(due, now, d('2026-11-04T00:00:00Z'), 7).toISOString()).toBe('2026-11-06T09:00:00.000Z');
  });

  it('returnDate + 1 earlier than currentDue keeps currentDue (never pulls an email earlier)', () => {
    const due = d('2026-11-20T09:00:00Z');
    expect(oooReschedule(due, now, d('2026-11-08T00:00:00Z'), 7).toISOString()).toBe('2026-11-20T09:00:00.000Z');
  });

  it('returnDate null uses now + defaultDays', () => {
    const due = d('2026-11-05T09:00:00Z');
    expect(oooReschedule(due, now, null, 7).toISOString()).toBe('2026-11-11T09:00:00.000Z');
  });

  it('returnDate null keeps currentDue when that is later than now + defaultDays', () => {
    const due = d('2026-11-30T09:00:00Z');
    expect(oooReschedule(due, now, null, 7).toISOString()).toBe('2026-11-30T09:00:00.000Z');
  });

  it('uses defaultDays as given (3)', () => {
    const due = d('2026-11-05T09:00:00Z');
    expect(oooReschedule(due, now, null, 3).toISOString()).toBe('2026-11-07T09:00:00.000Z');
  });

  it('returnDate + 1 exactly equal to now is not "later than now" → now + defaultDays', () => {
    const due = d('2026-11-04T09:00:00Z');
    expect(oooReschedule(due, now, d('2026-11-03T09:00:00Z'), 7).toISOString()).toBe('2026-11-11T09:00:00.000Z');
  });

  it('does not change any Date it was given', () => {
    const due = d('2026-11-05T09:00:00Z');
    const ret = d('2026-11-10T00:00:00Z');
    const nowCopy = d('2026-11-04T09:00:00Z');
    oooReschedule(due, nowCopy, ret, 7);
    expect([due, nowCopy, ret].map((x) => x.toISOString())).toEqual([
      '2026-11-05T09:00:00.000Z',
      '2026-11-04T09:00:00.000Z',
      '2026-11-10T00:00:00.000Z',
    ]);
  });
});

describe('src/schedule.ts', () => {
  it('never reads the real clock (no `new Date()` without arguments, no Date.now())', () => {
    const source = readFileSync(new URL('../../src/schedule.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toMatch(/Date\.now\(/);
  });
});
