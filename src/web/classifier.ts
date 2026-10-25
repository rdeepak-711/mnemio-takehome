import type { Queryable } from '../clock';
import { LABELS, REPLY_LABELS, type Label } from '../labels';
import type { Accuracy } from '../report';
import { dayKey } from './days';

export type ClassifierExample = {
  id: number;
  contactId: number;
  body: string;
  label: Label;
  labelSource: string;
  trueLabel: string; // the mock's hidden label, used for scoring (D12)
  receivedAt: Date;
  classifiedAt: Date;
};
export type ClassifierStats = {
  simStart: string;
  total: number; // labelled replies with classified_at >= simStart
  excludedSeeded: number; // labelled replies with classified_at < simStart
  unlabelled: number;
  byLabel: Record<Label, number>;
  bySource: { rule: number; ai: number; fallback: number };
  accuracy: { rule: Accuracy; ai: Accuracy };
  confusion: { trueLabel: string; label: string; count: number }[];
  examples: Record<Label, ClassifierExample[]>;
};

const EXAMPLES_PER_LABEL = 3;

// $1 = simStart. The replies the seed labelled (before SIM_START) and the ones still waiting are only counted.
const COUNTS_SQL = `
  SELECT count(*) FILTER (WHERE label IS NOT NULL AND classified_at >= $1)::int AS total,
         count(*) FILTER (WHERE label IS NOT NULL AND classified_at < $1)::int AS excluded,
         count(*) FILTER (WHERE label IS NULL)::int AS unlabelled
    FROM replies`;

// Every count the page shows comes from this one grouping (true label × predicted label × source), scoped like the
// report's classifier line (D54, D60).
const CELLS_SQL = `
  SELECT true_label AS "trueLabel", label, label_source AS source, count(*)::int AS n
    FROM replies
   WHERE label IS NOT NULL AND classified_at >= $1
   GROUP BY 1, 2, 3`;

// $2 = how many per label: the newest classifications first.
const EXAMPLES_SQL = `
  SELECT id, "contactId", body, label, "labelSource", "trueLabel", "receivedAt", "classifiedAt"
    FROM (
      SELECT id, contact_id AS "contactId", body, label, label_source AS "labelSource", true_label AS "trueLabel",
             received_at AS "receivedAt", classified_at AS "classifiedAt",
             row_number() OVER (PARTITION BY label ORDER BY classified_at DESC, id DESC) AS rn
        FROM replies
       WHERE label IS NOT NULL AND classified_at >= $1
    ) ranked
   WHERE rn <= $2
   ORDER BY label, "classifiedAt" DESC, id DESC`;

type Cell = { trueLabel: string; label: string; source: string; n: number };

const isLabel = (v: string): v is Label => (LABELS as readonly string[]).includes(v);
// Unknown values sort last.
const rank = (list: readonly string[], v: string) => (list.includes(v) ? list.indexOf(v) : list.length);

// How the engine's own labels did since SIM_START, against the mock's hidden label (D60).
export async function classifierStats(db: Queryable, simStart: Date): Promise<ClassifierStats> {
  const [counts, cells, examples] = await Promise.all([
    db.query<{ total: number; excluded: number; unlabelled: number }>(COUNTS_SQL, [simStart]),
    db.query<Cell>(CELLS_SQL, [simStart]),
    db.query<ClassifierExample>(EXAMPLES_SQL, [simStart, EXAMPLES_PER_LABEL]),
  ]);

  const byLabel = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;
  const bySource = { rule: 0, ai: 0, fallback: 0 };
  const accuracy = { rule: { labelled: 0, correct: 0 }, ai: { labelled: 0, correct: 0 } };
  const confusion = new Map<string, { trueLabel: string; label: string; count: number }>();
  for (const c of cells.rows) {
    if (isLabel(c.label)) byLabel[c.label] += c.n;
    if (c.source === 'rule' || c.source === 'ai' || c.source === 'fallback') bySource[c.source] += c.n;
    if (c.source === 'rule' || c.source === 'ai') {
      accuracy[c.source].labelled += c.n;
      if (c.label === c.trueLabel) accuracy[c.source].correct += c.n;
    }
    const k = `${c.trueLabel}\u0000${c.label}`;
    const cell = confusion.get(k) ?? { trueLabel: c.trueLabel, label: c.label, count: 0 };
    cell.count += c.n;
    confusion.set(k, cell);
  }

  const byExample = Object.fromEntries(LABELS.map((l) => [l, []])) as unknown as Record<Label, ClassifierExample[]>;
  for (const e of examples.rows) if (isLabel(e.label)) byExample[e.label].push(e);

  const row = counts.rows[0];
  return {
    simStart: dayKey(simStart),
    total: row?.total ?? 0,
    excludedSeeded: row?.excluded ?? 0,
    unlabelled: row?.unlabelled ?? 0,
    byLabel,
    bySource,
    accuracy,
    confusion: [...confusion.values()].sort(
      (a, b) =>
        rank(REPLY_LABELS, a.trueLabel) - rank(REPLY_LABELS, b.trueLabel) ||
        rank(LABELS, a.label) - rank(LABELS, b.label),
    ),
    examples: byExample,
  };
}
