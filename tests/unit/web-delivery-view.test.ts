import { describe, it, expect } from 'vitest';
import { MAX_DOTS, REGIONS, dotSize, dotsFor, regionOf } from '../../src/web/delivery-view';

// T22b pure helpers for the deliverability page (D71).
describe('regionOf', () => {
  it('has four regions in display order', () => {
    expect([...REGIONS]).toEqual(['americas', 'europe', 'asia', 'australia']);
  });

  it.each([
    ['America/New_York', 'americas'],
    ['America/Los_Angeles', 'americas'],
    ['Europe/London', 'europe'],
    ['Europe/Berlin', 'europe'],
    ['Asia/Kolkata', 'asia'],
    ['Asia/Singapore', 'asia'],
    ['Australia/Sydney', 'australia'],
    ['Africa/Lagos', 'asia'],
    ['UTC', 'asia'],
  ])('%s → %s', (tz, region) => {
    expect(regionOf(tz)).toBe(region);
  });
});

describe('dots (D71)', () => {
  it('at most 12 dots in the busiest cell', () => {
    expect(MAX_DOTS).toBe(12);
  });

  it.each([
    [0, 1],
    [1, 1],
    [12, 1],
    [13, 2],
    [24, 2],
    [25, 3],
    [600, 50],
  ])('busiest cell %i → one dot is %i emails', (max, size) => {
    expect(dotSize(max)).toBe(size);
  });

  it.each([
    [0, 5, 0],
    [1, 5, 1],
    [5, 5, 1],
    [6, 5, 2],
    [60, 5, 12],
  ])('%i emails at %i per dot → %i dots', (emails, size, dots) => {
    expect(dotsFor(emails, size)).toBe(dots);
  });

  it('the busiest cell never exceeds MAX_DOTS', () => {
    for (let max = 1; max <= 5000; max++) expect(dotsFor(max, dotSize(max))).toBeLessThanOrEqual(MAX_DOTS);
  });
});
