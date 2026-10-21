# T06 — Segments

## Goal

Put every contact into one of 20 groups (role family × industry) so the AI writes one sequence per group instead of one per person.

## Files

Create: `src/segments.ts`.
Tests: `tests/unit/segments.test.ts`.

## Behaviour

```ts
export const ROLE_FAMILIES = ['founder','sales','ops_finance','tech'] as const;
export type RoleFamily = typeof ROLE_FAMILIES[number];
export const INDUSTRIES = ['saas','ecommerce','fintech','healthcare','logistics'] as const;
export type Industry = typeof INDUSTRIES[number];
export const ROLE_TITLES: Record<RoleFamily, readonly string[]>;   // the titles the seed draws from
export function roleFamily(title: string): RoleFamily;
export function segmentOf(family: RoleFamily, industry: Industry): string;   // 'founder:saas' (ASCII, safe in cache keys and URLs)
export function allSegments(): string[];   // 20 strings
```

`roleFamily` rules, case-insensitive, checked in this order (first match wins):

1. contains `founder` or `ceo` → `founder`
2. contains `cto`, `technology`, `engineer`, `engineering`, `developer`, `devops` → `tech`
3. contains `sales`, `revenue`, `business development`, `account executive` → `sales`
4. contains `cfo`, `coo`, `finance`, `operations`, `operating`, `ops`, `controller` → `ops_finance`
5. none → `ops_finance` (pinned default)

Match whole words (`\b…\b`), so `cto` doesn't match inside `director` and `ops` doesn't match inside `devops`. `devops` is listed in rule 2 so it maps to `tech`.

`ROLE_TITLES` holds 4–6 realistic titles per family, and every title in it must map back to its own family through `roleFamily` (a test checks this).

## Edge cases

- `"Co-Founder & CEO"` → `founder`.
- `"VP of Engineering"` → `tech`.
- `"Head of Sales"` → `sales`.
- `"CFO"` → `ops_finance`. `"cfo"` (lowercase) → `ops_finance`.
- `"DevOps Lead"` → `tech`.
- `"Chief Technology Officer"` → `tech`. `"Chief Operating Officer"` → `ops_finance` (by rule 4, not the default).
- `"Founder, ex-Sales Director"` → `founder` (order matters).
- `"Chief Happiness Officer"` → `ops_finance` (default).
- `segmentOf('founder','saas')` → `'founder:saas'`. `allSegments()` has 20 unique entries.

## Tests that prove it

Each edge case, and every title in `ROLE_TITLES` round-trips to its family.

Expected failure before the build: `Cannot find module '../../src/segments'`.

## Explain-back

1. Why 20 segments and not 40? (Connect it to the AI budget.)
2. Why does rule order matter? Use "Founder, ex-Sales Director" as the example.
3. What does a contact with an unknown title get, and why pin that in a test?

## Done when

All segment tests pass and `npm run typecheck` is clean.
