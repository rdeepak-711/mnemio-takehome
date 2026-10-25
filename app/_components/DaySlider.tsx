'use client';

import { useMemo } from 'react';
import { nextDay } from '../../src/web/days';
import type { CampaignDays } from '../../src/web/summary';
import { fmtDay } from './api';

// Every day from days.first to days.today, inclusive.
export function dayRange(days: CampaignDays): string[] {
  const out: string[] = [];
  for (let d = days.first; d <= days.today; d = nextDay(d)) out.push(d);
  return out;
}

// Same rule as phaseOf: a day that ended by SIM_START is seeded history, and that is every day before SIM_START's day.
export const isHistory = (day: string, days: CampaignDays) => day < days.simStart;

export function PhaseTag({ history }: { history: boolean }) {
  return history ? (
    <span className="tag tag-history">seeded history</span>
  ) : (
    <span className="tag tag-sim">simulated</span>
  );
}

export function DaySlider({
  days,
  day,
  onChange,
}: {
  days: CampaignDays;
  day: string;
  onChange: (day: string) => void;
}) {
  const range = useMemo(() => dayRange(days), [days]);
  const index = Math.max(0, range.indexOf(day));
  const history = isHistory(day, days);
  return (
    <div className="slider card">
      <label htmlFor="day-slider" className="slider-meta">
        <span>
          Day {index + 1} of {range.length}
        </span>
        <span>
          {days.first} to {days.today}
        </span>
      </label>
      <input
        id="day-slider"
        type="range"
        min={0}
        max={Math.max(0, range.length - 1)}
        step={1}
        value={index}
        aria-valuetext={`${day}, ${history ? 'seeded history' : 'simulated'}`}
        onChange={(e) => {
          const next = range[Number(e.target.value)];
          if (next) onChange(next);
        }}
      />
      <div className="slider-day" aria-live="polite">
        <span>{fmtDay(day)}</span>
        <span className="mono">{day}</span>
        <PhaseTag history={history} />
      </div>
    </div>
  );
}
