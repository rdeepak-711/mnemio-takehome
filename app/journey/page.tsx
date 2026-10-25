'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Status } from '../../src/lifecycle';
import type { Move } from '../../src/web/journey';
import type { CampaignDays, Summary } from '../../src/web/summary';
import { STATUS_LABEL, fmtInt } from '../_components/api';
import { DaySlider } from '../_components/DaySlider';
import { JourneyMap } from '../_components/JourneyMap';
import { useSim } from '../_components/sim';
import { StagePanel } from '../_components/StagePanel';
import { StatusBadge } from '../_components/StatusBadge';
import { Empty, Failed, Loading } from '../_components/states';
import { useApi } from '../_components/useApi';

// The nine stages and who moved between them on one day (/api/journey), with the stage sizes at the end of that day
// (/api/summary). After an advance, the new day's moves animate.
export default function JourneyPage() {
  const { version, lastAdvance } = useSim();
  const [day, setDay] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [playKey, setPlayKey] = useState<number | null>(null);
  // An advance made before this page opened (on another page) is not replayed.
  const played = useRef<number | null>(lastAdvance?.version ?? null);

  // A control finished: back to the current day, and if it was an advance, play that day once it has loaded.
  // Only `version` triggers this; lastAdvance is always set before version moves.
  useEffect(() => {
    setDay(null);
    if (lastAdvance && played.current !== lastAdvance.version) setPending(lastAdvance.version);
  }, [version]);

  const q = day ? `?day=${day}` : '';
  const journey = useApi<{ day: string; moves: Move[] }>(`/api/journey${q}`, version);
  const summary = useApi<{ summary: Summary; days: CampaignDays }>(`/api/summary${q}`, version);

  useEffect(() => {
    if (pending === null || journey.loading || !journey.data) return;
    played.current = pending;
    setPlayKey(pending);
    setPending(null);
  }, [pending, journey.loading, journey.data]);

  const days = summary.data?.days ?? null;
  const shownDay = day ?? journey.data?.day ?? summary.data?.summary.day ?? null;
  const total = summary.data?.summary.total ?? null;

  // A stage box opens who was in it at the end of the shown day (D62); the panel keeps that day.
  const [stage, setStage] = useState<{ day: string; status: Status } | null>(null);
  const closeStage = useCallback(() => setStage(null), []);
  const stagesDay = journey.data?.day ?? null;

  return (
    <>
      <h1>Contact journey</h1>
      <p className="lede">
        Each arrow is a group of contacts whose status changed on the selected day, read from the event log. Stage sizes
        are as of the end of that day; select a stage to see who was in it and why.
      </p>
      {days && shownDay && <DaySlider days={days} day={shownDay} onChange={setDay} />}
      <div className="grid-2">
        <section className="card" aria-labelledby="map-h">
          <h2 id="map-h">Stages on {journey.data?.day ?? '…'}</h2>
          {journey.data ? (
            total === 0 ? (
              <Empty />
            ) : (
              <div className={journey.loading ? 'stale' : undefined}>
                <JourneyMap
                  moves={journey.data.moves}
                  counts={summary.data?.summary.statuses ?? null}
                  playKey={playKey}
                  onSelect={stagesDay ? (status) => setStage({ day: stagesDay, status }) : undefined}
                />
              </div>
            )
          ) : journey.error ? (
            <Failed error={journey.error} />
          ) : (
            <Loading />
          )}
          {journey.data && journey.error ? <Failed error={journey.error} /> : null}
        </section>
        <section className="card" aria-labelledby="moves-h">
          <h2 id="moves-h">Moves on {journey.data?.day ?? '…'}</h2>
          {journey.data ? (
            journey.data.moves.length === 0 ? (
              <p className="state">No contact changed status on this day.</p>
            ) : (
              <ul className="moves">
                {journey.data.moves.map((m) => (
                  <li key={`${m.from}-${m.to}`}>
                    <span className="n">{fmtInt(m.count)}</span>
                    <StatusBadge status={m.from} />
                    <span aria-label="to">→</span>
                    <StatusBadge status={m.to} />
                    <span className="sr-only">
                      {fmtInt(m.count)} contacts moved from {STATUS_LABEL[m.from]} to {STATUS_LABEL[m.to]}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : journey.error ? (
            <Failed error={journey.error} />
          ) : (
            <Loading />
          )}
          {summary.error ? <Failed error={summary.error} /> : null}
        </section>
      </div>
      {stage && <StagePanel day={stage.day} status={stage.status} onClose={closeStage} />}
    </>
  );
}
