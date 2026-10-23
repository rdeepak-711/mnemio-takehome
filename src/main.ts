import { existsSync } from 'node:fs';
import pg from 'pg';
import { config as loadEnv } from 'dotenv';
import { createAiClient } from './ai/client';
import { warmSequences } from './ai/warm';
import { parseArgs, formatTick, type Command } from './cli';
import { loadConfig } from './config';
import { closePool, getPool } from './db/pool';
import { advanceDays, runTick, type TickSummary } from './engine/tick';
import { checkInvariants, type Violation } from './invariants';
import { formatFullRun, fullRun } from './full-run';
import { createProvider } from './mock/provider';
import { formatReport, report } from './report';

// `npm run tick`, `npm run advance -- --days N`, `npm run ai:warm`, `npm run report`, `npm run full-run`.
// dotenv never overrides variables already set, so variables from the shell win over .env.
if (existsSync('.env')) loadEnv({ path: '.env', quiet: true });

// Prints `invariants: ok`, or each violation to stderr and fails the run.
function printInvariants(violations: Violation[]): void {
  if (violations.length === 0) {
    console.log('invariants: ok');
    return;
  }
  for (const v of violations) console.error(`invariant ${v.invariant} (contact ${v.contactId ?? '-'}): ${v.message}`);
  process.exitCode = 1;
}

let command: Command | null = null;
try {
  command = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

if (command) {
  let providerPool: pg.Pool | null = null;
  try {
    const config = loadConfig(process.env);
    const pool = getPool(config.databaseUrl);
    // The provider gets its own pool, so a send can't share a connection with the engine's transactions (D43).
    providerPool = new pg.Pool({ connectionString: config.databaseUrl });
    const provider = createProvider(providerPool, config);
    const ai = createAiClient({
      pool,
      apiKey: config.openrouterApiKey,
      models: config.openrouterModels,
      rpm: config.aiRpm,
      dailyBudget: config.dailyAiBudget,
    });

    // "Today" is the UTC date, as in src/ai/limiter.ts; Postgres supplies it so no real clock is read here.
    const callsToday = async (): Promise<number> => {
      const { rows } = await pool.query<{ calls: number }>(
        `SELECT COALESCE((SELECT calls FROM ai.llm_usage WHERE day = (now() AT TIME ZONE 'UTC')::date), 0)::int AS calls`,
      );
      return rows[0]?.calls ?? 0;
    };

    if (command.command === 'report') {
      // Read-only, so no invariants check.
      console.log(formatReport(await report(pool, { simStart: config.simStart, dailyAiBudget: config.dailyAiBudget })));
    } else if (command.command === 'ai:warm') {
      if (!config.openrouterApiKey) console.log('no OPENROUTER_API_KEY: every sequence uses the fallback');
      const results = await warmSequences(ai);
      for (const r of results) console.log(`${r.segment}  ${r.source}`);
      const count = (source: string) => results.filter((r) => r.source === source).length;
      console.log(
        `warmed ${results.length} segments: ${count('ai')} ai, ${count('cache')} cache, ${count('fallback')} fallback`,
      );
    } else {
      const deps = { pool, provider, config, ai };
      // Each day prints before the clock moves again, so a later failure loses no line already ticked.
      const onDay = async (s: TickSummary) => console.log(formatTick(s, await callsToday(), config.dailyAiBudget));
      let violations: Violation[];
      if (command.command === 'full-run') {
        const result = await fullRun(deps, { onDay });
        console.log(formatFullRun(result));
        violations = result.violations;
        // A clean run leaves no orphaned mock reply (D35), so one fails the run.
        if (result.report.orphaned > 0) {
          console.error(`${result.report.orphaned} orphaned mock replies: a reply whose send was never recorded (D35)`);
          process.exitCode = 1;
        }
        printInvariants(violations);
        console.log(formatReport(result.report));
      } else {
        if (command.command === 'run') await onDay(await runTick(deps));
        else await advanceDays(deps, command.days, onDay);
        violations = await checkInvariants(pool);
        printInvariants(violations);
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await closePool();
    await providerPool?.end();
  }
}
