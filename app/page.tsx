'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Status } from '../src/lifecycle';
import type { ActivityPage } from '../src/web/activity';
import type { ClassifierStats } from '../src/web/classifier';
import type { CampaignDays, Summary } from '../src/web/summary';
import type { TimelineDay } from '../src/web/timeline';
import { useFlash } from './_anim/motion';
import { ActivityChart } from './_components/ActivityChart';
import { fmtInt } from './_components/api';
import { ActivityList } from './_components/ActivityList';
import { ClassifierBars } from './_components/ClassifierBars';
import { DaySlider } from './_components/DaySlider';
import { Funnel } from './_components/Funnel';
import { Kpis } from './_components/Kpis';
import { useSim } from './_components/sim';
import { StagePanel } from './_components/StagePanel';
import { Empty, Failed, Loading } from './_components/states';
import { useApi } from './_components/useApi';

const FEED_ROWS = 8;

// Overview: KPIs, the day slider, the funnel (a bar opens who is in that stage), the daily activity chart, the
// classifier card and the day's first events. Every number comes from the API; nothing is computed here beyond layout.
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

  const classifier = useApi<ClassifierStats>('/api/classifier', version);
  const feed = useApi<ActivityPage>(s ? `/api/activity?day=${s.day}` : null, version);

  // The drill-down keeps the day it was opened on, even if the slider moves underneath it.
  const [stage, setStage] = useState<{ day: string; status: Status } | null>(null);
  const closeStage = useCallback(() => setStage(null), []);

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
              {s.total === 0 ? <Empty /> : <Funnel s={s} onSelect={(status) => setStage({ day: s.day, status })} />}
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

      <div className="grid-2">
        <section className="card" aria-labelledby="cls-h">
          <div className="card-head">
            <h2 id="cls-h">AI classifier</h2>
            <Link href="/classifier">Details</Link>
          </div>
          {classifier.data ? (
            <div className={classifier.loading ? 'stale' : undefined}>
              {classifier.data.total === 0 ? (
                <p className="state">Nothing labelled since the simulation started yet.</p>
              ) : (
                <>
                  <p className="kpi-sub note">
                    {fmtInt(classifier.data.total)} replies labelled since {classifier.data.simStart}, scored against
                    the mock&apos;s hidden label.
                  </p>
                  <ClassifierBars s={classifier.data} />
                </>
              )}
            </div>
          ) : classifier.error ? (
            <Failed error={classifier.error} />
          ) : (
            <Loading />
          )}
          {classifier.data && classifier.error ? <Failed error={classifier.error} /> : null}
        </section>

        <section className="card" aria-labelledby="feed-h">
          <div className="card-head">
            <h2 id="feed-h">Activity on {s?.day ?? '…'}</h2>
            {s && <Link href={`/activity?day=${s.day}`}>All of this day</Link>}
          </div>
          {feed.data ? (
            <div className={feed.loading ? 'stale' : undefined}>
              {feed.data.total === 0 ? (
                <p className="state">Nothing happened on this day.</p>
              ) : (
                <>
                  <ActivityList rows={feed.data.rows.slice(0, FEED_ROWS)} compact />
                  {feed.data.total > FEED_ROWS && (
                    <p className="kpi-sub note">
                      Newest {FEED_ROWS} of {fmtInt(feed.data.total)} events on this day.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : feed.error ? (
            <Failed error={feed.error} />
          ) : (
            <Loading />
          )}
          {feed.data && feed.error ? <Failed error={feed.error} /> : null}
        </section>
      </div>

      {stage && <StagePanel day={stage.day} status={stage.status} onClose={closeStage} />}
    </>
  );
}
