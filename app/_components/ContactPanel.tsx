'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { ContactDetail } from '../../src/web/contacts';
import { NEXT_LABEL, fmtTime, type Wire } from './api';
import { StatusBadge } from './StatusBadge';
import { Failed, Loading } from './states';
import { useApi } from './useApi';
import { useSim } from './sim';

type Item = { at: string; order: number; id: number; kind: string; node: ReactNode };

const STEP_LABEL: Record<string, string> = {
  first: 'First email',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
};

function describeEvent(type: string, data: unknown): string {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (type === 'status_changed')
    return `Status ${String(d.from)} → ${String(d.to)}${d.reason ? ` (${String(d.reason)})` : ''}`;
  return `${type.replace(/_/g, ' ')}${Object.keys(d).length ? `: ${JSON.stringify(d)}` : ''}`;
}

// Every send, reply and event of one contact, in one list, in time order. At the same instant a send comes before a
// reply, and both before the event they caused.
function merged(d: Wire<ContactDetail>): Item[] {
  const items: Item[] = [
    ...d.sends.map((s) => ({
      at: s.sentAt,
      order: 0,
      id: s.id,
      kind: 'send',
      node: (
        <>
          <div className="kind">
            {STEP_LABEL[s.step] ?? s.step} · {s.outcome}
          </div>
          <div>{s.subject}</div>
          <div className="meta">template source: {s.templateSource}</div>
        </>
      ),
    })),
    ...d.replies.map((r) => ({
      at: r.receivedAt,
      order: 1,
      id: r.id,
      kind: 'reply',
      node: (
        <>
          <div className="kind">Reply</div>
          <blockquote>{r.body}</blockquote>
          <div className="meta">
            label: {r.label ?? 'not labelled yet'}
            {r.labelSource ? ` · label source: ${r.labelSource}` : ''}
            {r.classifiedAt ? ` · classified ${fmtTime(r.classifiedAt)}` : ''}
          </div>
          <div className="meta hidden-label">mock&apos;s hidden label, used for scoring: {r.trueLabel}</div>
        </>
      ),
    })),
    ...d.events.map((e) => ({
      at: e.occurredAt,
      order: 2,
      id: e.id,
      kind: 'event',
      node: <div className="meta">{describeEvent(e.type, e.data)}</div>,
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order || a.id - b.id);
}

// The detail panel for one contact (/api/contacts/:id). Escape or the close button closes it.
export function ContactPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { version } = useSim();
  const detail = useApi<ContactDetail>(`/api/contacts/${id}`, version);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const c = detail.data?.contact;
  return (
    <>
      <div className="panel-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="panel" role="dialog" aria-modal="true" aria-labelledby="panel-h">
        <div className="panel-head">
          <h2 id="panel-h">{c ? c.name : `Contact ${id}`}</h2>
          <button type="button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
        {detail.data && c ? (
          <>
            <dl className="fields">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={c.status} />
              </dd>
              <dt>Email</dt>
              <dd>{c.email}</dd>
              <dt>Company</dt>
              <dd>{c.company}</dd>
              <dt>Role</dt>
              <dd>{c.role}</dd>
              <dt>Industry</dt>
              <dd>{c.industry}</dd>
              <dt>Segment</dt>
              <dd>{c.segment}</dd>
              <dt>Timezone</dt>
              <dd>{c.timezone}</dd>
              <dt>Created</dt>
              <dd>{fmtTime(c.createdAt)}</dd>
              <dt>Next action</dt>
              <dd>
                {c.nextAction ? `${NEXT_LABEL[c.nextAction] ?? c.nextAction} at ${fmtTime(c.nextActionAt)}` : '—'}
              </dd>
            </dl>
            <h2>Timeline</h2>
            {merged(detail.data).length === 0 ? (
              <p className="state">Nothing has happened to this contact yet.</p>
            ) : (
              <ol className="timeline">
                {merged(detail.data).map((it) => (
                  <li key={`${it.kind}-${it.id}`} className={`k-${it.kind}`}>
                    <div className="when">{fmtTime(it.at)}</div>
                    {it.node}
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : detail.error ? (
          <Failed error={detail.error} />
        ) : (
          <Loading />
        )}
      </aside>
    </>
  );
}
