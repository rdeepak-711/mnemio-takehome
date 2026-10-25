'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Status } from '../../src/lifecycle';
import type { StagePage } from '../../src/web/stage';
import { STATUS_LABEL, fmtInt, fmtTime, reasonWords } from './api';
import { useSim } from './sim';
import { StatusBadge } from './StatusBadge';
import { Failed, Loading } from './states';
import { useApi } from './useApi';

// Who was in one stage at the end of the selected day (/api/stage, D62), 50 per page. Escape, the close button or a
// click outside closes it, and focus goes back to whatever opened it.
export function StagePanel({ day, status, onClose }: { day: string; status: Status; onClose: () => void }) {
  const { version } = useSim();
  const [page, setPage] = useState(1);
  const stage = useApi<StagePage>(`/api/stage?day=${day}&status=${status}&page=${page}`, version);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;

  // Once per opening, so a new onClose from a re-render never moves focus.
  useEffect(() => {
    // A funnel bar is a button, a journey stage an SVG group; both can take focus back.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFn.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  const data = stage.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <div className="panel-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="panel" role="dialog" aria-modal="true" aria-labelledby="stage-h">
        <div className="panel-head">
          <h2 id="stage-h">
            <StatusBadge status={status} />
          </h2>
          <button type="button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
        <p className="stage-meta">
          {data ? `${fmtInt(data.total)} contacts` : '…'} in {STATUS_LABEL[status]} at the end of{' '}
          <span className="mono">{day}</span> (simulated UTC)
        </p>
        {data ? (
          <div className={stage.loading ? 'stale' : undefined}>
            {data.total === 0 ? (
              <p className="state">Nobody was in this stage on this day.</p>
            ) : data.rows.length === 0 ? (
              <p className="state">This page is past the end.</p>
            ) : (
              <ol className="stage-list">
                {data.rows.map((r) => (
                  <li key={r.id}>
                    <Link href={`/contacts?q=${encodeURIComponent(r.email)}`} className="who">
                      {r.name}
                    </Link>
                    <span className="company">{r.company}</span>
                    <dl className="stage-facts">
                      <dt>Since</dt>
                      <dd className="mono">{fmtTime(r.since)}</dd>
                      <dt>From</dt>
                      <dd>{r.from ? (STATUS_LABEL[r.from as Status] ?? r.from) : '—'}</dd>
                      <dt>Why</dt>
                      <dd>{reasonWords(r.reason)}</dd>
                    </dl>
                  </li>
                ))}
              </ol>
            )}
            {data.total > data.pageSize && (
              <nav className="pager" aria-label="Pages">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  Previous
                </button>
                <span>
                  Page {fmtInt(page)} of {fmtInt(pages)}
                </span>
                <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page >= pages}>
                  Next
                </button>
              </nav>
            )}
          </div>
        ) : stage.error ? (
          <Failed error={stage.error} />
        ) : (
          <Loading />
        )}
        {data && stage.error ? <Failed error={stage.error} /> : null}
      </aside>
    </>
  );
}
