'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { TickSummary } from '../../src/engine/tick';
import type { Violation } from '../../src/invariants';
import type { Summary, CampaignDays } from '../../src/web/summary';
import { errorText, fmtInt, getJson, isAbort } from './api';

type Busy = { label: string } | null;
export type LastAdvance = { days: number; version: number } | null;

type SimState = {
  today: string | null; // the sim clock's day, from /api/summary
  version: number; // bumps after every control action; pages refetch when it changes
  busy: Busy;
  lastAdvance: LastAdvance;
  advance(days: number): Promise<void>;
  reset(): Promise<void>;
};

const SimContext = createContext<SimState | null>(null);

export function useSim(): SimState {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error('useSim outside SimProvider');
  return ctx;
}

type AdvanceResult = { days: TickSummary[]; violations: Violation[] };

// The simulation controls and the sim clock. Controls call the engine through /api/sim/* (D58); there is no push,
// so every page refetches when `version` changes.
export function SimProvider({ children }: { children: ReactNode }) {
  const [today, setToday] = useState<string | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ title: string; lines: string[] } | null>(null);
  const [lastAdvance, setLastAdvance] = useState<LastAdvance>(null);

  useEffect(() => {
    const ctl = new AbortController();
    getJson<{ summary: Summary; days: CampaignDays }>('/api/summary', { signal: ctl.signal })
      .then((r) => {
        setToday(r.days.today);
        setClockError(null);
      })
      .catch((err: unknown) => {
        if (!isAbort(err)) setClockError(errorText(err));
      });
    return () => ctl.abort();
  }, [version]);

  const run = useCallback(async (label: string, work: () => Promise<void>) => {
    setBusy({ label });
    setNote(null);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem({ title: 'The control failed', lines: [errorText(err)] });
    } finally {
      setBusy(null);
      setVersion((v) => v + 1);
    }
  }, []);

  const advance = useCallback(
    (days: number) =>
      run(`Advancing ${days} simulated day${days === 1 ? '' : 's'}…`, async () => {
        const r = await getJson<AdvanceResult>('/api/sim/advance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days }),
        });
        // The engine's own tick summaries, added up.
        const sent = r.days.reduce((sum, d) => sum + d.sent.sent, 0);
        const bounced = r.days.reduce((sum, d) => sum + d.sent.bounced, 0);
        const last = r.days.at(-1);
        const to = last ? ` to ${last.now.slice(0, 10)}` : '';
        setNote(
          `Advanced ${r.days.length} day${r.days.length === 1 ? '' : 's'}${to}: sent ${fmtInt(sent)}, bounced ${fmtInt(bounced)}.`,
        );
        if (r.violations.length > 0) {
          setProblem({
            title: `${r.violations.length} invariant violation${r.violations.length === 1 ? '' : 's'} after advancing`,
            lines: r.violations.map((v) => `invariant ${v.invariant} (contact ${v.contactId ?? '-'}): ${v.message}`),
          });
        }
        setLastAdvance((prev) => ({ days, version: (prev?.version ?? 0) + 1 }));
      }),
    [run],
  );

  const reset = useCallback(async () => {
    if (!window.confirm('Reset the simulation? This wipes every send, reply and event and seeds the contacts again.')) {
      return;
    }
    await run('Resetting and seeding…', async () => {
      const r = await getJson<{ contacts: number }>('/api/sim/reset', { method: 'POST' });
      setNote(`Reset: ${fmtInt(r.contacts)} contacts seeded.`);
      setLastAdvance(null);
    });
  }, [run]);

  return (
    <SimContext.Provider value={{ today, version, busy, lastAdvance, advance, reset }}>
      <header className="topbar">
        <div className="clock">
          <span className="clock-label">Simulated date</span>
          <span className="clock-value">{today ?? (clockError ? 'not set' : '…')}</span>
          <span className="tag tag-sim">simulated</span>
        </div>
        <div className="controls" role="group" aria-label="Simulation controls">
          <button type="button" onClick={() => void advance(1)} disabled={busy !== null}>
            Advance 1 day
          </button>
          <button type="button" onClick={() => void advance(7)} disabled={busy !== null}>
            Advance 7 days
          </button>
          <button type="button" className="danger" onClick={() => void reset()} disabled={busy !== null}>
            Reset
          </button>
        </div>
      </header>
      <div className="notices" aria-live="polite">
        {busy && (
          <p className="notice notice-busy" role="status">
            <span className="spinner" aria-hidden="true" />
            {busy.label} The engine is running; controls are paused until it finishes.
          </p>
        )}
        {!busy && note && <p className="notice">{note}</p>}
        {problem && (
          <div className="notice notice-error" role="alert">
            <strong>{problem.title}</strong>
            <ul>
              {problem.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {children}
    </SimContext.Provider>
  );
}
