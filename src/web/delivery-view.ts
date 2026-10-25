// Pure helpers for the deliverability page (D71). No pg, no Node: the page imports this file.

export const REGIONS = ['americas', 'europe', 'asia', 'australia'] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_NAME: Record<Region, string> = {
  americas: 'Americas',
  europe: 'Europe',
  asia: 'Asia',
  australia: 'Australia',
};

// The busiest cell of the day's strip never shows more than this many dots.
export const MAX_DOTS = 12;

// A contact's lane on the strip, from its IANA timezone. Anything that is not America, Europe or Australia is Asia
// (the seed only uses those four families; Africa or UTC would land in Asia too).
export function regionOf(timezone: string): Region {
  if (timezone.startsWith('America/')) return 'americas';
  if (timezone.startsWith('Europe/')) return 'europe';
  if (timezone.startsWith('Australia/')) return 'australia';
  return 'asia';
}

// How many emails one dot stands for, so the busiest cell has at most MAX_DOTS dots.
export function dotSize(maxCell: number): number {
  return Math.max(1, Math.ceil(maxCell / MAX_DOTS));
}

// Dots for a cell of `emails` at `size` emails per dot; 0 emails is 0 dots, 1 email is 1 dot.
export function dotsFor(emails: number, size: number): number {
  return Math.ceil(emails / size);
}
