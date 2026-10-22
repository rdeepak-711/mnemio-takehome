export type RuleResult = { label: 'out_of_office'; returnDate: Date | null } | { label: 'unsubscribe' } | null;

const UNSUBSCRIBE = /\b(unsubscribe|remove me|stop (emailing|contacting) me|take me off)\b/i;
const UNSUBSCRIBE_NEGATION = /\b(don'?t|do not)\s+(unsubscribe|remove)\b/i;
const OOO_PHRASE = /\b(out of (the )?office|on (annual )?leave|away until|on vacation)\b/i;
// A word boundary before each phrase, so "Juno," is not "no,".
const OOO_DENIAL = /\b(no,|not out|i'm here|i am here|not away)/i;

const MONTH =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
const ORDINAL = '(?:st|nd|rd|th)?';
// A weekday right before a date is dropped ("Monday 3rd November" means 3 Nov).
const WEEKDAY_PREFIX = `(?:${WEEKDAY},?\\s+)?`;
// Trigger words longest first, then the first date format that fits; exec finds the earliest position in the text.
const RETURN_DATE = new RegExp(
  '\\b(?:until|back on|back|returning on|returning|return on)\\s+(?:' +
    '(?<isoY>\\d{4})-(?<isoM>\\d{2})-(?<isoD>\\d{2})\\b' +
    `|${WEEKDAY_PREFIX}(?<dmD>\\d{1,2})${ORDINAL}\\s+(?<dmM>${MONTH})\\b(?:,?\\s+(?<dmY>\\d{4})\\b)?` +
    `|${WEEKDAY_PREFIX}(?<mdM>${MONTH})\\s+(?<mdD>\\d{1,2})${ORDINAL}\\b(?:,?\\s+(?<mdY>\\d{4})\\b)?` +
    `|(?<weekday>${WEEKDAY})\\b` +
    ')',
  'i',
);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Curly apostrophes become straight ones so "Don’t" and "I’m" match the patterns.
function normalise(text: string): string {
  return text.replace(/[‘’]/g, "'");
}

function headerIsAuto(headers: Record<string, string>): boolean {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'auto-submitted');
  return entry !== undefined && entry[1].trim().toLowerCase() !== 'no';
}

// Null when the parts don't round-trip (31 Feb, 32 Nov).
function utcDate(year: number, monthIndex: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex && date.getUTCDate() === day;
  return valid ? date : null;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// A written year is used as is; otherwise this year's date, or next year's if it is already before today.
function dayMonthDate(day: string, month: string, year: string | undefined, now: Date): Date | null {
  const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (year !== undefined) return utcDate(Number(year), monthIndex, Number(day));
  const thisYear = utcDate(now.getUTCFullYear(), monthIndex, Number(day));
  if (thisYear === null || thisYear >= startOfUtcDay(now)) return thisYear;
  return utcDate(now.getUTCFullYear() + 1, monthIndex, Number(day));
}

// The next such weekday strictly after now's UTC date.
function weekdayDate(weekday: string, now: Date): Date {
  const target = WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase());
  const ahead = (target - now.getUTCDay() + 7) % 7 || 7;
  return new Date(startOfUtcDay(now).getTime() + ahead * DAY_MS);
}

export function findReturnDate(text: string, now: Date): Date | null {
  const groups = RETURN_DATE.exec(normalise(text))?.groups;
  if (!groups) return null;
  if (groups.isoY && groups.isoM && groups.isoD) {
    return utcDate(Number(groups.isoY), Number(groups.isoM) - 1, Number(groups.isoD));
  }
  if (groups.dmD && groups.dmM) return dayMonthDate(groups.dmD, groups.dmM, groups.dmY, now);
  if (groups.mdD && groups.mdM) return dayMonthDate(groups.mdD, groups.mdM, groups.mdY, now);
  if (groups.weekday) return weekdayDate(groups.weekday, now);
  return null;
}

export function classifyByRules(reply: { body: string; headers: Record<string, string> }, now: Date): RuleResult {
  const body = normalise(reply.body);
  if (headerIsAuto(reply.headers)) return { label: 'out_of_office', returnDate: findReturnDate(body, now) };
  if (UNSUBSCRIBE.test(body) && !UNSUBSCRIBE_NEGATION.test(body)) return { label: 'unsubscribe' };
  if (OOO_PHRASE.test(body) && !OOO_DENIAL.test(body)) {
    return { label: 'out_of_office', returnDate: findReturnDate(body, now) };
  }
  return null;
}
