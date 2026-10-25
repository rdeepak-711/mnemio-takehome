import { describe, it, expect } from 'vitest';
import { dayKey, dayStart, nextDay, parseDay, phaseOf } from '../../src/web/days';
import { BadRequest } from '../../src/web/errors';

const SIM_START = new Date('2026-11-02T09:00:00Z');

describe('dayKey, dayStart, nextDay', () => {
  it('dayKey is the UTC date of an instant', () => {
    expect(dayKey(new Date('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
    expect(dayKey(new Date('2026-11-02T23:59:59.999Z'))).toBe('2026-11-02');
    expect(dayKey(new Date('2026-11-02T23:30:00-05:00'))).toBe('2026-11-03');
  });

  it('dayStart is 00:00 UTC of that day', () => {
    expect(dayStart('2026-11-02').toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('nextDay crosses months, years and leap days', () => {
    expect(nextDay('2026-11-02')).toBe('2026-11-03');
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('2028-02-29')).toBe('2028-03-01');
  });
});

describe('parseDay', () => {
  it('treats a missing or empty value as "no day given"', () => {
    expect(parseDay(null)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay('')).toBeNull();
  });

  it('accepts real calendar dates', () => {
    expect(parseDay('2026-11-02')).toBe('2026-11-02');
    expect(parseDay('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['2026-02-29', '2026-13-01', '2026-04-31', '2026-1-5', '2026-11-02T00:00', 'yesterday', ' 2026-11-02'])(
    'refuses %j with a BadRequest that names the day',
    (raw) => {
      expect(() => parseDay(raw)).toThrow(BadRequest);
      expect(() => parseDay(raw)).toThrow(/day/);
    },
  );
});

describe('phaseOf', () => {
  it('is history when the whole day ends at or before SIM_START, else simulated', () => {
    expect(phaseOf('2026-11-01', SIM_START)).toBe('history');
    expect(phaseOf('2026-11-02', SIM_START)).toBe('simulated');
    expect(phaseOf('2026-11-05', SIM_START)).toBe('simulated');
  });

  it('a day that ends exactly at SIM_START is history', () => {
    const midnight = new Date('2026-11-03T00:00:00Z');
    expect(phaseOf('2026-11-02', midnight)).toBe('history');
    expect(phaseOf('2026-11-03', midnight)).toBe('simulated');
  });
});
