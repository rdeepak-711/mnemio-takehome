'use client';

import { useRef } from 'react';
import type { Status } from '../../src/lifecycle';
import type { Summary } from '../../src/web/summary';
import { useBarGrowth } from '../_anim/motion';
import { fmtInt, STATUS_LABEL, type Wire } from './api';

const MAIN: Status[] = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent', 'deactivated'];
const EXITS: Status[] = ['replied', 'bounced', 'unsubscribed'];

function Bar({
  status,
  count,
  total,
  onSelect,
}: {
  status: Status;
  count: number;
  total: number;
  onSelect?: (status: Status) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const fraction = total === 0 ? 0 : count / total;
  useBarGrowth(ref, fraction);
  const inner = (
    <>
      <span className={`bar-name badge s-${status}`}>
        <span className="dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
      <span className="bar-track" aria-hidden="true">
        <span ref={ref} className={`bar-fill fill-${status}`} style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="bar-count">{fmtInt(count)}</span>
    </>
  );
  // With onSelect each bar is a button that opens the stage drill-down (D62).
  return onSelect ? (
    <button
      type="button"
      className="bar-row bar-button"
      onClick={() => onSelect(status)}
      aria-label={`${STATUS_LABEL[status]}: ${fmtInt(count)} contacts. Show who`}
    >
      {inner}
    </button>
  ) : (
    <div className="bar-row">{inner}</div>
  );
}

// Where every contact stands at the end of the selected day: the sequence, then the three exits.
export function Funnel({ s, onSelect }: { s: Wire<Summary>; onSelect?: (status: Status) => void }) {
  return (
    <div className="funnel" aria-label={`Funnel for ${s.day}`}>
      {MAIN.map((st) => (
        <Bar key={st} status={st} count={s.statuses[st]} total={s.total} onSelect={onSelect} />
      ))}
      <div className="funnel-group">Exits</div>
      {EXITS.map((st) => (
        <Bar key={st} status={st} count={s.statuses[st]} total={s.total} onSelect={onSelect} />
      ))}
    </div>
  );
}
