'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { TickSummary } from '../../src/engine/tick';
import type { Violation } from '../../src/invariants';
import { PLAY_SPEEDS, playDelayMs, stopReason, type PlaySpeed } from '../../src/web/play';
import type { Summary, CampaignDays } from '../../src/web/summary';
import { errorText, fmtInt, getJson, isAbort, type Wire } from './api';

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
type Problem = { title: string; lines: string[] };

// What the engine did over some days, from its own tick summaries; violations as lines for the error notice.
function advanceNote(r: Wire<AdvanceResult>, prefix: string): string {
  const sent = r.days.reduce((sum, d) => sum + d.sent.sent, 0);
  const bounced = r.days.reduce((sum, d) => sum + d.sent.bounced, 0);
  const last = r.days.at(-1);
  const to = last ? ` to ${last.now.slice(0, 10)}` : '';
  return `${prefix} ${r.days.length} day${r.days.length === 1 ? '' : 's'}${to}: sent ${fmtInt(sent)}, bounced ${fmtInt(bounced)}.`;
}
const violationLines = (r: Wire<AdvanceResult>) =>
  r.violations.map((v) => `invariant ${v.invariant} (contact ${v.contactId ?? '-'}): ${v.message}`);

// Resolves after `ms`, or at once when any signal aborts: a cancellable timeout, never setInterval (D63).
function wait(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((sig) => sig.aborted)) return resolve();
    const done = () => {
      clearTimeout(timer);
      for (const sig of signals) sig.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    for (const sig of signals) sig.addEventListener('abort', done, { once: true });
  });
}

// One play run: `kill` (unmount, leaving the page) aborts requests and the wait; `pause` only ends the wait, so the
// day in progress finishes first.
type Loop = { kill: AbortController; pause: AbortController };

// The simulation controls and the sim clock. Controls call the engine through /api/sim/* (D58); there is no push,
// so every page refetches when `version` changes.
export function SimProvider({ children }: { children: ReactNode }) {
  const [today, setToday] = useState<string | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [lastAdvance, setLastAdvance] = useState<LastAdvance>(null);
  const [playing, setPlaying] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [speed, setSpeed] = useState<PlaySpeed>(1);
  const speedRef = useRef<PlaySpeed>(speed);
  speedRef.current = speed; // read at each pause, so a change applies from the next day
  const loopRef = useRef<Loop | null>(null);

  // Unmounting or leaving the page stops the loop.
  useEffect(() => {
    const stop = () => loopRef.current?.kill.abort();
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, []);

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
        setNote(advanceNote(r, 'Advanced'));
        if (r.violations.length > 0) {
          setProblem({
            title: `${r.violations.length} invariant violation${r.violations.length === 1 ? '' : 's'} after advancing`,
            lines: violationLines(r),
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

  // Play (D63): advance one day, refetch, check the stop rule, pause for the speed, repeat. Each day goes through the
  // same route and lock as the buttons.
  const play = useCallback(async () => {
    if (loopRef.current) return;
    const loop: Loop = { kill: new AbortController(), pause: new AbortController() };
    loopRef.current = loop;
    const signal = loop.kill.signal;
    setPlaying(true);
    setPausing(false);
    setNote(null);
    setProblem(null);
    let stop: { reason: string; problem: Problem | null } | null = null;
    let lastDay: string | null = null;
    try {
      while (!loop.pause.signal.aborted && !signal.aborted) {
        let r: Wire<AdvanceResult> | null = null;
        let error: string | null = null;
        let active = 0;
        try {
          r = await getJson<AdvanceResult>('/api/sim/advance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: 1 }),
            signal,
          });
          lastDay = r.days.at(-1)?.now.slice(0, 10) ?? lastDay;
          setNote(advanceNote(r, `Playing at ${speedRef.current}×: advanced`));
          setLastAdvance((prev) => ({ days: 1, version: (prev?.version ?? 0) + 1 }));
          setVersion((v) => v + 1);
          const now = await getJson<{ summary: Summary }>('/api/summary', { signal });
          active = now.summary.active;
        } catch (err) {
          if (isAbort(err)) return; // unmounted: nothing left to update
          error = errorText(err);
        }
        const violations = r?.violations.length ?? 0;
        const reason = stopReason({ active, violations, error });
        if (reason) {
          stop = {
            reason,
            problem: error
              ? { title: 'Play stopped: the control failed', lines: [error] }
              : violations > 0 && r
                ? { title: `Play stopped: ${reason}`, lines: violationLines(r) }
                : null,
          };
          break;
        }
        await wait(playDelayMs(speedRef.current), signal, loop.pause.signal);
      }
    } finally {
      loopRef.current = null;
      if (!signal.aborted) {
        setPlaying(false);
        setPausing(false);
        const on = lastDay ? ` on ${lastDay}` : '';
        if (stop?.problem) setProblem(stop.problem);
        else if (stop) setNote(`Play stopped${on}: ${stop.reason}.`);
        else setNote(`Paused${on}.`);
      }
    }
  }, []);

  const pause = useCallback(() => {
    if (!loopRef.current) return;
    setPausing(true);
    loopRef.current.pause.abort();
  }, []);

  const locked = busy !== null || playing;

  return (
    <SimContext.Provider value={{ today, version, busy, lastAdvance, advance, reset }}>
      <header className="topbar">
        <div className="clock">
          <span className="clock-label">Simulated date</span>
          <span className="clock-value">{today ?? (clockError ? 'not set' : '…')}</span>
          <span className="tag tag-sim">simulated</span>
        </div>
        <div className="controls" role="group" aria-label="Simulation controls">
          <button
            type="button"
            className="play"
            aria-pressed={playing}
            onClick={() => (playing ? pause() : void play())}
            disabled={busy !== null || pausing}
          >
            <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span> {pausing ? 'Pausing…' : playing ? 'Pause' : 'Play'}
          </button>
          <label className="speed">
            <span className="sr-only">Play speed</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as PlaySpeed)}>
              {PLAY_SPEEDS.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void advance(1)} disabled={locked}>
            Advance 1 day
          </button>
          <button type="button" onClick={() => void advance(7)} disabled={locked}>
            Advance 7 days
          </button>
          <button type="button" className="danger" onClick={() => void reset()} disabled={locked}>
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
        {playing && (
          <p className="notice notice-busy" role="status">
            <span className="spinner" aria-hidden="true" />
            {pausing
              ? 'Pausing after the day in progress…'
              : `Playing at ${speed}×: one simulated day at a time, ${fmtInt(playDelayMs(speed))} ms apart. Pause stops after the day in progress.`}
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
