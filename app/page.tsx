'use client';

import { useEffect, useRef, useState } from 'react';
import type { CampaignDays, Summary } from '../src/web/summary';
import type { TimelineDay } from '../src/web/timeline';
import { useFlash } from './_anim/motion';
import { ActivityChart } from './_components/ActivityChart';
import { DaySlider } from './_components/DaySlider';
import { Funnel } from './_components/Funnel';
import { Kpis } from './_components/Kpis';
import { useSim } from './_components/sim';
import { Empty, Failed, Loading } from './_components/states';
import { useApi } from './_components/useApi';

// Overview: KPIs, the day slider, the funnel and the daily activity chart. Every number comes from /api/summary and
// /api/timeline; nothing is computed here beyond layout.
export default function OverviewPage() {
  const { version } = useSim();
  const [day, setDay] = useState<string | null>(null); // null: the sim clock's day

  // After a control action the slider jumps back to the (new) current day.
  useEffect(() => setDay(null), [version]);

  const summary = useApi<{ summary: Summary; days: CampaignDays }>(
    day ? `/api/summary?day=${day}` : '/api/summary',
    version,
  );
  const timeline = useApi<{ days: TimelineDay[] }>('/api/timeline', version);
  const s = summary.data?.summary ?? null;
  const days = summary.data?.days ?? null;

  const funnelRef = useRef<HTMLDivElement>(null);
  useFlash(funnelRef, s?.day);

  return (
    <>
      <h1>Campaign overview</h1>
      <p className="lede">
        Everything here is rebuilt from the database as of the end of the selected simulated day. Drag the slider or
        click a bar in the chart to look at another day.
      </p>

      <section aria-labelledby="kpi-h">
        <h2 id="kpi-h" className="sr-only">
          Key numbers
        </h2>
        {s ? (
          s.total === 0 && !day ? (
            <Empty />
          ) : (
            <div className={summary.loading ? 'stale' : undefined}>
              <Kpis s={s} />
            </div>
          )
        ) : summary.error ? (
          <Failed error={summary.error} />
        ) : (
          <Loading />
        )}
      </section>

      {/* The slider shows the day asked for at once; the numbers follow when its summary arrives. */}
      {days && s && <DaySlider days={days} day={day ?? s.day} onChange={setDay} />}
      {s && summary.error ? <Failed error={summary.error} /> : null}

      <div className="grid-2">
        <section className="card" aria-labelledby="funnel-h">
          <h2 id="funnel-h">Funnel on {s?.day ?? '…'}</h2>
          {s ? (
            <div ref={funnelRef} className={summary.loading ? 'stale' : undefined}>
              {s.total === 0 ? <Empty /> : <Funnel s={s} />}
            </div>
          ) : summary.error ? (
            <Failed error={summary.error} />
          ) : (
            <Loading />
          )}
        </section>

        <section className="card" aria-labelledby="activity-h">
          <h2 id="activity-h">Daily activity</h2>
          {timeline.data ? (
            timeline.data.days.every((d) => d.firstEmails + d.followUps + d.replies + d.bounces === 0) ? (
              <Empty />
            ) : (
              <ActivityChart days={timeline.data.days} selected={s?.day ?? null} onSelect={setDay} />
            )
          ) : timeline.error ? (
            <Failed error={timeline.error} />
          ) : (
            <Loading />
          )}
        </section>
      </div>
    </>
  );
}
