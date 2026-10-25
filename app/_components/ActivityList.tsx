'use client';

import Link from 'next/link';
import { useRef } from 'react';
import type { ActivityRow } from '../../src/web/activity';
import { useEntrance } from '../_anim/motion';
import { KIND_LABEL, fmtTime, type Wire } from './api';

// Colour is always paired with the kind's name.
export function KindBadge({ kind }: { kind: string }) {
  return (
    <span className={`badge kind k-${kind}`}>
      <span className="dot" aria-hidden="true" />
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

// One line per event: time (UTC), kind, contact (links to the contacts page), and the description built on the
// server from the event's stored data (D61). New rows enter with a short stagger.
export function ActivityList({ rows, compact = false }: { rows: Wire<ActivityRow>[]; compact?: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  useEntrance(ref, 'li', rows.map((r) => r.id).join(','));
  return (
    <ol ref={ref} className={`feed${compact ? ' feed-compact' : ''}`}>
      {rows.map((r) => (
        <li key={r.id}>
          <time className="when" dateTime={r.at}>
            {fmtTime(r.at)}
          </time>
          <KindBadge kind={r.kind} />
          <Link className="who" href={`/contacts?q=${encodeURIComponent(r.email)}`}>
            {r.name}
          </Link>
          <span className="what">{r.description}</span>
        </li>
      ))}
    </ol>
  );
}
