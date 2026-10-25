'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { STATUSES } from '../../src/lifecycle';
import type { ContactPage } from '../../src/web/contacts';
import { STATUS_LABEL, fmtInt } from '../_components/api';
import { ContactPanel } from '../_components/ContactPanel';
import { ContactTable } from '../_components/ContactTable';
import { useSim } from '../_components/sim';
import { Empty, Failed, Loading } from '../_components/states';
import { useApi } from '../_components/useApi';

// Contacts: server-side pages of 50 (/api/contacts), a debounced search, a status filter and a detail panel.
// `?q=` and `?status=` in the URL set the filters on load (links from the activity log and the stage drill-down).
function Contacts() {
  const { version } = useSim();
  const url = useSearchParams();
  const urlQ = url.get('q') ?? '';
  const rawStatus = url.get('status') ?? '';
  const urlStatus = (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : ''; // an unknown one is ignored
  const [input, setInput] = useState(urlQ);
  const [q, setQ] = useState(urlQ.trim());
  const [status, setStatus] = useState(urlStatus);
  const [page, setPage] = useState(1);

  // A link to this page with other filters, followed while it is open.
  useEffect(() => {
    setInput(urlQ);
    setQ(urlQ.trim());
    setStatus(urlStatus);
    setPage(1);
  }, [urlQ, urlStatus]);
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // The search waits 300 ms after the last keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(input.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  params.set('page', String(page));
  const list = useApi<ContactPage>(`/api/contacts?${params.toString()}`, version);
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = q !== '' || status !== '';

  const openRow = useCallback((id: number) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(id);
  }, []);
  const close = useCallback(() => {
    setOpen(null);
    opener.current?.focus();
  }, []);

  return (
    <>
      <h1>Contacts</h1>
      <p className="lede">
        Search by name, email or company, or filter by status. Click a row, or press Enter on it, for the full history.
      </p>
      <div className="filters">
        <label className="sr-only" htmlFor="q">
          Search contacts
        </label>
        <input
          id="q"
          type="search"
          placeholder="Search name, email or company"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <label className="sr-only" htmlFor="status">
          Status
        </label>
        <select
          id="status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <section className="card" aria-label="Contact list">
        {data ? (
          data.total === 0 ? (
            filtered ? (
              <p className="state">No contacts match this search.</p>
            ) : (
              <Empty />
            )
          ) : (
            <div className={list.loading ? 'stale' : undefined}>
              <p className="state">{fmtInt(data.total)} contacts</p>
              {data.rows.length === 0 ? (
                <p className="state">This page is past the end.</p>
              ) : (
                <ContactTable rows={data.rows} onOpen={openRow} />
              )}
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
            </div>
          )
        ) : list.error ? (
          <Failed error={list.error} />
        ) : (
          <Loading />
        )}
        {data && list.error ? <Failed error={list.error} /> : null}
      </section>

      {open !== null && <ContactPanel id={open} onClose={close} />}
    </>
  );
}

// useSearchParams needs a Suspense boundary for Next to prerender the page shell.
export default function ContactsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Contacts />
    </Suspense>
  );
}
