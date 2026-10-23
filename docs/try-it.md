# Try it: run the whole engine, with the AI cache, then clear it and run again

Commands marked **(T18)** exist once T18 is built. `npm run report` arrives in T19; until then, step 6's SQL shows the same numbers.

## 0. Start the database (once per boot)

```bash
docker compose up -d db
```

## 1. Start clean, keeping saved AI answers

```bash
npm run db:reset
npm run seed
```

Expect: `AI cache kept: N saved answer(s), M call(s) counted today`, then `seeded 10000 contacts` and `invariants: ok`.

## 2. Write the 20 email sequences once (T18)

```bash
npm run ai:warm
```

One line per segment, `ai`, `cache` or `fallback`. The first time this costs up to 20 of the 50 free calls a day and takes a few minutes. Run it a second time: every line says `cache` and it finishes in about a second.

## 3. Run one day, then a month (T18)

```bash
npm run tick                     # one tick at the current simulated time
npm run advance -- --days 1      # move the clock 1 day and tick
npm run advance -- --days 30     # 30 more days
```

Each day prints a line: date, replies delivered and labelled (rule / ai / fallback), deactivated, sent, bounced, suppressed, AI calls used today. The run ends with `invariants: ok`.

## 4. Look at what happened

In `mnemio.session.sql` (SQLTools, port 5433, database `mnemio`):

```sql
SELECT status, count(*) FROM public.contacts GROUP BY status ORDER BY 2 DESC;
SELECT template_source, count(*) FROM public.sends GROUP BY template_source;
SELECT label_source, count(*) FROM public.replies GROUP BY label_source;
SELECT kind, count(*) FROM ai.llm_cache GROUP BY kind;
SELECT * FROM ai.llm_usage ORDER BY day DESC;
```

## 5. Reset and run again: the cache makes it fast

```bash
npm run db:reset
npm run seed
npm run ai:warm                  # all 20 say "cache", about 1 second, 0 calls
npm run advance -- --days 30
```

The same seed sends the same replies, so the labels the AI gave last time come from the cache too: `ai.llm_usage` barely moves.

## 6. Clear the saved answers and see the slow path again

```sql
TRUNCATE ai.llm_cache;
```

Then repeat step 5. `ai:warm` asks the AI again (slow, up to 20 calls).

**Never clear `ai.llm_usage`.** It must match what OpenRouter has counted today. If it goes back to 0, our budget check thinks there are 50 calls left when the account has fewer, and every call past the real limit is refused (D52).

## Budget

The free account allows 50 AI calls a day, and only successful calls count. A fresh `ai:warm` uses up to 20. A 30-day run also asks the AI to label the replies the rules can't sort, at up to 25 per call. Once the 50 are used up, the run still finishes: emails use the hand-written backups and replies get `needs_review`, and the next day starts fresh. Without a key in `.env`, every step uses the backups.
