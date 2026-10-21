# Dashboard spec (scoped from `spec/dashboard-brief.md`)

The dashboard is a view onto the engine. It never has its own business logic, never stores its own copy of campaign state, and never animates something the database doesn't contain. It is built last (T21), after the engine passes T20.

## Two hard rules

1. **State on day D comes from `events` up to D.** The slider doesn't use stored snapshots. "The funnel on day 12" is a query over `events.occurred_at <= day 12`. If an event isn't in the table, it can't be on the screen.
2. **Controls call the engine.** "Advance 1 day" calls the same `advance()` the CLI uses, through a route handler. "Reset" calls `resetDb` + `seed`. No duplicated logic in the UI.

## T21a — core (part of the submission)

| Piece | What it shows | Data source |
|---|---|---|
| **KPI row** | Total contacts, emails sent, replies, bounces, unsubscribes, active, deactivated, reply rate, bounce rate. Numbers count up on load and on change. | `GET /api/summary?day=D` |
| **Day slider + funnel** | Drag through simulated days. The funnel (New → First → FU1 → FU2 → FU3 → Deactivated, with Replied / Bounced / Unsubscribed exits) redraws for that day. | `GET /api/summary?day=D` (counts per status as of D, computed from events) |
| **Daily activity chart** | Per day: first emails vs follow-ups sent, replies, bounces. | `GET /api/timeline` |
| **Journey animation** | On "advance", contacts that moved stage animate from one stage to the next, with the count that moved. | Difference between `summary?day=D` and `summary?day=D+1` |
| **Contacts** | Paginated table (50 per page, server-side), search by name/email/company, filter by status. Row opens a detail panel with that contact's full timeline (every send, reply and label, with its source). | `GET /api/contacts?q&status&page`, `GET /api/contacts/:id` |
| **Simulation controls** | Current simulated date, advance 1 day, advance 7 days, reset. | `POST /api/sim/advance {days}`, `POST /api/sim/reset` |

Pages: `/` (KPIs, slider, funnel, chart), `/journey` (journey view), `/contacts` (table + detail).

## T21b — extras (only if T21a is done and time is left)

AI classifier view (label counts, rule vs AI split, accuracy against the mock's true labels, example replies) · activity log page with filters · play/pause with speed · stage drill-down from the funnel · sidebar with all six sections from the brief.

## Look and motion

- Dark command-centre look from the brief: restrained accent colours, fine borders, no glassmorphism, no moving backgrounds.
- Status colours always paired with a text label or icon (never colour alone).
- Anime.js only for: KPI count-up, staggered card entrance, funnel bar growth, journey transitions, slider transitions. Check the installed version before writing calls (v4 changed the API to `animate()` imports), and don't guess method names.
- `prefers-reduced-motion`: animations off, final values shown immediately.
- Works at phone width (16px side gutter, no horizontal scroll).
- Loading, empty ("no contacts yet — run `npm run seed`"), and error states on every data block.

## Not in scope

Login (decision in `docs/decisions.md`), editing contacts from the UI, real-time push (the page refetches after each control action), a mock-data layer separate from the real DB (the DB is already seeded fake data).
