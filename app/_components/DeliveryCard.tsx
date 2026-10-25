'use client';

import Link from 'next/link';
import type { DeliveryDay } from '../../src/web/delivery';
import { fmtInt, type Wire } from './api';
import { Failed, Loading } from './states';
import type { ApiState } from './useApi';

const SPARK = { w: 168, h: 32, gap: 1 };

// 24 bars of the day's engine emails per UTC hour, scaled to the busiest hour.
function Sparkline({ hours }: { hours: Wire<DeliveryDay>['hours'] }) {
  const max = Math.max(1, ...hours.map((h) => h.emails));
  const bw = SPARK.w / 24;
  return (
    <svg className="spark" viewBox={`0 0 ${SPARK.w} ${SPARK.h}`} width={SPARK.w} height={SPARK.h} aria-hidden="true">
      {hours.map((h) => {
        const height = h.emails === 0 ? 0 : Math.max(1.5, (h.emails / max) * SPARK.h);
        return (
          <rect
            key={h.hour}
            x={h.hour * bw + SPARK.gap / 2}
            y={SPARK.h - height}
            width={bw - SPARK.gap}
            height={height}
            rx={1}
          />
        );
      })}
      <line x1={0} x2={SPARK.w} y1={SPARK.h - 0.5} y2={SPARK.h - 0.5} />
    </svg>
  );
}

// The overview's deliverability card for the selected day (D71).
export function DeliveryCard({ state }: { state: ApiState<DeliveryDay> }) {
  const d = state.data;
  return (
    <section className="card" aria-labelledby="dlv-h">
      <div className="card-head">
        <h2 id="dlv-h">Deliverability{d ? ` on ${d.day}` : ''}</h2>
        <Link href="/deliverability">Open deliverability</Link>
      </div>
      {d ? (
        <div className={state.loading ? 'stale' : undefined}>
          {!d.enabled ? (
            <p className="state">Off</p>
          ) : (
            <div className="dlv-card">
              <dl className="dlv-facts">
                <dt>Emails</dt>
                <dd>
                  {fmtInt(d.totals.emails)} of {fmtInt(d.totals.capacity)} capacity
                </dd>
                <dt>Paused</dt>
                <dd>
                  {fmtInt(d.totals.paused)} of {fmtInt(d.totals.mailboxes)} mailboxes
                </dd>
              </dl>
              <figure className="dlv-spark">
                <Sparkline hours={d.hours} />
                <figcaption className="kpi-sub">emails per UTC hour, 00–23</figcaption>
              </figure>
            </div>
          )}
        </div>
      ) : state.error ? (
        <Failed error={state.error} />
      ) : (
        <Loading />
      )}
      {d && state.error ? <Failed error={state.error} /> : null}
    </section>
  );
}
