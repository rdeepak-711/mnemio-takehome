'use client';

import { useRef } from 'react';
import type { Count } from '../../src/report';
import type { Summary } from '../../src/web/summary';
import { useCountUp, useEntrance } from '../_anim/motion';
import { fmtInt, type Wire } from './api';

function Number_({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, format);
  return <span ref={ref}>{format(value)}</span>;
}

function Kpi({ label, value, title }: { label: string; value: number; title: string }) {
  return (
    <div className="kpi" title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        <Number_ value={value} format={fmtInt} />
      </div>
    </div>
  );
}

const pctOf = (c: Count) => (c.of === 0 ? 0 : (c.count / c.of) * 100);

function Rate({ label, rate, title }: { label: string; rate: Count; title: string }) {
  return (
    <div className="kpi" title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        {rate.of === 0 ? 'n/a' : <Number_ value={pctOf(rate)} format={(n) => `${n.toFixed(1)}%`} />}
      </div>
      <div className="kpi-sub">
        {fmtInt(rate.count)} of {fmtInt(rate.of)}
      </div>
    </div>
  );
}

// The nine numbers for the selected day, as of the end of that simulated day (D57).
export function Kpis({ s }: { s: Wire<Summary> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEntrance(ref, '.kpi');
  return (
    <div className="kpis" ref={ref}>
      <Kpi label="Total contacts" value={s.total} title="Contacts created by the end of this day" />
      <Kpi label="Emails sent" value={s.sent} title="Every send so far, accepted or bounced" />
      <Kpi label="Replies" value={s.replies} title="Replies received so far" />
      <Kpi label="Bounces" value={s.bounces} title="Sends the provider bounced" />
      <Kpi label="Unsubscribes" value={s.unsubscribed} title="Contacts whose status is unsubscribed" />
      <Kpi label="Active" value={s.active} title="Contacts still in the sequence (new to follow-up 3)" />
      <Kpi label="Deactivated" value={s.deactivated} title="No answer after the last follow-up" />
      <Rate
        label="Reply rate"
        rate={s.replyRate}
        title="Contacts who replied, of contacts with an accepted send (as in the report)"
      />
      <Rate label="Bounce rate" rate={s.bounceRate} title="Bounced sends, of all sends" />
    </div>
  );
}
