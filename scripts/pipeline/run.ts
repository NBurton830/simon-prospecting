// Daily pipeline entry point (SPEC §6): sync → analyze → retention (1st of the month).
// Usage: npx tsx scripts/pipeline/run.ts
import Anthropic from "@anthropic-ai/sdk";
import { createApiBackend } from "@/lib/analysis/backends/api";
import { createClaudeCodeBackend } from "@/lib/analysis/backends/claude-code";
import { createDb } from "@/lib/db";
import { utcDate } from "@/lib/dates";
import { runAnalyze } from "@/lib/pipeline/analyze";
import { runRetention } from "@/lib/pipeline/retention";
import { runSync } from "@/lib/pipeline/sync";

const ANALYZE_BUDGET_MS = 50 * 60_000; // the workflow times out at 60 minutes

const env = process.env;
const num = (value: string | undefined, fallback: number) => (value && !Number.isNaN(Number(value)) ? Number(value) : fallback);

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<boolean> {
  try {
    const result = await fn();
    console.log(`[${name}]`, JSON.stringify(result, null, 2));
    return true;
  } catch (err) {
    console.error(`[${name}] failed:`, err);
    return false;
  }
}

async function main() {
  const startedAt = Date.now();
  const today = utcDate(new Date());
  const db = await createDb(required("DATABASE_URL"));
  const useApi = env.ANALYSIS_BACKEND === "api";
  const backend = useApi
    ? createApiBackend({ client: new Anthropic(), model: env.ANTHROPIC_MODEL || undefined })
    : createClaudeCodeBackend({ model: env.CLAUDE_CODE_MODEL || undefined });

  const settings = {
    backend: backend.name,
    maxAnalyses: num(env.MAX_ANALYSES_PER_RUN, 60),
    concurrency: num(env.ANALYSIS_CONCURRENCY, useApi ? 5 : 1),
    minOffering: num(env.FORM_D_MIN_OFFERING, 2_000_000),
    jobsEveryNDays: num(env.JOBS_RUN_EVERY_N_DAYS, 1),
    secUserAgentSet: Boolean(env.SEC_USER_AGENT),
    jobsEnabled: Boolean(env.RAPIDAPI_KEY),
  };
  // Non-secret settings only, so a misplaced GitHub variable is obvious in the log.
  console.log("[settings]", JSON.stringify(settings, null, 2));

  const outcomes = [
    await step("sync", () =>
      runSync(db, {
        fetch,
        today,
        secUserAgent: required("SEC_USER_AGENT"),
        rapidApiKey: env.RAPIDAPI_KEY || null,
        minOffering: settings.minOffering,
        jobsEveryNDays: settings.jobsEveryNDays,
      }),
    ),
    await step("analyze", () =>
      runAnalyze(db, {
        backend,
        maxAnalyses: settings.maxAnalyses,
        concurrency: settings.concurrency,
        deadline: new Date(startedAt + ANALYZE_BUDGET_MS),
      }),
    ),
  ];
  if (today.endsWith("-01")) outcomes.push(await step("retention", () => runRetention(db, today)));

  // Any step that threw (missing setting, database down, …) turns the GitHub run red.
  // A source that failed inside sync (e.g. JSearch over quota) is recorded in pipeline_runs instead.
  if (outcomes.some((ok) => !ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
