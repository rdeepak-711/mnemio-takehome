'use client';

import { useRef } from 'react';
import type { DeliveryDay, DeliveryPause } from '../../src/web/delivery';
import { useBarGrowth, useCountUp, useEntrance } from '../_anim/motion';
import { fmtInt, fmtTime, type Wire } from './api';

function Count({ value, format = fmtInt }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCountUp(ref, value, format);
  return <span ref={ref}>{format(value)}</span>;
}

function Kpi({ label, title, value, sub }: { label: string; title: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="kpi" title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

const pct = (n: number) => `${n.toFixed(1)}%`;

// The four numbers of the day (D71), counted up like the overview's KPIs.
export function DeliveryKpis({ d }: { d: Wire<DeliveryDay> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEntrance(ref, '.kpi');
  const { totals } = d;
  const top = d.domains[0] ?? null;
  return (
    <div className="kpis kpis-4" ref={ref}>
      <Kpi
        label="Emails today"
        title="Engine sends on this UTC day, bounces included, against the sum of every mailbox's warm-up limit"
        value={<Count value={totals.emails} />}
        sub={`of ${fmtInt(totals.capacity)} capacity`}
      />
      <Kpi
        label="Bounced"
        title="Engine sends on this day that the provider bounced"
        value={<Count value={totals.bounced} />}
        sub={totals.emails === 0 ? 'no sends' : `${pct((totals.bounced / totals.emails) * 100)} of sends`}
      />
      <Kpi
        label="Mailboxes paused"
        title="Mailboxes with a pause covering the end of this day"
        value={<Count value={totals.paused} />}
        sub={`of ${fmtInt(totals.mailboxes)} mailboxes`}
      />
      <Kpi
        label="Busiest domain"
        title="The recipient domain with the most engine sends on this day, against the daily cap per domain"
        value={top ? <Count value={top.emails} /> : 'none'}
        sub={top ? `of ${fmtInt(d.cap ?? 0)} · ${top.domain}` : `cap ${fmtInt(d.cap ?? 0)} per domain`}
      />
    </div>
  );
}

function DomainRow({ domain, emails, scale }: { domain: string; emails: number; scale: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const fraction = scale === 0 ? 0 : Math.min(1, emails / scale);
  useBarGrowth(ref, fraction);
  return (
    <li className="domain-row">
      <span className="domain-name mono">{domain}</span>
      <span className="domain-track" aria-hidden="true">
        <span ref={ref} className="domain-fill" style={{ width: `${fraction * 100}%` }} />
      </span>
      <span className="domain-count">{fmtInt(emails)}</span>
    </li>
  );
}

// The top recipient domains of the day against the per-domain cap (D69). The scale runs past the cap so its line
// stays visible inside the track.
export function DomainBars({ domains, cap }: { domains: Wire<DeliveryDay>['domains']; cap: number }) {
  if (domains.length === 0) return <p className="state">No engine sends on this day.</p>;
  const scale = Math.max(cap, ...domains.map((d) => d.emails)) * 1.25;
  const capAt = `${(cap / scale) * 100}%`;
  return (
    <>
      <ul className="domains" style={{ ['--cap-at' as string]: capAt }}>
        {domains.map((d) => (
          <DomainRow key={d.domain} domain={d.domain} emails={d.emails} scale={scale} />
        ))}
      </ul>
      <p className="legend">
        <span>
          <span className="sw sw-cap" aria-hidden="true" />
          daily cap: {fmtInt(cap)} engine sends per domain
        </span>
      </p>
    </>
  );
}

// Every pause up to the end of the day, newest first (D67).
export function PauseTable({ pauses }: { pauses: Wire<DeliveryPause>[] }) {
  if (pauses.length === 0) {
    return (
      <p className="state">
        No mailbox has paused. A mailbox pauses itself when too many of its recent sends bounce, and starts its warm-up
        again when it comes back.
      </p>
    );
  }
  return (
    <table className="table table-static pauses">
      <thead>
        <tr>
          <th scope="col">Mailbox</th>
          <th scope="col">Paused at</th>
          <th scope="col">Back at</th>
          <th scope="col">Bounce rate</th>
          <th scope="col">Sample</th>
        </tr>
      </thead>
      <tbody>
        {pauses.map((p) => (
          <tr key={`${p.mailboxId}-${p.pausedAt}`}>
            <td data-label="Mailbox" className="email">
              {p.address}
            </td>
            <td data-label="Paused at" className="mono">
              {fmtTime(p.pausedAt)}
            </td>
            <td data-label="Back at" className="mono">
              {fmtTime(p.resumeAt)}
            </td>
            <td data-label="Bounce rate" className="num">
              {pct(p.bounceRate * 100)}
            </td>
            <td data-label="Sample" className="num">
              {fmtInt(p.sample)} sends
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
