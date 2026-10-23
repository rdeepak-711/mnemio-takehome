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
- Day lines in the first 30 days show deactivation peaks around 700 a day near day 25, as the seeded `follow_up_3_sent` group and the first wave of new contacts reach the end of their waits.
