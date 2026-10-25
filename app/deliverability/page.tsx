'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeliveryDay } from '../../src/web/delivery';
import type { CampaignDays, Summary } from '../../src/web/summary';
import { DaySlider } from '../_components/DaySlider';
import { DeliveryKpis, DomainBars, PauseTable } from '../_components/DeliveryParts';
import { MailboxGrid } from '../_components/MailboxGrid';
import { SendStrip } from '../_components/SendStrip';
import { useSim } from '../_components/sim';
import { Failed, Loading } from '../_components/states';
import { useApi } from '../_components/useApi';

const hourText = (h: number) => `${h}:00`;

// How the engine spread the selected day's emails (D71): mailboxes, the 24-hour strip, domains and pauses, all from
// /api/delivery. Each new answer (an advance, the slider, the first load) plays that day once.
// On the clock's own day, the clock's UTC hour: later hours of that day haven't been simulated yet. Otherwise 23.
function lastHourOf(day: string, clock: string | undefined): number {
  if (!clock || clock.slice(0, 10) !== day) return 23;
  return new Date(clock).getUTCHours();
}

export default function DeliverabilityPage() {
  const { version } = useSim();
  const [day, setDay] = useState<string | null>(null);
  // A control finished: back to the current day (after an advance, that is the new day, which then plays).
  useEffect(() => setDay(null), [version]);

  const q = day ? `?day=${day}` : '';
  const delivery = useApi<DeliveryDay & { clock: Date }>(`/api/delivery${q}`, version);
  const summary = useApi<{ summary: Summary; days: CampaignDays }>(`/api/summary${q}`, version);

  // One play per answer. The strip and the grid are keyed by it, so new data always mounts fresh elements and a
  // play still running on the old ones is cut short (completed) on unmount.
  const seq = useRef(0);
  const playKey = useMemo(() => (delivery.data ? ++seq.current : null), [delivery.data]);

  const d = delivery.data;
  const days = summary.data?.days ?? null;
  const shownDay = day ?? d?.day ?? summary.data?.summary.day ?? null;

  if (d && !d.enabled) {
    return (
      <>
        <h1>Deliverability</h1>
        <p className="disclaimer">
          Deliverability is off (<code>DELIVERABILITY=off</code>). Turn it on in <code>.env</code> to use mailboxes,
          warm-up, send windows and domain caps.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Deliverability</h1>
      <p className="lede">
        How the engine spread the day&apos;s emails over its mailboxes, the prospects&apos; working hours and their
        company domains.
      </p>
      {days && shownDay && <DaySlider days={days} day={shownDay} onChange={setDay} />}
      {summary.error && !days ? <Failed error={summary.error} /> : null}

      {d ? (
        <div className={delivery.loading ? 'stale' : undefined}>
          <section className="section" aria-labelledby="dk-h">
            <h2 id="dk-h" className="sr-only">
              Key numbers on {d.day}
            </h2>
            <DeliveryKpis d={d} />
          </section>

          <section className="card section" aria-labelledby="mb-h">
            <h2 id="mb-h">Mailboxes on {d.day}</h2>
            <MailboxGrid key={playKey} mailboxes={d.mailboxes} playKey={playKey} />
          </section>

          <section className="card section" aria-labelledby="strip-h">
            <h2 id="strip-h">The day, hour by hour</h2>
            <SendStrip
              key={playKey}
              hours={d.hours}
              mailboxes={d.totals.mailboxes}
              playKey={playKey}
              lastHour={lastHourOf(d.day, delivery.data?.clock)}
            />
            {d.window && (
              <p className="kpi-sub note strip-caption">
                Sends follow the prospects&apos; working hours (
                <code>
                  {hourText(d.window.startHour)}–{hourText(d.window.endHour)}
                </code>{' '}
                local, Monday to Friday), so the day moves from Asia to Europe to the Americas.
              </p>
            )}
          </section>

          <section className="card section" aria-labelledby="dom-h">
            <h2 id="dom-h">Busiest recipient domains</h2>
            <DomainBars key={playKey} domains={d.domains} cap={d.cap ?? 0} />
          </section>

          <section className="card section" aria-labelledby="pause-h">
            <h2 id="pause-h">Pauses up to {d.day}</h2>
            <PauseTable pauses={d.pauses} />
          </section>
        </div>
      ) : delivery.error ? (
        <Failed error={delivery.error} />
      ) : (
        <Loading />
      )}
      {d && delivery.error ? <Failed error={delivery.error} /> : null}
    </>
  );
}
