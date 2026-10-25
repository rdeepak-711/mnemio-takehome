# Findings

Research notes: what was learned, with dates. Decisions made from these go in `decisions.md`.

## OpenRouter free models — checked 2026-10-23 (T16)

**Account limits** (from `GET /api/v1/key` on the test account's key): free tier, **50 free-model requests per day** per account (`free_model_daily_requests`). The per-minute field is deprecated, so pacing is ours (`AI_RPM`). The key has a $100 spend cap but the free-tier account holds no credits. **Failed calls (429, 404) did not count**: five calls, four failures, 1 request used.

**Live list** (`GET /api/v1/models`, public, no key needed): 468 models, 17 ending in `:free`. Filtered to those advertising `response_format` (JSON mode), not previews or safety filters, from established providers.

**Smoke test**, one real call each, a 3-reply labelling prompt with `response_format: json_object`, `temperature: 0`:

| Model | Result |
|---|---|
| `nvidia/nemotron-3.5-super-vl:free` | 200, valid JSON, **42.7 s**; labelled "Maybe next quarter, ping me then." as `interested` (arguably `not_interested` or `needs_review`) |
| `google/gemma-4-31b-it:free` | 429 "temporarily rate-limited upstream" |
| `google/gemma-4-26b-a4b-it:free` | 429 "temporarily rate-limited upstream" |
| `xingchen-agi/xing4.0-29b-a4b:free` | 429 "temporarily rate-limited upstream" |
| `nvidia/nemotron-3-super-120b-a12b:free` | 404 (listed but not served) |

**What this means for the build:** free models fail often and are slow, so the retry → next model → fallback chain will run in practice, not just in tests. The client timeout must allow ~60 s. A listed model can be dead (404), so a 404 should move to the next model, not retry. Accuracy on ambiguous replies needs measuring (T19), not assuming.

**Second check, same day**, against the website's free filter (https://openrouter.ai/models?variant=free, rendered by JavaScript, so a plain fetch shows the general "newest" list, mostly paid models):

| Model | Result |
|---|---|
| `baseten/mammoth-1:free`, `baseten/elephant-1:free` | 400 "is a decisions model and cannot be used with the chat/completions endpoint"; not in the API's chat list for that reason. Unusable. |
| `recursive/flint-v1.0:free` | 200, valid JSON, **10.8 s**, same labels as the Nvidia model |
| `google/gemma-4-31b-it:free` | still 429 upstream |

The account counter still read 1 used after Flint's success, so the count may lag. Both working models called "Maybe next quarter, ping me then." `interested`; the test prompt gave no label definitions, so this says more about the prompt than the models. T17's prompt must define that "not now / later" is `not_interested`.

**Superseded:** **Set in `.env`:** `OPENROUTER_MODELS=nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free` — the one that answered first, then the two Gemmas. Three instead of the spec's two because two of the five candidates were unavailable at the moment of testing. To re-check before the final run.

**Set in `.env` (second check):** `OPENROUTER_MODELS=recursive/flint-v1.0:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free` — Flint first (fastest that answered), Nemotron second (answered, slow), Gemma 31B third (rate-limited at both checks, kept as a last try).

**Third check, same day**, prompted by the website's free list (Deepak pasted the descriptions). Prompt now defines the labels ("not now / later / next quarter" is `not_interested`):

| Model | Settings | Result |
|---|---|---|
| `recursive/flint-v1.0:free` | JSON mode | **3.0 s**, valid JSON, all 3 right |
| `nvidia/nemotron-3.5-lightning:free` | no JSON mode (not advertised) | **7.0 s**, valid JSON anyway, all 3 right, 689 output tokens |
| `nvidia/nemotron-3.5-super-vl:free` | JSON mode, `reasoning: { enabled: false }` | **57.3 s**, all 3 right, only 46 output tokens |

- Super VL's slowness is queueing at the provider, not reasoning: 46 output tokens still took 57 s.
- With label definitions in the prompt, every model labelled the "next quarter" reply correctly; the earlier miss was the prompt.
- JSON mode isn't needed: Lightning returned valid JSON without it. The client should ask for JSON in the prompt and validate with zod rather than depend on `response_format`.
- From the descriptions: Flint is built for coding agents and was released 21 Oct 2026, so its email writing (T17) is untested. Liquid's models retain prompts for training. Mercury Decide, Mammoth 1 and Elephant 1 are decision models (calibrated probabilities, a good fit for classification in principle) on a separate alpha endpoint; not used. Dots3-Note Preview goes away 31 Dec 2026.

**Set in `.env` (third check):** `OPENROUTER_MODELS=recursive/flint-v1.0:free,nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3.5-super-vl:free`.

## First live runs of the prompts — 2026-10-23 (T17)

- **Sequence, `tech:saas`, prompt v1:** Flint answered in 20 s with a sequence that passed every check, but each body was one run-on line ending "… today? Sam" (no paragraphs, sign-off inline). The checks didn't cover layout. Fixed: the schema now needs a blank line between paragraphs and `Sam` alone on the last line, and the prompt asks for it (prompt v2).
- **Sequence, prompt v2:** Flint, 28 s, valid, laid out properly ("Hi {{first_name}}," / paragraphs / "Thanks," / "Sam"). Plain but usable wording.
- **Classifier:** the 12 reply-bank texts that the rules return `null` for, in one call, 7.5 s: 11 matched the mock's true label. Miss: "Who gave you my address?" (true `not_interested`, AI `needs_review`), the bank's deliberately ambiguous text.
- Account usage after these runs: 3 of 50 free requests.

## First full engine runs — 2026-10-23 (T18)

Probe database, 10,000-contact seed, no OpenRouter key (cache only: 1 sequence and 13 reply labels saved from earlier probes).
- `advance --days 30`: 62.8 s wall clock, `invariants: ok`. A second `advance --days 30` found nothing left to do (every day 0), `invariants: ok`.
- After 60 days every contact had left the sequence: 7,160 deactivated, 1,883 replied, 503 unsubscribed, 454 bounced.
- With no key, saved answers were still used: 1,339 sends came from the one cached sequence (`template_source = 'cache'`), and 1,454 replies were labelled from the 13 cached reply labels. The reply bank is a fixed set of texts, so a handful of saved labels covers most replies. The rest: 640 by rule, 12 fallback.
- Only days 24–30 of the first run were kept in the output: days 24–27 deactivated 706–726 contacts a day, days 28–30 between 21 and 35. Why the peak falls there was not checked; T19's report will show it per day.


## First report on a finished run — 2026-10-23 (T19)

Same probe database after 60 days, no key, cache only. Reply rate 28.8% (2,769 of 9,615 contacts with an accepted send), which fits the mock's 8% chance per email across up to 4 emails. Bounce rate 1.3% (454 of 35,245 sends, seed included). Engine emails: 1,339 from the cached sequence, 25,256 fallback. Classifier since start: rules 640 of 640 correct, AI (all from 13 cached labels) 1,324 of 1,454 correct (91.1%), 12 fallback; 142 needs review; 0 unlabelled; 0 orphaned.

## The timed full run — 2026-10-23 (T20)

`npm run full-run` on the probe database, 10,000 contacts, no key (cache: 1 sequence, 13 labels). reset 0.1 s, seed 1.1 s, warm 0.0 s, advance 54.1 s over 40 days, check 0.1 s, report 0.0 s, total 55.6 s; exit 0, invariants ok, 0 orphaned. The final report was identical to the earlier `advance --days 30` twice on the same seed (same statuses, rates and classifier counts), so the outcome doesn't depend on how the days are stepped. Day 1 sent 3,203 emails (88 bounced); days 2 and 3 about 1,350 each.

## The dashboard on the 10k run — 2026-10-25 (T21a)

- **Next 16.4.0 had known advisories** (GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr, remote code execution; GHSA-p3m5-59mp-jv5r, denial of service; all 16.0.0–16.4.0). 16.4.2 builds with TypeScript 7.0.2 and `npm audit --omit=dev` reports 0. Next's own build log suggested running an upgrade agent command; that was tool output, not an instruction, and was not run.
- **Next's bundler can't load `new URL('./migrations/', import.meta.url)`**: it reads it as an asset import of a folder and the build fails once a route reaches `src/db/migrate.ts`. Switched to `path` (D59). The build still warns that the `readdir` makes it trace the whole project; harmless without a deploy.
- **Speed on the finished 10k probe run** (83 days of events, 35,245 sends), measured with `curl` against the production server: `/api/summary` for today answered with numbers equal to `contacts.status` (1,883 replied, 454 bounced, 503 unsubscribed, 7,160 deactivated); `/api/timeline` 38 ms; `/api/contacts?q=an&page=3` 14 ms.
- **Browser check** (headless Chromium 1248 against the production server on the probe database, AI key blank): no script errors and no sideways scroll on `/`, `/journey` and `/contacts` at 1440 and 390 px; slider, chart-bar click, advance 1 day (clock 12 → 13 Dec), the reset confirmation (cancelled), search, status filter and the detail drawer all worked. Two bugs found and fixed: Enter on a contact row opened the drawer and the same key press then activated its Close button (fixed with `preventDefault`); the chart's axis text was 6–7 px because it scaled with the SVG (now 14 px at both widths). Not seen: the controls' busy state during a long advance (nobody was left in sequence, so the advance returned at once) and the journey animation after an advance.
- **A deactivated contact can still move**: the journey view on 12 Dec showed one deactivated → unsubscribed move. That is allowed (`src/lifecycle.ts`, a deactivated contact can still answer); the probe data has 45 moves out of `deactivated`.

## Dashboard extras on the 10k run — 2026-10-25 (T21b)

- **Speed on the probe database** (second request, production server): `/api/classifier` 3 ms; `/api/activity` (45,621 listed events) 13 ms, `?kind=deactivated` 15 ms, `?q=smith` 12 ms, `?day=2026-11-05` 5 ms; `/api/stage?status=deactivated` 21 ms, `?day=2026-11-10&status=first_sent` 15 ms. The stage total for first_sent on 10 Nov (81) equalled the funnel's count.
- **Classifier numbers match the report** on the finished run: 2,106 labelled since SIM_START, rules 640 of 640 correct, AI 1,324 of 1,454 (91.1%), 12 fallback, 142 needs review, 700 seeded replies left out. The AI itself returned `needs_review` for 130 replies whose true label was not interested; the fallback gave the other 12.
- **Play on a fresh database**: an empty `mnemio_play` database was reset and seeded through the dashboard's own Reset button (2,000 contacts), then played at 4×: 9 simulated days in 9 seconds, Advance and Reset disabled while playing, Pause stopped it after the day in progress, and the clock then stayed put. `checkInvariants` afterwards: 0 violations (5,813 sends). On the finished probe run Play advanced one day and stopped with "Nobody is left in the sequence".
- **Browser check**: all six pages at 1440 and 390 px, six sidebar links, no sideways page scroll, no script errors on the seeded databases. The funnel drill-down opens by keyboard and Escape returns focus to the bar. The activity kind filter writes `?kind=` into the URL. Fixed at review: the confusion table broke words mid-word at 390 px; it now scrolls sideways inside its card. Before the fresh database was seeded its API calls answered 500 ("sim_clock is not set; run npm run seed"); the pages showed their empty state, but the status code is a server error for what is really "not seeded yet".
- **A test bug of the harness's own**: `tests/db/web-classifier.test.ts` built a timestamp by text concatenation inside `INSERT … SELECT` without a cast; Postgres refuses text for a `timestamptz` column there. Found by the builder, fixed with `::timestamptz`.

## Deliverability on the 10k seed — 2026-10-25 (T22)

- `npm test` 1,088/1,088 after the harness added migration 003 to the four tests that list migrations, and gave the 30-day tick test a 60 s timeout: it ran at Vitest's 5 s default and took 5.07–5.10 s, before T22 as well (measured by the builder on the parent commit).
- Junior's scratch run, 10k seed, `npm run advance -- --days 3` with deliverability on: 33 s, 2,132 / 1,211 / 1,870 emails a day, invariants ok; the report's block showed 50 mailboxes, 0 pauses, 866 of 2,500 capacity on 5 Nov, busiest domain 5 of cap 10.
- One hourly day on that database (6 Nov, profiled step by step): deliver 0.1 s, classify 0.4 s, deactivate 0.06 s, send 12.3 s for 2,278 emails in 98 batches.
- Same moment, two copies of the database, one send step each: off 3.5 ms per email (870 in 3.1 s, 5 batches), on 5.2 ms per email (428 in 2.2 s, 13 batches). The extra cost per email is the domain lock, the domain count and the mailbox column update; the claim with the window costs about 7 ms per batch (`EXPLAIN ANALYZE`), the domain count 0.05 ms.
- So a busy day was already about 3 s per 1,000 emails before T22, which doesn't match the README's "0.3–2.0 s per day" (measured on quieter days in T14/T15). T23 re-measures the full run and replaces that claim.

