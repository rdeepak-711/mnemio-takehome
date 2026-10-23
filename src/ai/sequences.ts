import { z } from 'zod';
import { STEPS, type Step } from '../lifecycle';
import type { AiClient, ChatMessage } from './client';
import type { Template } from '../engine/send';
import { ALLOWED_SLOTS, SPAM_WORDS, checkContent, findSlots, render } from '../templates/render';
import { allSegments, type Industry, type RoleFamily } from '../segments';

export const SEQUENCE_PROMPT_VERSION = 'sequence-v2'; // v2: layout rules added after the first live run

// Follow-ups say "my earlier email": a named time span would be wrong whenever a send is late (D47). Not global, so
// .test() keeps no state between calls.
export const TIME_SPAN_PATTERN = /last week|yesterday|days ago|weeks ago/i;

export type Sequence = Record<Step, { subject: string; body: string }>;

// Sample values that every AI template must render cleanly with, before any real contact sees it.
const SAMPLE = {
  first_name: 'Ann',
  last_name: 'Lee',
  company: 'Acme Logistics',
  role: 'Head of Operations',
  industry: 'logistics',
} as const;

const EmailSchema = z.object({ subject: z.string(), body: z.string() });

// Problems with one step; an empty list means the step is fine.
function stepProblems(email: { subject: string; body: string }): string[] {
  const unknown = [...findSlots(email.subject), ...findSlots(email.body)].filter(
    (slot) => !(ALLOWED_SLOTS as readonly string[]).includes(slot),
  );
  if (unknown.length > 0) return [`unknown slot: ${unknown.join(', ')}`];
  if (!email.body.includes('{{first_name}}')) return ['body has no {{first_name}}'];
  // Found live: a model wrote each email as one run-on line ending "… today? Sam", which passed every other check.
  if (!email.body.includes('\n\n')) return ['body has no blank line between paragraphs'];
  if (email.body.trimEnd().split('\n').at(-1)?.trim() !== 'Sam') return ['last line is not "Sam"'];
  if (TIME_SPAN_PATTERN.test(email.subject) || TIME_SPAN_PATTERN.test(email.body)) return ['names a time span'];
  try {
    return checkContent({ subject: render(email.subject, SAMPLE), body: render(email.body, SAMPLE) });
  } catch (error) {
    return [error instanceof Error ? error.message : 'does not render'];
  }
}

// z.object drops extra keys, so a model that adds "notes" still gives exactly the four steps.
export const SequenceSchema: z.ZodType<Sequence> = z
  .object({ first: EmailSchema, follow_up_1: EmailSchema, follow_up_2: EmailSchema, follow_up_3: EmailSchema })
  .superRefine((sequence, ctx) => {
    for (const step of STEPS) {
      for (const problem of stepProblems(sequence[step]))
        ctx.addIssue({ code: 'custom', path: [step], message: problem });
    }
    if (new Set(STEPS.map((step) => sequence[step].body)).size !== STEPS.length) {
      ctx.addIssue({ code: 'custom', message: 'two steps share the same body' });
    }
  });

const AUDIENCE: Record<RoleFamily, string> = {
  founder: 'founders and CEOs',
  sales: 'sales leaders (heads of sales, VPs of sales, revenue leaders)',
  ops_finance: 'operations and finance leaders (COOs, CFOs, heads of operations)',
  tech: 'technical leaders (CTOs, heads of engineering, engineering leads)',
};

const INDUSTRY_WORDS: Record<Industry, string> = {
  saas: 'SaaS',
  ecommerce: 'e-commerce',
  fintech: 'fintech',
  healthcare: 'healthcare',
  logistics: 'logistics',
};

const SYSTEM_PROMPT = [
  'You write short, plain cold outreach emails for Sam, who helps teams with their follow-up emails.',
  'You write templates: the sender fills in each contact’s details afterwards, so use slots, not made-up names.',
  'Answer with only a JSON object, no other text.',
].join('\n');

export function sequenceMessages(segment: string): ChatMessage[] {
  const [family, industry] = segment.split(':') as [RoleFamily, Industry];
  const audience = `${AUDIENCE[family] ?? family} at ${INDUSTRY_WORDS[industry] ?? industry} companies`;
  const slots = ALLOWED_SLOTS.map((slot) => `{{${slot}}}`).join(', ');
  const user = [
    `Write a four-email sequence to ${audience}.`,
    'The pitch: Sam helps teams handle their follow-up emails, and would like a short call. Sign every email "Sam".',
    '',
    'Emails, in order:',
    '- first: the first email, a short question about how {{company}} handles follow-up emails today.',
    '- follow_up_1: a brief nudge that refers to "my earlier email".',
    '- follow_up_2: one more note that refers to "my earlier email" and adds one useful point.',
    '- follow_up_3: closes the loop politely, says this is the last email, and leaves the door open.',
    '',
    'Rules:',
    '- Plain and short. No marketing language.',
    '- Every body starts by greeting the reader with {{first_name}}, for example "Hi {{first_name}},".',
    '- Layout: the greeting on its own line, then a blank line between paragraphs.',
    '- End with a sign-off line such as "Thanks," and then "Sam" alone on the last line.',
    `- Use only these slots, written exactly like this: ${slots}. No other braces anywhere.`,
    '- Subject at most 120 characters, body at most 1200 characters. Every subject is non-empty.',
    `- Never use these phrases: ${SPAM_WORDS.map((word) => `"${word}"`).join(', ')}.`,
    '- Follow-ups refer to "my earlier email" and never name a time span (no "last week", "yesterday", "days ago").',
    '- The four bodies must all be different.',
    '',
    'Answer with only this JSON, nothing else:',
    '{"first":{"subject":"…","body":"…"},"follow_up_1":{"subject":"…","body":"…"},' +
      '"follow_up_2":{"subject":"…","body":"…"},"follow_up_3":{"subject":"…","body":"…"}}',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export type SequenceWriter = { getTemplate: (segment: string, step: Step) => Promise<Template | null> };

type Answer = { sequence: Sequence; source: 'ai' | 'cache' } | null;

export function createSequenceWriter(ai: AiClient): SequenceWriter {
  const known = new Set(allSegments());
  // One promise per segment, shared by every contact of that segment in this tick, failures included (D51).
  const answers = new Map<string, Promise<Answer>>();

  async function ask(segment: string): Promise<Answer> {
    try {
      const result = await ai.complete({
        kind: 'sequence',
        promptVersion: SEQUENCE_PROMPT_VERSION,
        input: segment,
        messages: sequenceMessages(segment),
        schema: SequenceSchema,
      });
      return result ? { sequence: result.value, source: result.source } : null;
    } catch {
      return null; // a thrown error here would roll back a send batch, letting the AI stop the run (D51)
    }
  }

  return {
    getTemplate: async (segment, step) => {
      if (!known.has(segment)) return null;
      let answer = answers.get(segment);
      if (!answer) {
        answer = ask(segment);
        answers.set(segment, answer);
      }
      const result = await answer;
      if (!result) return null;
      const email = result.sequence[step];
      return { subject: email.subject, body: email.body, source: result.source };
    },
  };
}
