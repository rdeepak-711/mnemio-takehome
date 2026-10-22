import { escapeRegExp } from '../regex';

export const ALLOWED_SLOTS = ['first_name', 'last_name', 'company', 'role', 'industry'] as const;
export type Slot = (typeof ALLOWED_SLOTS)[number];

export const SPAM_WORDS: readonly string[] = ['free money', 'guarantee', 'act now', '100% free', 'winner', 'risk-free'];

const MAX_SUBJECT = 120;
const MAX_BODY = 1200;

// {{ name }} with optional spaces; anything else in braces is not a slot.
const SLOT_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function isSlot(name: string): name is Slot {
  return (ALLOWED_SLOTS as readonly string[]).includes(name);
}

// Matches from the start of a word only, so "act now" does not hit "contact now".
const SPAM_PATTERNS = SPAM_WORDS.map((word) => ({ word, pattern: new RegExp(`\\b${escapeRegExp(word)}`, 'i') }));

// One pass, so inserted values are never processed again.
export function render(template: string, vars: Partial<Record<Slot, string>>): string {
  return template.replace(SLOT_PATTERN, (_match, name: string) => {
    if (!isSlot(name)) throw new Error(`Unknown slot: ${name}`);
    const value = vars[name];
    if (value === undefined || value.trim() === '') throw new Error(`Missing value for slot: ${name}`);
    return value;
  });
}

export function findSlots(template: string): string[] {
  const names = [...template.matchAll(SLOT_PATTERN)].map((match) => match[1] as string);
  return [...new Set(names)];
}

export function checkContent(email: { subject: string; body: string }): string[] {
  const problems: string[] = [];
  const { subject, body } = email;

  if (subject.includes('{{') || subject.includes('}}')) problems.push('Subject has leftover {{ or }}');
  if (body.includes('{{') || body.includes('}}')) problems.push('Body has leftover {{ or }}');
  if (subject.trim() === '') problems.push('Subject is empty');
  if (subject.length > MAX_SUBJECT) problems.push(`Subject is over ${MAX_SUBJECT} characters (${subject.length})`);
  if (body.length > MAX_BODY) problems.push(`Body is over ${MAX_BODY} characters (${body.length})`);

  const text = `${subject}\n${body}`;
  for (const { word, pattern } of SPAM_PATTERNS) {
    if (pattern.test(text)) problems.push(`Contains spam word: "${word}"`);
  }

  return problems;
}
