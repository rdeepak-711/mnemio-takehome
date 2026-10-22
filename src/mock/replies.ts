import { createHash } from 'node:crypto';
import type { ReplyLabel } from '../labels';

export type ReplyTemplate = { body: string; ambiguous: boolean };

export const RETURN_DATE_TOKEN = '{return_date}';

// Texts are written against src/classify/rules.ts: the rules give null or the true label, never a wrong one (D42).
// Only out_of_office texts carry the token, right after a trigger word findReturnDate knows.
export const REPLY_BANK: Record<ReplyLabel, readonly ReplyTemplate[]> = {
  interested: [
    {
      body: 'Thanks for reaching out. This looks like a good fit for us, can we set up a call next week?',
      ambiguous: false,
    },
    {
      body: 'Good timing, we were just discussing this internally. Send over a few slots for a demo.',
      ambiguous: false,
    },
    { body: "Yes, I'd like to learn more. Who on your team should I talk to?", ambiguous: false },
    { body: 'Could be relevant, what does it cost?', ambiguous: true },
  ],
  not_interested: [
    { body: "Thanks, but we're not looking for anything like this.", ambiguous: false },
    { body: 'We already have a solution in place and are happy with it.', ambiguous: false },
    { body: 'Not a fit for us, but I appreciate you thinking of us.', ambiguous: false },
    { body: 'Not right now, maybe next quarter.', ambiguous: true },
    { body: 'Who gave you my address?', ambiguous: true },
  ],
  out_of_office: [
    {
      body: `Thanks for your email. I am out of the office until ${RETURN_DATE_TOKEN} with limited access to email.`,
      ambiguous: false,
    },
    {
      body: `I'm on annual leave, returning on ${RETURN_DATE_TOKEN}. For urgent matters please contact my colleague.`,
      ambiguous: false,
    },
    { body: 'I am currently out of the office and will reply when I return.', ambiguous: false },
    { body: `On vacation with no access to email. I'll be back on ${RETURN_DATE_TOKEN}.`, ambiguous: false },
    { body: "Travelling for work with patchy signal, I'll get to your message when I can.", ambiguous: true },
    { body: `Travelling until ${RETURN_DATE_TOKEN}, so replies will be slow.`, ambiguous: true },
  ],
  unsubscribe: [
    { body: 'Please unsubscribe me from this list.', ambiguous: false },
    { body: 'Remove me from your mailing list.', ambiguous: false },
    { body: 'Stop emailing me.', ambiguous: false },
    { body: 'Take me off your list, thanks.', ambiguous: false },
    { body: "Please don't email me again.", ambiguous: true },
  ],
};

// A number in [0, 1) from the seed and the parts; the NUL separator keeps ("ab","c") apart from ("a","bc").
export function draw(seed: number, ...parts: string[]): number {
  const digest = createHash('sha256')
    .update([seed, ...parts].join('\u0000'))
    .digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// 'Monday 9 November', in UTC.
export function formatReturnDate(date: Date): string {
  return `${WEEKDAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}
