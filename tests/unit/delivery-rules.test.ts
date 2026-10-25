import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  PAUSE_MIN_SENDS,
  PAUSE_SAMPLE,
  UNSUBSCRIBE_BASE_URL,
  UNSUBSCRIBE_MAILTO,
  inSendWindow,
  mailboxAddress,
  recipientDomain,
  shouldPause,
  unsubscribeHeaders,
  unsubscribeLink,
  unsubscribeToken,
  warmupLimit,
  withUnsubscribeFooter,
} from '../../src/delivery/rules';

// T22 pure rules (D66–D70).
const WARMUP = { start: 20, step: 10, max: 80 };
const WINDOW = { startHour: 9, endHour: 17 };

describe('warmupLimit (D66)', () => {
  it.each([
    [0, 20],
    [1, 30],
    [5, 70],
    [6, 80],
    [7, 80],
    [100, 80],
  ])('age %i days → %i', (age, limit) => {
    expect(warmupLimit(age, WARMUP)).toBe(limit);
  });

  it('is 0 before the warm-up starts', () => {
    expect(warmupLimit(-1, WARMUP)).toBe(0);
  });

  it('step 0 stays at the start', () => {
    expect(warmupLimit(30, { start: 5, step: 0, max: 80 })).toBe(5);
  });

  it.each([1.5, Number.NaN])('age %s throws naming ageDays', (age) => {
    expect(() => warmupLimit(age, WARMUP)).toThrow(/ageDays/);
  });
});

describe('inSendWindow (D68): local Mon–Fri, start ≤ hour < end', () => {
  it.each([
    // New York, after the US change on Sun 1 Nov 2026 (EST, UTC-5)
    ['2026-11-02T14:00:00Z', 'America/New_York', true], // Mon 09:00
    ['2026-11-02T13:59:00Z', 'America/New_York', false], // Mon 08:59
    ['2026-11-02T21:59:00Z', 'America/New_York', true], // Mon 16:59
    ['2026-11-02T22:00:00Z', 'America/New_York', false], // Mon 17:00
    // New York before the change (EDT, UTC-4)
    ['2026-10-30T13:00:00Z', 'America/New_York', true], // Fri 09:00
    ['2026-10-30T12:59:00Z', 'America/New_York', false], // Fri 08:59
    ['2026-11-07T15:00:00Z', 'America/New_York', false], // Sat 10:00
    ['2026-11-02T09:00:00Z', 'America/Los_Angeles', false], // Mon 01:00, the old daily tick
    ['2026-11-02T17:00:00Z', 'America/Los_Angeles', true], // Mon 09:00 PST
    // Sydney (AEDT, UTC+11): the local day is ahead of UTC
    ['2026-11-01T22:00:00Z', 'Australia/Sydney', true], // Mon 09:00 local, Sun in UTC
    ['2026-11-06T22:00:00Z', 'Australia/Sydney', false], // Sat 09:00 local, Fri in UTC
    // Kolkata (UTC+5:30)
    ['2026-11-02T03:30:00Z', 'Asia/Kolkata', true], // Mon 09:00
    ['2026-11-02T03:29:00Z', 'Asia/Kolkata', false], // Mon 08:59
    // London, either side of the European change on Sun 25 Oct 2026
    ['2026-10-23T08:00:00Z', 'Europe/London', true], // Fri 09:00 BST
    ['2026-10-23T07:59:00Z', 'Europe/London', false], // Fri 08:59 BST
    ['2026-10-26T09:00:00Z', 'Europe/London', true], // Mon 09:00 GMT
    ['2026-10-26T08:59:00Z', 'Europe/London', false], // Mon 08:59 GMT
  ])('%s in %s → %s', (iso, tz, expected) => {
    expect(inSendWindow(new Date(iso), tz, WINDOW)).toBe(expected);
  });

  it('a 0-24 window is every hour of a weekday and no hour of a weekend', () => {
    const all = { startHour: 0, endHour: 24 };
    expect(inSendWindow(new Date('2026-11-02T00:00:00Z'), 'Europe/London', all)).toBe(true);
    expect(inSendWindow(new Date('2026-11-02T23:59:00Z'), 'Europe/London', all)).toBe(true);
    expect(inSendWindow(new Date('2026-11-07T12:00:00Z'), 'Europe/London', all)).toBe(false);
  });
});

describe('shouldPause (D67)', () => {
  it('uses a sample of the last 100 sends and needs at least 50', () => {
    expect(PAUSE_SAMPLE).toBe(100);
    expect(PAUSE_MIN_SENDS).toBe(50);
  });

  it.each([
    [{ sends: 49, bounced: 49 }, 0.1, false],
    [{ sends: 50, bounced: 5 }, 0.1, false], // exactly 10% is not above
    [{ sends: 50, bounced: 6 }, 0.1, true],
    [{ sends: 100, bounced: 10 }, 0.1, false],
    [{ sends: 100, bounced: 11 }, 0.1, true],
    [{ sends: 50, bounced: 0 }, 0, false],
    [{ sends: 50, bounced: 1 }, 0, true],
  ])('%j at %s → %s', (sample, rate, expected) => {
    expect(shouldPause(sample, rate)).toBe(expected);
  });
});

describe('mailboxAddress (D66)', () => {
  it.each([
    [1, 'outreach-01@mail1.mnemio.example'],
    [5, 'outreach-05@mail5.mnemio.example'],
    [6, 'outreach-06@mail1.mnemio.example'],
    [50, 'outreach-50@mail5.mnemio.example'],
    [100, 'outreach-100@mail5.mnemio.example'],
  ])('%i → %s', (id, address) => {
    expect(mailboxAddress(id)).toBe(address);
  });

  it.each([0, -1, 1.5])('%s throws naming id', (id) => {
    expect(() => mailboxAddress(id)).toThrow(/id/);
  });
});

describe('recipientDomain (D69)', () => {
  it('is the part after the last @, lower-cased', () => {
    expect(recipientDomain('Ann.Lee.7@Acme-Corp.Example')).toBe('acme-corp.example');
    expect(recipientDomain('"a@b"@c.example')).toBe('c.example');
  });

  it.each(['', 'no-at-sign', 'trailing@'])('%j throws naming the email', (email) => {
    expect(() => recipientDomain(email)).toThrow(/email/);
  });
});

describe('unsubscribe (D70)', () => {
  const expected = (seed: number, id: number) =>
    createHash('sha256').update(`unsubscribe:${seed}:${id}`).digest('hex').slice(0, 16);

  it('token is the first 16 hex characters of sha256("unsubscribe:<seed>:<id>")', () => {
    expect(unsubscribeToken(42, 7)).toBe(expected(42, 7));
    expect(unsubscribeToken(42, 7)).toMatch(/^[0-9a-f]{16}$/);
    expect(unsubscribeToken(42, 8)).not.toBe(unsubscribeToken(42, 7));
    expect(unsubscribeToken(43, 7)).not.toBe(unsubscribeToken(42, 7));
  });

  it('link and headers', () => {
    const token = expected(42, 7);
    expect(UNSUBSCRIBE_BASE_URL).toBe('https://mnemio.example/unsubscribe');
    expect(UNSUBSCRIBE_MAILTO).toBe('unsubscribe@mnemio.example');
    expect(unsubscribeLink(42, 7)).toBe(`https://mnemio.example/unsubscribe/7/${token}`);
    expect(unsubscribeHeaders(42, 7)).toEqual({
      'List-Unsubscribe': `<mailto:unsubscribe@mnemio.example?subject=unsubscribe%207-${token}>, <https://mnemio.example/unsubscribe/7/${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('footer goes after the body with trailing whitespace trimmed', () => {
    const link = 'https://mnemio.example/unsubscribe/7/abc';
    expect(withUnsubscribeFooter('Hi Ann,\n\nBye\n\n', link)).toBe(
      `Hi Ann,\n\nBye\n\n--\nNot interested? Unsubscribe here: ${link}`,
    );
  });
});
