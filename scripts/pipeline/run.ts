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

  const outcomes = [
    await step("sync", () =>
      runSync(db, {
        fetch,
        today,
        secUserAgent: required("SEC_USER_AGENT"),
        rapidApiKey: env.RAPIDAPI_KEY || null,
        minOffering: num(env.FORM_D_MIN_OFFERING, 2_000_000),
        jobsEveryNDays: num(env.JOBS_RUN_EVERY_N_DAYS, 1),
      }),
    ),
    await step("analyze", () =>
      runAnalyze(db, {
        backend,
        maxAnalyses: num(env.MAX_ANALYSES_PER_RUN, 60),
        concurrency: num(env.ANALYSIS_CONCURRENCY, useApi ? 5 : 1),
        deadline: new Date(startedAt + ANALYZE_BUDGET_MS),
      }),
    ),
  ];
  if (today.endsWith("-01")) outcomes.push(await step("retention", () => runRetention(db, today)));

  // Non-zero only when every step failed, so GitHub flags real outages.
  if (outcomes.every((ok) => !ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
