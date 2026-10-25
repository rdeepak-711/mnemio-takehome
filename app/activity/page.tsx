'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ACTIVITY_KINDS, type ActivityPage } from '../../src/web/activity';
import type { CampaignDays, Summary } from '../../src/web/summary';
import { KIND_LABEL, fmtInt } from '../_components/api';
import { ActivityList } from '../_components/ActivityList';
import { useSim } from '../_components/sim';
import { Empty, Failed, Loading } from '../_components/states';
import { useApi } from '../_components/useApi';

// The event log (/api/activity, D61): 50 per page, newest first. The filters live in the URL query string, so a
// filtered view can be linked to (the overview's "Activity on <day>" does) and survives a reload.
function ActivityLog() {
  const { version } = useSim();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const kind = params.get('kind') ?? '';
  const q = params.get('q') ?? '';
  const day = params.get('day') ?? '';
  const page = Math.max(1, Math.floor(Number(params.get('page') ?? '1')) || 1);

  // Changes the query string; any filter change goes back to page 1. It starts from the latest params, so a
  // debounced search that lands after another filter changed keeps that change.
  const latest = useRef(params);
  latest.current = params;
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(latest.current.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    const s = next.toString();
    router.replace(s ? `${path}?${s}` : path, { scroll: false });
  };

  // The search box updates the URL 300 ms after the last keystroke, and follows the URL when it changes elsewhere.
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (input.trim() === q) return;
    const t = setTimeout(() => update({ q: input.trim() || null }), 300);
    return () => clearTimeout(t);
  }, [input]);

  const days = useApi<{ summary: Summary; days: CampaignDays }>('/api/summary', version).data?.days ?? null;

  const query = new URLSearchParams();
  if (kind) query.set('kind', kind);
  if (q) query.set('q', q);
  if (day) query.set('day', day);
  query.set('page', String(page));
  const list = useApi<ActivityPage>(`/api/activity?${query.toString()}`, version);
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = kind !== '' || q !== '' || day !== '';

  return (
    <>
      <h1>Activity log</h1>
      <p className="lede">
        Every send, bounce, reply, reschedule and deactivation, newest first, one line each. Times are simulated UTC. A
        status change that only repeats a send or a reply is not listed twice.
      </p>
      <div className="filters">
        <label className="sr-only" htmlFor="kind">
          Kind
        </label>
        <select id="kind" value={kind} onChange={(e) => update({ kind: e.target.value || null })}>
          <option value="">All kinds</option>
          {ACTIVITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="q">
          Search contacts
        </label>
        <input
          id="q"
          type="search"
          placeholder="Contact name, email or company"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <label className="sr-only" htmlFor="day">
          Day
        </label>
        <input
          id="day"
          type="date"
          value={day}
          min={days?.first}
          max={days?.today}
          onChange={(e) => update({ day: e.target.value || null })}
        />
        {filtered && (
          <button type="button" onClick={() => update({ kind: null, q: null, day: null })}>
            Clear filters
          </button>
        )}
      </div>

      <section className="card" aria-label="Events">
        {data ? (
          data.total === 0 ? (
            filtered ? (
              <p className="state">No events match these filters.</p>
            ) : (
              <Empty />
            )
          ) : (
            <div className={list.loading ? 'stale' : undefined}>
              <p className="state">{fmtInt(data.total)} events</p>
              {data.rows.length === 0 ? (
                <p className="state">This page is past the end.</p>
              ) : (
                <ActivityList rows={data.rows} />
              )}
              <nav className="pager" aria-label="Pages">
                <button type="button" onClick={() => update({ page: String(page - 1) })} disabled={page <= 1}>
                  Previous
                </button>
                <span>
                  Page {fmtInt(page)} of {fmtInt(pages)}
                </span>
                <button type="button" onClick={() => update({ page: String(page + 1) })} disabled={page >= pages}>
                  Next
                </button>
              </nav>
            </div>
          )
        ) : list.error ? (
          <Failed error={list.error} />
        ) : (
          <Loading />
        )}
        {data && list.error ? <Failed error={list.error} /> : null}
      </section>
    </>
  );
}

// useSearchParams needs a Suspense boundary for Next to prerender the page shell.
export default function ActivityPageRoute() {
  return (
    <Suspense fallback={<Loading />}>
      <ActivityLog />
    </Suspense>
  );
}
