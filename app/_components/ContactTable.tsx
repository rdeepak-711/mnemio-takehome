'use client';

import type { ContactRow } from '../../src/web/contacts';
import { NEXT_LABEL, fmtTime, type Wire } from './api';
import { StatusBadge } from './StatusBadge';

// One server-side page of contacts. A row opens its detail on click or Enter.
export function ContactTable({ rows, onOpen }: { rows: Wire<ContactRow>[]; onOpen: (id: number) => void }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Company</th>
          <th scope="col">Email</th>
          <th scope="col">Status</th>
          <th scope="col">Last sent</th>
          <th scope="col">Last reply</th>
          <th scope="col">Next action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            tabIndex={0}
            aria-label={`${r.name}, ${r.company}: open details`}
            onClick={() => onOpen(r.id)}
            onKeyDown={(e) => {
              // preventDefault: without it, this same Enter press activates the panel's Close button once it takes
              // focus, and Space would scroll the page.
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(r.id);
              }
            }}
          >
            <td data-label="Name">{r.name}</td>
            <td data-label="Company">{r.company}</td>
            <td data-label="Email" className="email">
              {r.email}
            </td>
            <td data-label="Status">
              <StatusBadge status={r.status} />
            </td>
            <td data-label="Last sent" className="mono">
              {fmtTime(r.lastSentAt)}
            </td>
            <td data-label="Last reply" className="mono">
              {fmtTime(r.lastReplyAt)}
            </td>
            <td data-label="Next action">
              {r.nextAction ? (
                <>
                  {NEXT_LABEL[r.nextAction] ?? r.nextAction}
                  <div className="mono kpi-sub">{fmtTime(r.nextActionAt)}</div>
                </>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
