'use client';

import { LABELS, REPLY_LABELS } from '../../src/labels';
import type { ClassifierStats } from '../../src/web/classifier';
import { LABEL_NAME, SOURCE_WORDS, fmtInt, fmtTime } from '../_components/api';
import { ClassifierBars, ShareBar } from '../_components/ClassifierBars';
import { useSim } from '../_components/sim';
import { Failed, Loading } from '../_components/states';
import { useApi } from '../_components/useApi';

const SOURCES = ['rule', 'ai', 'fallback'] as const;
const SOURCE_NAME: Record<(typeof SOURCES)[number], string> = { rule: 'Rule', ai: 'AI', fallback: 'Fallback' };

// The engine's own reply labels since SIM_START, scored against the mock's hidden true label (/api/classifier, D60).
export default function ClassifierPage() {
  const { version } = useSim();
  const stats = useApi<ClassifierStats>('/api/classifier', version);
  const s = stats.data;

  const cell = (t: string, l: string) => s?.confusion.find((c) => c.trueLabel === t && c.label === l)?.count ?? 0;

  return (
    <>
      <h1>AI classifier</h1>
      <p className="disclaimer" role="note">
        These are labels the system produced, scored against the mock&apos;s hidden true label. They are not claims
        about real people.
      </p>
      {s ? (
        <div className={stats.loading ? 'stale' : undefined}>
          <p className="lede">
            {fmtInt(s.total)} replies labelled since the simulation started on{' '}
            <span className="mono">{s.simStart}</span>, the same scope as <code>npm run report</code>.
          </p>
          {s.total === 0 ? (
            <p className="state state-empty">Nothing labelled yet. Advance a few days to get replies.</p>
          ) : (
            <>
              <div className="grid-2">
                <section className="card" aria-labelledby="dist-h">
                  <h2 id="dist-h">Predicted label</h2>
                  <ClassifierBars s={s} />
                </section>
                <section className="card" aria-labelledby="src-h">
                  <h2 id="src-h">Who labelled it</h2>
                  <div className="shares">
                    {SOURCES.map((k) => (
                      <ShareBar key={k} name={SOURCE_NAME[k]} cls={`src-${k}`} n={s.bySource[k]} of={s.total} />
                    ))}
                  </div>
                  <p className="kpi-sub note">
                    Rules answer first; the AI is asked only when no rule matches; the fallback labels a reply
                    &ldquo;needs review&rdquo; when the AI gave no answer. Fallback labels are not scored.
                  </p>
                </section>
              </div>

              <section className="card section" aria-labelledby="cm-h">
                <h2 id="cm-h">Hidden true label × predicted label</h2>
                {/* On a phone the table scrolls sideways inside its card instead of breaking words. */}
                <div className="matrix-scroll">
                  <table className="matrix">
                    <caption className="sr-only">
                      Rows are the mock&apos;s hidden true label, columns the label the system gave.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">True ↓ / predicted →</th>
                        {LABELS.map((l) => (
                          <th key={l} scope="col">
                            {LABEL_NAME[l]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {REPLY_LABELS.map((t) => (
                        <tr key={t}>
                          <th scope="row">{LABEL_NAME[t]}</th>
                          {LABELS.map((l) => {
                            const n = cell(t, l);
                            return (
                              <td key={l} className={`${n === 0 ? 'zero' : ''}${t === l ? ' diag' : ''}`}>
                                {fmtInt(n)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="kpi-sub note">Outlined cells are correct labels.</p>
              </section>

              <section className="section" aria-labelledby="ex-h">
                <h2 id="ex-h">Example replies, newest label first</h2>
                <div className="examples">
                  {LABELS.map((l) => (
                    <section key={l} className="card" aria-label={`Examples labelled ${LABEL_NAME[l]}`}>
                      <h3>{LABEL_NAME[l]}</h3>
                      {s.examples[l].length === 0 ? (
                        <p className="state">No reply has this label.</p>
                      ) : (
                        <ul className="example-list">
                          {s.examples[l].map((e) => (
                            <li key={e.id}>
                              <blockquote>{e.body}</blockquote>
                              <div className="meta">
                                Predicted {LABEL_NAME[e.label]}: {SOURCE_WORDS[e.labelSource] ?? e.labelSource} ·{' '}
                                {fmtTime(e.classifiedAt)}
                              </div>
                              <div className="meta hidden-label">
                                Mock&apos;s hidden label, used only for scoring:{' '}
                                {LABEL_NAME[e.trueLabel] ?? e.trueLabel}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              </section>
            </>
          )}

          <section className="card section" aria-labelledby="left-h">
            <h2 id="left-h">Left out</h2>
            <dl className="fields">
              <dt>{fmtInt(s.unlabelled)} unlabelled</dt>
              <dd>Replies that arrived but have not been labelled yet; the next simulated day labels them.</dd>
              <dt>{fmtInt(s.excludedSeeded)} seeded</dt>
              <dd>
                Replies the seed labelled before the simulation started; the seed wrote the true label in, so scoring
                them would only flatter the classifier.
              </dd>
            </dl>
          </section>
        </div>
      ) : stats.error ? (
        <Failed error={stats.error} />
      ) : (
        <Loading />
      )}
      {s && stats.error ? <Failed error={stats.error} /> : null}
    </>
  );
}
