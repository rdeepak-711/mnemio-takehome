'use client';

import { useRef } from 'react';
import { LABELS } from '../../src/labels';
import type { Accuracy } from '../../src/report';
import type { ClassifierStats } from '../../src/web/classifier';
import { useBarGrowth } from '../_anim/motion';
import { LABEL_NAME, fmtInt, type Wire } from './api';

// "N of M correct (P%)", or "nothing labelled yet" when M = 0.
export function accuracyText(a: Accuracy): string {
  if (a.labelled === 0) return 'nothing labelled yet';
  return `${fmtInt(a.correct)} of ${fmtInt(a.labelled)} correct (${((a.correct / a.labelled) * 100).toFixed(1)}%)`;
}

const pct = (n: number, of: number) => (of === 0 ? '0.0%' : `${((n / of) * 100).toFixed(1)}%`);

// One labelled bar: name, track, count and its share of `of`. The name is always shown next to the colour.
export function ShareBar({ name, cls, n, of }: { name: string; cls: string; n: number; of: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const fraction = of === 0 ? 0 : n / of;
  useBarGrowth(ref, fraction);
  return (
    <div className="share-row">
      <span className="share-name">
        <span className={`dot ${cls}`} aria-hidden="true" />
        {name}
      </span>
      <span className="bar-track" aria-hidden="true">
        <span ref={ref} className={`bar-fill ${cls}`} style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="share-count">
        {fmtInt(n)} <span className="kpi-sub">{pct(n, of)}</span>
      </span>
    </div>
  );
}

// Count and share per predicted label, then rule and AI accuracy against the mock's hidden label (D60).
export function ClassifierBars({ s }: { s: Wire<ClassifierStats> }) {
  return (
    <>
      <div className="shares" aria-label="Replies per predicted label">
        {LABELS.map((l) => (
          <ShareBar key={l} name={LABEL_NAME[l] ?? l} cls={`l-${l}`} n={s.byLabel[l]} of={s.total} />
        ))}
      </div>
      <dl className="accuracy">
        <dt>Rules</dt>
        <dd>{accuracyText(s.accuracy.rule)}</dd>
        <dt>AI</dt>
        <dd>{accuracyText(s.accuracy.ai)}</dd>
      </dl>
    </>
  );
}
