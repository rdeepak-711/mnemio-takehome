export const ROLE_FAMILIES = ['founder', 'sales', 'ops_finance', 'tech'] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];
export const INDUSTRIES = ['saas', 'ecommerce', 'fintech', 'healthcare', 'logistics'] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const ROLE_TITLES: Record<RoleFamily, readonly string[]> = {
  founder: ['Founder', 'Co-Founder', 'CEO', 'Founder & CEO', 'Co-Founder & Managing Director'],
  sales: [
    'Head of Sales',
    'VP of Sales',
    'Chief Revenue Officer',
    'Account Executive',
    'Business Development Manager',
    'Sales Director',
  ],
  ops_finance: ['CFO', 'COO', 'Head of Operations', 'Finance Manager', 'Financial Controller', 'VP of Finance'],
  tech: [
    'CTO',
    'VP of Engineering',
    'Head of Engineering',
    'Senior Software Engineer',
    'DevOps Lead',
    'Lead Developer',
  ],
};

const DEFAULT_FAMILY: RoleFamily = 'ops_finance';

// Checked top to bottom; the first family with a matching keyword wins.
const RULES: readonly { family: RoleFamily; keywords: readonly string[] }[] = [
  { family: 'founder', keywords: ['founder', 'ceo'] },
  { family: 'tech', keywords: ['cto', 'technology', 'engineer', 'engineering', 'developer', 'devops'] },
  { family: 'sales', keywords: ['sales', 'revenue', 'business development', 'account executive'] },
  { family: 'ops_finance', keywords: ['cfo', 'coo', 'finance', 'operations', 'operating', 'ops', 'controller'] },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole words only, so "cto" misses "director" and "ops" misses "devops".
const PATTERNS = RULES.map(({ family, keywords }) => ({
  family,
  patterns: keywords.map((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i')),
}));

export function roleFamily(title: string): RoleFamily {
  const rule = PATTERNS.find(({ patterns }) => patterns.some((pattern) => pattern.test(title)));
  return rule ? rule.family : DEFAULT_FAMILY;
}

export function segmentOf(family: RoleFamily, industry: Industry): string {
  return `${family}:${industry}`;
}

export function allSegments(): string[] {
  return ROLE_FAMILIES.flatMap((family) => INDUSTRIES.map((industry) => segmentOf(family, industry)));
}
