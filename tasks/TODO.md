# TODO

Status: ☐ not started · 🧪 tests written (failing) · 🔨 junior building · 👀 in review · 🗣 awaiting explain-back · ✅ done

Loop per task: harness engineer writes `T0x-*.md` + failing tests → junior makes them pass → review against the task file → Deepak answers the explain-back questions (1 for Layer 1 tasks T02–T07, 3 for everything else) → commit on branch `t0x-<name>` → merge to `main`.

Target (Deepak, 22 Oct, corrected): **everything, dashboard included, finished and submittable by Fri 23 Oct night.** Order: engine T01–T20 → plain dashboard (KPIs, contacts, controls) → T22 → the visual "orchestration" view (animated funnel, day slider, journey of sends/bounces/replies) last → T23 README. Nothing is dropped (Deepak, 23 Oct): all tasks including T21b and T22 get built. Vikrant's real deadline is 5 days from receipt (21 Oct 19:53) = Mon 26 Oct ~19:53; 23 Oct was a self-set target.

## Layer 0 — Skeleton
- ✅ T01 Repo skeleton (package, tsconfig, Vitest, Docker Postgres, pool) → `tasks/T01-skeleton.md`

## Layer 1 — Pure logic
- ✅ T02 Config loader → `tasks/T02-config.md`
- ✅ T03 State machine → `tasks/T03-lifecycle.md`
- ✅ T04 Schedule (next date, OOO delay) → `tasks/T04-schedule.md`
- ✅ T05 Template render + content check → `tasks/T05-render.md`
- ✅ T06 Segments (role family) → `tasks/T06-segments.md`
- ✅ T07 Rule classifier → `tasks/T07-rules.md`

## Layer 2 — Database (task files written when Layer 1 is green)
- ✅ T08 Schema + migrations → `tasks/T08-schema.md`
- ✅ T09 Simulated clock → `tasks/T09-clock.md`
- ✅ T10 Seed 10k with consistent history
- ✅ T11 Mock provider (bounces, replies with true label, idempotency)

## Layer 3 — Engine
- ✅ T12 Claim with SKIP LOCKED
- ☐ T13 Send step (transaction, parallel workers, crash test)
- ☐ T14 Reply delivery + processing
- ☐ T15 Deactivation

## Layer 4 — AI
- ☐ T16 OpenRouter client (limiter, retries, cache, fallback, model pick)
- ☐ T17 Sequence writer + batch classifier

## Layer 5 — Whole system
- ☐ T18 Tick + advance CLI
- ☐ T19 Report (+ classifier accuracy)
- ☐ T20 Full 10k run, timed

## Layer 6 — Dashboard
- ☐ T21a Core dashboard (KPIs, day slider + funnel, journey, contacts, controls)
- ☐ T21b Extras (classifier view, activity log, play/pause)

## Layer 7 — Bonus and delivery
- ☐ T22 Bonus: mailboxes + warm-up, auto-pause, timezone windows, domain caps, List-Unsubscribe
- ☐ T23 README (7 sections, measured numbers, clean-clone check)
