'use client';

import { useRef } from 'react';
import { STATUSES, type Status } from '../../src/lifecycle';
import type { Move } from '../../src/web/journey';
import { useJourneyPlay } from '../_anim/motion';
import { fmtInt, STATUS_LABEL } from './api';

// Where each stage sits: the sequence down the left, the three exits down the right.
const BOX = { w: 132, h: 46 };
const POS: Record<Status, { x: number; y: number }> = {
  new: { x: 90, y: 40 },
  first_sent: { x: 90, y: 135 },
  follow_up_1_sent: { x: 90, y: 230 },
  follow_up_2_sent: { x: 90, y: 325 },
  follow_up_3_sent: { x: 90, y: 420 },
  deactivated: { x: 90, y: 530 },
  replied: { x: 290, y: 150 },
  bounced: { x: 290, y: 300 },
  unsubscribed: { x: 290, y: 450 },
};
const LEFT = new Set<Status>([
  'new',
  'first_sent',
  'follow_up_1_sent',
  'follow_up_2_sent',
  'follow_up_3_sent',
  'deactivated',
]);
const W = 360;
const H = 590;

type Pt = { x: number; y: number };
type Curve = [Pt, Pt, Pt, Pt];

// A cubic curve from one stage's edge to another's. `spread` fans out arrows that share a stage.
function curve(from: Status, to: Status, spread: number): Curve {
  const a = POS[from];
  const b = POS[to];
  if (LEFT.has(from) === LEFT.has(to)) {
    // Same column: bottom edge to top edge; a skip bows out to the left so it doesn't cross the boxes between.
    const down = b.y > a.y;
    const p0 = { x: a.x + spread, y: a.y + (down ? BOX.h / 2 : -BOX.h / 2) };
    const p3 = { x: b.x + spread, y: b.y + (down ? -BOX.h / 2 : BOX.h / 2) };
    const bow = Math.abs(b.y - a.y) > 100 ? -80 : 0;
    return [
      p0,
      { x: p0.x + bow, y: p0.y + (p3.y - p0.y) / 3 },
      { x: p3.x + bow, y: p0.y + (2 * (p3.y - p0.y)) / 3 },
      p3,
    ];
  }
  const right = b.x > a.x;
  const p0 = { x: a.x + (right ? BOX.w / 2 : -BOX.w / 2), y: a.y + spread };
  const p3 = { x: b.x + (right ? -BOX.w / 2 : BOX.w / 2), y: b.y + spread };
  const dx = (p3.x - p0.x) / 2;
  return [p0, { x: p0.x + dx, y: p0.y }, { x: p3.x - dx, y: p3.y }, p3];
}

const path = ([p0, p1, p2, p3]: Curve) => `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
// The curve's point at t = 0.5, where its count label sits.
const mid = ([p0, p1, p2, p3]: Curve): Pt => ({
  x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
  y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
});

// The nine stages, with an arrow per (from → to) move on the selected day labelled with how many contacts moved.
// `counts` are the stage sizes at the end of that day. A new `playKey` animates the moves (after "advance").
export function JourneyMap({
  moves,
  counts,
  playKey,
}: {
  moves: Move[];
  counts: Record<Status, number> | null;
  playKey: number | null;
}) {
  const ref = useRef<SVGSVGElement>(null);
  useJourneyPlay(ref, playKey);
  const max = Math.max(1, ...moves.map((m) => m.count));
  // Arrows touching the same stage are spread a few units apart.
  const seen = new Map<Status, number>();
  const offset = (s: Status) => {
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n === 0 ? 0 : (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * 7;
  };

  return (
    <svg
      ref={ref}
      className="journey-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Contact journey: stages and the moves between them on the selected day"
    >
      <defs>
        {STATUSES.map((s) => (
          <marker
            key={s}
            id={`head-${s}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={`var(--s-${s})`} />
          </marker>
        ))}
      </defs>
      {STATUSES.map((s) => {
        const p = POS[s];
        return (
          <g key={s} className="stage">
            <rect x={p.x - BOX.w / 2} y={p.y - BOX.h / 2} width={BOX.w} height={BOX.h} rx={8} />
            <circle cx={p.x - BOX.w / 2 + 14} cy={p.y - 7} r={4} fill={`var(--s-${s})`} />
            <text x={p.x - BOX.w / 2 + 24} y={p.y - 3}>
              {STATUS_LABEL[s]}
            </text>
            <text className="stage-count" x={p.x - BOX.w / 2 + 24} y={p.y + 14}>
              {counts ? `${fmtInt(counts[s])} contacts` : '…'}
            </text>
          </g>
        );
      })}
      {moves.map((m) => {
        const k = `${m.from}-${m.to}`;
        const c = curve(m.from, m.to, (offset(m.from) + offset(m.to)) / 2);
        const at = mid(c);
        const width = 1.5 + 4.5 * Math.sqrt(m.count / max);
        const label = fmtInt(m.count);
        const lw = 10 + label.length * 7;
        return (
          <g key={k}>
            <path
              data-arrow={k}
              className="arrow"
              d={path(c)}
              stroke={`var(--s-${m.to})`}
              strokeWidth={width}
              markerEnd={`url(#head-${m.to})`}
            />
            <circle data-dot={k} className="journey-dot" r={4.5} cx={0} cy={0} fill={`var(--s-${m.to})`} />
            <g
              data-label={k}
              className="arrow-label"
              style={{ transformOrigin: `${at.x}px ${at.y}px`, transformBox: 'view-box' }}
            >
              <rect x={at.x - lw / 2} y={at.y - 9} width={lw} height={18} rx={9} />
              <text x={at.x} y={at.y + 4} textAnchor="middle">
                {label}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
