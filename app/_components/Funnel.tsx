'use client';

import { useRef } from 'react';
import type { Status } from '../../src/lifecycle';
import type { Summary } from '../../src/web/summary';
import { useBarGrowth } from '../_anim/motion';
import { fmtInt, STATUS_LABEL, type Wire } from './api';

const MAIN: Status[] = ['new', 'first_sent', 'follow_up_1_sent', 'follow_up_2_sent', 'follow_up_3_sent', 'deactivated'];
const EXITS: Status[] = ['replied', 'bounced', 'unsubscribed'];

function Bar({ status, count, total }: { status: Status; count: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const fraction = total === 0 ? 0 : count / total;
  useBarGrowth(ref, fraction);
  return (
    <div className="bar-row">
      <span className={`bar-name badge s-${status}`}>
        <span className="dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
      <div className="bar-track" aria-hidden="true">
        <div ref={ref} className={`bar-fill fill-${status}`} style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="bar-count">{fmtInt(count)}</span>
    </div>
  );
}

// Where every contact stands at the end of the selected day: the sequence, then the three exits.
export function Funnel({ s }: { s: Wire<Summary> }) {
  return (
    <div className="funnel" aria-label={`Funnel for ${s.day}`}>
      {MAIN.map((st) => (
        <Bar key={st} status={st} count={s.statuses[st]} total={s.total} />
      ))}
      <div className="funnel-group">Exits</div>
      {EXITS.map((st) => (
        <Bar key={st} status={st} count={s.statuses[st]} total={s.total} />
      ))}
    </div>
  );
}
