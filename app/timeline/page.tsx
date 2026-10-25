'use client';

import { useState } from 'react';
import type { TimelineDay } from '../../src/web/timeline';
import { fmtInt } from '../_components/api';
import { ActivityChart } from '../_components/ActivityChart';
import { PhaseTag } from '../_components/DaySlider';
import { useSim } from '../_components/sim';
import { Empty, Failed, Loading } from '../_components/states';
import { useApi } from '../_components/useApi';

type Filter = 'all' | 'simulated' | 'history';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All days' },
  { value: 'simulated', label: 'Simulated only' },
  { value: 'history', label: 'Seeded history only' },
];

// Every day of the campaign from /api/timeline: the activity chart and one table row per day, newest first.
export default function TimelinePage() {
  const { version } = useSim();
  const timeline = useApi<{ days: TimelineDay[] }>('/api/timeline', version);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const all = timeline.data?.days ?? [];
  const days = filter === 'all' ? all : all.filter((d) => d.phase === filter);
  const quiet = all.every((d) => d.firstEmails + d.followUps + d.replies + d.bounces === 0);

  return (
    <>
      <h1>Campaign timeline</h1>
      <p className="lede">
        What happened on each simulated UTC day, read from sends, replies and status changes. Days before the simulation
        started are the seed&apos;s made-up history. Click a bar to find its day in the table.
      </p>
      <div className="filters" role="group" aria-label="Which days">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      {timeline.data ? (
        quiet ? (
          <Empty />
        ) : (
          <div className={timeline.loading ? 'stale' : undefined}>
            <section className="card" aria-labelledby="chart-h">
              <h2 id="chart-h">Daily activity</h2>
              {days.length === 0 ? (
                <p className="state">No days of this kind yet.</p>
              ) : (
                <ActivityChart
                  days={days}
                  selected={selected}
                  onSelect={(d) => {
                    setSelected(d);
                    document.getElementById(`day-${d}`)?.scrollIntoView({ block: 'nearest' });
                  }}
                />
              )}
            </section>
            <section className="card section" aria-labelledby="table-h">
              <h2 id="table-h">Day by day, newest first</h2>
              {days.length === 0 ? (
                <p className="state">No days of this kind yet.</p>
              ) : (
                <table className="table table-static">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Phase</th>
                      <th scope="col">First emails</th>
                      <th scope="col">Follow-ups</th>
                      <th scope="col">Replies</th>
                      <th scope="col">Bounces</th>
                      <th scope="col">Unsubscribes</th>
                      <th scope="col">Deactivated</th>
                      <th scope="col" title="Contacts that left New (their first email or a first bounce)">
                        Entered
                      </th>
                      <th scope="col" title="Contacts that moved into a finished status">
                        Left
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...days].reverse().map((d) => (
                      <tr key={d.day} id={`day-${d.day}`} className={selected === d.day ? 'selected' : undefined}>
                        <td data-label="Date" className="mono">
                          {d.day}
                        </td>
                        <td data-label="Phase">
                          <PhaseTag history={d.phase === 'history'} />
                        </td>
                        <td data-label="First emails" className="num">
                          {fmtInt(d.firstEmails)}
                        </td>
                        <td data-label="Follow-ups" className="num">
                          {fmtInt(d.followUps)}
                        </td>
                        <td data-label="Replies" className="num">
                          {fmtInt(d.replies)}
                        </td>
                        <td data-label="Bounces" className="num">
                          {fmtInt(d.bounces)}
                        </td>
                        <td data-label="Unsubscribes" className="num">
                          {fmtInt(d.unsubscribes)}
                        </td>
                        <td data-label="Deactivated" className="num">
                          {fmtInt(d.deactivated)}
                        </td>
                        <td data-label="Entered" className="num">
                          {fmtInt(d.entered)}
                        </td>
                        <td data-label="Left" className="num">
                          {fmtInt(d.left)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        )
      ) : timeline.error ? (
        <Failed error={timeline.error} />
      ) : (
        <Loading />
      )}
      {timeline.data && timeline.error ? <Failed error={timeline.error} /> : null}
    </>
  );
}
