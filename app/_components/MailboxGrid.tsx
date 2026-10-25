'use client';

import { useRef } from 'react';
import type { MailboxDay } from '../../src/web/delivery';
import { useFillGrow } from '../_anim/motion';
import { fmtInt, type Wire } from './api';

// "12 Nov", in UTC like every simulated time on the dashboard.
export const fmtShortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

function label(m: Wire<MailboxDay>): string {
  const parts = [`${m.address}: ${fmtInt(m.emails)} of ${fmtInt(m.limit)} sent`, `${fmtInt(m.bounced)} bounced`];
  if (m.paused) parts.push(m.pausedUntil ? `paused until ${fmtShortDate(m.pausedUntil)}` : 'paused');
  return parts.join(', ');
}

// One tile per mailbox that existed by the end of the day: its engine sends against that day's warm-up limit, the
// bounced part on top of the fill, and a danger border when a pause covers the end of the day (D71).
export function MailboxGrid({ mailboxes, playKey }: { mailboxes: Wire<MailboxDay>[]; playKey: number | null }) {
  const ref = useRef<HTMLUListElement>(null);
  useFillGrow(ref, playKey);
  if (mailboxes.length === 0) {
    return <p className="state">No mailboxes yet. They are created on the first send with deliverability on.</p>;
  }
  return (
    <ul className="mb-grid" ref={ref}>
      {mailboxes.map((m) => {
        const fill = m.limit === 0 ? 0 : Math.min(1, m.emails / m.limit);
        const red = m.emails === 0 ? 0 : m.bounced / m.emails;
        return (
          <li key={m.id} className={m.paused ? 'mb-tile mb-paused' : 'mb-tile'}>
            <div role="img" aria-label={label(m)} title={label(m)} className="mb-inner">
              <span className="mb-id" aria-hidden="true">
                {String(m.id).padStart(2, '0')}
              </span>
              <span className="mb-track" aria-hidden="true">
                <span className="mb-fill" data-grow="" style={{ height: `${fill * 100}%` }}>
                  {red > 0 && <span className="mb-bounce" style={{ height: `${red * 100}%` }} />}
                </span>
              </span>
              <span className="mb-count" aria-hidden="true">
                {m.emails}/{m.limit}
              </span>
              {/* Always present, so every tile in a row has the same height. */}
              <span className="mb-flag" aria-hidden="true">
                {m.paused ? 'paused' : ''}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
