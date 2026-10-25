'use client';

import { useMemo, useRef } from 'react';
import type { HourRow } from '../../src/web/delivery';
import { REGIONS, REGION_NAME, dotSize, dotsFor, type Region } from '../../src/web/delivery-view';
import { useStripPlay } from '../_anim/motion';
import { fmtInt } from './api';

// Geometry of the strip, in viewBox units. A narrow mailbox bank, the lane names, then 4 lanes × 24 UTC hours.
const TOP = 22; // room for the hour labels
const BANK = { x: 2, w: 40 };
const LABEL_X = 54;
const GRID_X = 132;
const COL = 30;
const LANE = 32;
const W = GRID_X + 24 * COL + 2;
const H = TOP + REGIONS.length * LANE + 4;
// Up to 12 dots per cell: 4 across, 3 down.
const PER_ROW = 4;
const GAP = 6.5;
const R = 2.3;
const DROP = 3; // a bounced dot drops this far below its place
// The dot colours as presentation attributes, so the play can turn a dot red. Same values as --accent and
// --c-bounce in globals.css.
const SENT = '#5eead4';
const BOUNCED = '#f87171';

const hh = (h: number) => String(h).padStart(2, '0');
const emails = (n: number) => `${fmtInt(n)} ${n === 1 ? 'email' : 'emails'}`;
export const hourSpan = (h: number) => `${hh(h)}:00–${hh(h + 1)}:00 UTC`;

type Dot = { key: string; hour: number; cx: number; cy: number; bounced: boolean };

// The lane holding an hour's bounced dots: its busiest lane, the first in display order on a tie.
function busiestLane(h: HourRow): Region {
  return REGIONS.reduce((best, r) => (h.regions[r] > h.regions[best] ? r : best), REGIONS[0]);
}

function layout(hours: HourRow[]) {
  const maxCell = Math.max(0, ...hours.flatMap((h) => REGIONS.map((r) => h.regions[r])));
  const size = dotSize(maxCell);
  const dots: Dot[] = [];
  for (const h of hours) {
    const lane = busiestLane(h);
    REGIONS.forEach((r, li) => {
      const n = dotsFor(h.regions[r], size);
      // The hour's bounced share, as dots in its busiest lane (never more than that cell has).
      const red = r === lane ? Math.min(n, dotsFor(h.bounced, size)) : 0;
      const x0 = GRID_X + h.hour * COL + (COL - (PER_ROW - 1) * GAP) / 2;
      const y0 = TOP + li * LANE + (LANE - 2 * GAP) / 2 - 1;
      for (let k = 0; k < n; k++) {
        dots.push({
          key: `${h.hour}-${r}-${k}`,
          hour: h.hour,
          cx: x0 + (k % PER_ROW) * GAP,
          cy: y0 + Math.floor(k / PER_ROW) * GAP,
          bounced: k >= n - red,
        });
      }
    });
  }
  return { size, dots };
}

// The selected day hour by hour (D71). Each dot stands for `size` emails of one hour and one recipient region, from
// the day's engine sends; nothing is drawn that is not in `hours`. Remount it (key) for new data.
export function SendStrip({
  hours,
  mailboxes,
  playKey,
  lastHour = 23,
}: {
  hours: HourRow[];
  mailboxes: number;
  playKey: number | null;
  lastHour?: number; // on the clock's own day, the clock's UTC hour: the later hours haven't been simulated yet
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { size, dots } = useMemo(() => layout(hours), [hours]);
  useStripPlay(svgRef, playKey, { sent: SENT, bounced: BOUNCED });
  const bankY = TOP + (REGIONS.length * LANE) / 2;
  const total = hours.reduce((s, h) => s + h.emails, 0);

  return (
    <>
      <div className="strip-scroll">
        <svg
          ref={svgRef}
          className="strip"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          data-bank-x={BANK.x + BANK.w}
          data-bank-y={bankY}
          role="img"
          aria-label={`${emails(total)} by UTC hour and recipient region; the table after this chart lists every number.`}
        >
          {Array.from({ length: 8 }, (_, i) => i * 3).map((h) => (
            <text key={h} className="strip-hour" x={GRID_X + h * COL} y={TOP - 8}>
              {hh(h)}
            </text>
          ))}
          <g className="strip-bank">
            <rect x={BANK.x} y={TOP} width={BANK.w} height={REGIONS.length * LANE - 2} rx={5} />
            <text transform={`translate(${BANK.x + BANK.w / 2 + 4}, ${bankY}) rotate(-90)`} textAnchor="middle">
              {mailboxes} {mailboxes === 1 ? 'mailbox' : 'mailboxes'}
            </text>
          </g>
          {REGIONS.map((r, li) => (
            <g key={r}>
              <text className="strip-lane" x={LABEL_X} y={TOP + li * LANE + LANE / 2 + 3}>
                {REGION_NAME[r]}
              </text>
              {hours.map((h) => (
                <rect
                  key={h.hour}
                  className={h.regions[r] > 0 ? 'strip-cell strip-cell-on' : 'strip-cell'}
                  x={GRID_X + h.hour * COL + 1}
                  y={TOP + li * LANE + 1}
                  width={COL - 2}
                  height={LANE - 2}
                  rx={3}
                >
                  <title>
                    {h.hour > lastHour
                      ? `${REGION_NAME[r]}, ${hourSpan(h.hour)}: not simulated yet`
                      : `${REGION_NAME[r]}, ${hourSpan(h.hour)}: ${emails(h.regions[r])}`}
                  </title>
                </rect>
              ))}
            </g>
          ))}
          {lastHour < 23 && (
            <g className="strip-future" aria-hidden="true" pointerEvents="none">
              <rect
                x={GRID_X + (lastHour + 1) * COL}
                y={TOP}
                width={(23 - lastHour) * COL}
                height={REGIONS.length * LANE - 2}
                rx={4}
              />
              <text
                x={GRID_X + ((lastHour + 1 + 24) / 2) * COL}
                y={TOP + (REGIONS.length * LANE) / 2}
                textAnchor="middle"
              >
                not simulated yet
              </text>
            </g>
          )}
          <g aria-hidden="true" pointerEvents="none">
            {dots.map((d) => (
              <circle
                key={d.key}
                data-dot=""
                data-hour={d.hour}
                data-cx={d.cx}
                data-cy={d.cy}
                data-drop={d.bounced ? DROP : undefined}
                cx={d.cx}
                cy={d.bounced ? d.cy + DROP : d.cy}
                r={R}
                fill={d.bounced ? BOUNCED : SENT}
                opacity={d.bounced ? 0.4 : 1}
              />
            ))}
          </g>
          <line
            data-playhead=""
            data-x0={GRID_X}
            data-x1={GRID_X + (lastHour + 1) * COL}
            data-hours={lastHour + 1}
            className="strip-playhead"
            x1={GRID_X}
            x2={GRID_X}
            y1={TOP - 4}
            y2={H}
            opacity={0}
          />
        </svg>
      </div>
      <p className="legend strip-legend">
        <span>
          <svg width="8" height="8" aria-hidden="true">
            <circle cx="4" cy="4" r="3" fill={SENT} />
          </svg>
          1 dot = {fmtInt(size)} {size === 1 ? 'email' : 'emails'} · times are UTC
        </span>
        <span>
          <svg width="8" height="8" aria-hidden="true">
            <circle cx="4" cy="4" r="3" fill={BOUNCED} opacity={0.6} />
          </svg>
          bounced
        </span>
      </p>
      {/* A table ignores width: 1px, so the visually hidden box is a div around it. */}
      <div className="sr-only">
        <table>
          <caption>Engine emails by UTC hour and recipient region</caption>
          <thead>
            <tr>
              <th scope="col">Hour (UTC)</th>
              {REGIONS.map((r) => (
                <th key={r} scope="col">
                  {REGION_NAME[r]}
                </th>
              ))}
              <th scope="col">All</th>
              <th scope="col">Bounced</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h) => (
              <tr key={h.hour}>
                <th scope="row">{hourSpan(h.hour)}</th>
                {REGIONS.map((r) => (
                  <td key={r}>{h.regions[r]}</td>
                ))}
                <td>{h.emails}</td>
                <td>{h.bounced}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
