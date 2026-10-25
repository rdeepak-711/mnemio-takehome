'use client';

import { useEffect, useRef, useState } from 'react';
import type { TimelineDay } from '../../src/web/timeline';
import { fmtDay, fmtInt, type Wire } from './api';

const W = 800; // viewBox width; the SVG scales to its container
const PAD_L = 4;
const PAD_R = 4;
const SENDS_H = 150;
const EVENTS_H = 70;
const TEXT_PX = 11.5; // on-screen size of every label, whatever the chart's width

function describe(d: Wire<TimelineDay>): string {
  return `${d.day}, ${d.phase === 'history' ? 'seeded history' : 'simulated'}: ${d.firstEmails} first emails, ${d.followUps} follow-ups, ${d.replies} replies, ${d.bounces} bounces, ${d.unsubscribes} unsubscribes`;
}

// Per day: first emails and follow-ups stacked (top), replies and bounces (bottom, own scale). Faded, hatched bars are
// seeded history; solid bars are days the engine simulated. Clicking a bar selects that day.
export function ActivityChart({
  days,
  selected,
  onSelect,
}: {
  days: Wire<TimelineDay>[];
  selected: string | null;
  onSelect: (day: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Rendered width ÷ viewBox width. Text is sized in viewBox units, so it is divided by this to stay TEXT_PX on screen.
  const [scale, setScale] = useState(0.7);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const w = svg.getBoundingClientRect().width;
      if (w > 0) setScale(w / W);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // The layout leaves room for text of that size: a caption row on top, the date axis between the panels, a caption
  // row at the bottom.
  const font = TEXT_PX / scale;
  const TOP = font * 1.6; // top of the sends panel
  const BASE = TOP + SENDS_H; // the sends panel grows up from here
  const EV_TOP = BASE + font * 2; // the replies and bounces panel grows down from here
  const H = EV_TOP + EVENTS_H + font * 1.7;

  const n = days.length;
  const plotW = W - PAD_L - PAD_R;
  const step = plotW / Math.max(1, n);
  const barW = Math.max(1, Math.min(18, step * 0.72));
  const maxSends = Math.max(1, ...days.map((d) => d.firstEmails + d.followUps));
  const maxEvents = Math.max(1, ...days.map((d) => d.replies + d.bounces));
  const sy = (v: number) => (v / maxSends) * SENDS_H;
  const ey = (v: number) => (v / maxEvents) * EVENTS_H;
  const firstSim = days.findIndex((d) => d.phase === 'simulated');
  const shown = hover === null ? null : days[hover];
  // A date label ("11-04", about 3.2em wide in the mono font) every few days, with a gap between labels.
  const labelEvery = Math.max(1, Math.ceil((font * 4.5) / step));
  const lastRegular = Math.floor((n - 1) / labelEvery) * labelEvery;
  const divX = PAD_L + step * firstSim;
  // The "simulation starts" label sits to the right of its line, or to the left when the line is near the right edge.
  const divRight = divX < W * 0.7;

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        style={{ fontSize: `${font}px` }}
        role="group"
        aria-label="Daily activity"
      >
        <defs>
          <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="2" height="4" fill="rgba(11,15,20,0.55)" />
          </pattern>
        </defs>
        <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={TOP} y2={TOP} />
        <text x={PAD_L} y={TOP - font * 0.45}>
          emails sent · top line {fmtInt(maxSends)}
        </text>
        <line className="axis" x1={PAD_L} x2={W - PAD_R} y1={BASE} y2={BASE} />
        <line className="axis" x1={PAD_L} x2={W - PAD_R} y1={EV_TOP} y2={EV_TOP} />
        <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={EV_TOP + EVENTS_H} y2={EV_TOP + EVENTS_H} />
        <text x={PAD_L} y={EV_TOP + EVENTS_H + font * 1.2}>
          replies and bounces · bottom line {fmtInt(maxEvents)}
        </text>
        {days.map((d, i) => {
          const regular = i % labelEvery === 0;
          // The last day gets a label too, unless it would crowd the one before it. It is end-anchored, so it reaches
          // a whole label width left of its x, and the previous (centred) one reaches half a width right of its own.
          const last = i === n - 1 && (i - lastRegular) * step >= font * 5.5;
          if (!regular && !last) return null;
          const x = PAD_L + step * i + step / 2;
          const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
          return (
            <text
              key={d.day}
              x={i === 0 ? PAD_L : i === n - 1 ? W - PAD_R : x}
              y={BASE + font * 1.35}
              textAnchor={anchor}
            >
              {d.day.slice(5)}
            </text>
          );
        })}
        {days.map((d, i) => {
          const x0 = PAD_L + step * i;
          const x = x0 + (step - barW) / 2;
          const hFirst = sy(d.firstEmails);
          const hFollow = sy(d.followUps);
          const hReply = ey(d.replies);
          const hBounce = ey(d.bounces);
          const history = d.phase === 'history';
          const cls = `day${history ? ' history' : ''}${selected === d.day ? ' selected' : ''}`;
          return (
            <g
              key={d.day}
              className={cls}
              tabIndex={0}
              role="button"
              aria-label={describe(d)}
              aria-pressed={selected === d.day}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(d.day)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(d.day);
                }
              }}
            >
              <rect className="hit" x={x0} y={TOP} width={step} height={EV_TOP + EVENTS_H - TOP} />
              <rect className="b" x={x} y={BASE - hFirst} width={barW} height={hFirst} fill="var(--c-first)" />
              <rect
                className="b"
                x={x}
                y={BASE - hFirst - hFollow}
                width={barW}
                height={hFollow}
                fill="var(--c-follow)"
              />
              <rect className="b" x={x} y={EV_TOP} width={barW} height={hReply} fill="var(--c-reply)" />
              <rect className="b" x={x} y={EV_TOP + hReply} width={barW} height={hBounce} fill="var(--c-bounce)" />
              {history && (
                <>
                  <rect x={x} y={BASE - hFirst - hFollow} width={barW} height={hFirst + hFollow} fill="url(#hatch)" />
                  <rect x={x} y={EV_TOP} width={barW} height={hReply + hBounce} fill="url(#hatch)" />
                </>
              )}
            </g>
          );
        })}
        {firstSim > 0 && (
          // Drawn after the bars so the label sits on top of them; it never takes a click meant for a bar.
          <g pointerEvents="none">
            <line className="divider" x1={divX} x2={divX} y1={TOP} y2={EV_TOP + EVENTS_H} />
            <text
              x={divRight ? divX + font * 0.5 : divX - font * 0.5}
              y={TOP + font * 1.2}
              textAnchor={divRight ? 'start' : 'end'}
              style={{ fill: 'var(--warn)', stroke: 'var(--bg)', strokeWidth: font * 0.3, paintOrder: 'stroke' }}
            >
              simulation starts
            </text>
          </g>
        )}
      </svg>
      {shown && hover !== null && (
        <div
          className="tooltip"
          style={{ left: `${Math.min(70, Math.max(0, ((PAD_L + step * hover) / W) * 100 - 10))}%`, top: 0 }}
          role="presentation"
        >
          <strong>{fmtDay(shown.day)}</strong>{' '}
          <span className="kpi-sub">{shown.phase === 'history' ? 'seeded history' : 'simulated'}</span>
          <dl>
            <dt>First emails</dt>
            <dd>{fmtInt(shown.firstEmails)}</dd>
            <dt>Follow-ups</dt>
            <dd>{fmtInt(shown.followUps)}</dd>
            <dt>Replies</dt>
            <dd>{fmtInt(shown.replies)}</dd>
            <dt>Bounces</dt>
            <dd>{fmtInt(shown.bounces)}</dd>
            <dt>Unsubscribes</dt>
            <dd>{fmtInt(shown.unsubscribes)}</dd>
            <dt>Entered / left</dt>
            <dd>
              {fmtInt(shown.entered)} / {fmtInt(shown.left)}
            </dd>
          </dl>
        </div>
      )}
      <div className="legend">
        <span>
          <i className="sw" style={{ background: 'var(--c-first)' }} /> First emails
        </span>
        <span>
          <i className="sw" style={{ background: 'var(--c-follow)' }} /> Follow-ups
        </span>
        <span>
          <i className="sw" style={{ background: 'var(--c-reply)' }} /> Replies
        </span>
        <span>
          <i className="sw" style={{ background: 'var(--c-bounce)' }} /> Bounces
        </span>
        <span>
          <i className="sw sw-history" /> Seeded history (faded, hatched)
        </span>
        <span>
          <i className="sw sw-sim" /> Simulated by the engine (solid)
        </span>
      </div>
    </div>
  );
}
