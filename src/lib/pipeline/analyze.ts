import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { brands, pipelineRuns, prospects, signals } from "@/lib/db/schema";
import {
  AuthError,
  NonRetryableError,
  UsageLimitError,
  type AnalysisBackend,
} from "@/lib/analysis/backend";
import { buildUserMessage, SYSTEM_PROMPT, type PromptSignal } from "@/lib/analysis/prompt";
import { AnalysisSchema } from "@/lib/analysis/schema";
import { computeScore } from "@/lib/analysis/score";
import { buildRecentSignalSummary } from "@/lib/analysis/signal-summary";
import { addDays, utcDate } from "@/lib/dates";
import type { FormDFiling } from "@/lib/ingest/sec-edgar";
import type { JobListing } from "@/lib/ingest/jobs-api";

export const STALE_LOCK_MINUTES = 30;
export const MAX_ATTEMPTS = 3;
export const SIGNAL_LOOKBACK_DAYS = 180;

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

// PROCESSING signals locked more than STALE_LOCK_MINUTES before `now` go back to PENDING. Returns the count.
export async function recoverStaleLocks(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_LOCK_MINUTES * 60_000);
  const recovered = await db
    .update(signals)
    .set({ status: "PENDING", lockedAt: null })
    .where(and(eq(signals.status, "PROCESSING"), lt(signals.lockedAt, cutoff)))
    .returning({ id: signals.id });
  return recovered.length;
}

// Claims every PENDING signal of the brand with the newest pending signal (single UPDATE ... RETURNING):
// status PROCESSING, locked_at = now, attempts + 1. Returns the brand id, or null when nothing is pending.
// excludeBrandIds: brands already tried this run, so a retryable failure isn't retried in the same run.
export async function claimNextBrand(
  db: Db,
  opts: { now?: Date; excludeBrandIds?: string[] } = {},
): Promise<string | null> {
  const now = opts.now ?? new Date();
  const exclude = opts.excludeBrandIds ?? [];
  const notTried = exclude.length
    ? sql`AND brand_id NOT IN (${sql.join(exclude.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``;
  // SKIP LOCKED keeps concurrent claimers on different brands; the re-checked status prevents double claims.
  const result = await db.execute(sql`
    WITH picked AS (
      SELECT brand_id FROM signals
      WHERE status = 'PENDING' ${notTried}
      ORDER BY signal_date DESC, brand_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE signals
    SET status = 'PROCESSING', locked_at = ${now.toISOString()}::timestamptz, attempts = attempts + 1
    WHERE status = 'PENDING' AND brand_id IN (SELECT brand_id FROM picked)
    RETURNING brand_id
  `);
  return rowsOf<{ brand_id: string }>(result)[0]?.brand_id ?? null;
}

export type StopReason = "drained" | "max_analyses" | "deadline" | "usage_limit" | "auth_error";

export interface AnalyzeOptions {
  backend: AnalysisBackend;
  maxAnalyses: number;
  concurrency: number;
  deadline: Date; // no new brand is started after this
  now?: () => Date;
  today?: string; // YYYY-MM-DD for scoring; defaults to now() in UTC
}

export interface AnalyzeResult {
  runId: string;
  analyzed: number; // prospects created or updated
  excluded: number;
  failed: number; // brands whose signals ended FAILED this run
  retried: number; // brands returned to PENDING after a counted attempt
  carriedOver: number; // distinct brands still PENDING when the run ended
  stopReason: StopReason;
  inputTokens: number;
  outputTokens: number;
}

type SignalRow = typeof signals.$inferSelect;
type Outcome = "analyzed" | "excluded" | "failed" | "retried" | "usage_limit" | "auth_error";

function toPromptSignal(s: SignalRow): PromptSignal {
  if (s.signalType === "SEC_FORM_D") {
    const p = (s.rawPayload ?? {}) as Partial<FormDFiling>;
    return {
      type: "SEC_FORM_D",
      date: s.signalDate,
      url: s.sourceUrl,
      industryGroup: p.industryGroupType ?? "",
      totalOfferingAmount: p.totalOfferingAmount ?? null,
      totalAmountSold: p.totalAmountSold ?? null,
      dateOfFirstSale: p.dateOfFirstSale ?? null,
      relatedPersons: p.relatedPersons ?? [],
    };
  }
  const p = (s.rawPayload ?? {}) as Partial<JobListing>;
  return {
    type: "JOB_LISTING",
    date: s.signalDate,
    url: s.sourceUrl,
    title: p.title ?? s.title ?? "",
    location: [p.city, p.state].filter(Boolean).join(", ") || null,
    description: p.description ?? "",
  };
}

// Sets the claimed (PROCESSING) signals of a brand to `status`, optionally undoing the attempt.
async function releaseClaimed(db: Db, brandId: string, set: Partial<typeof signals.$inferInsert>, undoAttempt = false) {
  return db
    .update(signals)
    .set({ ...set, lockedAt: null, ...(undoAttempt ? { attempts: sql`GREATEST(${signals.attempts} - 1, 0)` } : {}) })
    .where(and(eq(signals.brandId, brandId), eq(signals.status, "PROCESSING")))
    .returning({ status: signals.status });
}

const describeError = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 2000) : String(err).slice(0, 2000);

async function analyzeBrand(
  db: Db,
  brandId: string,
  backend: AnalysisBackend,
  today: string,
  now: Date,
  tokens: { input: number; output: number },
): Promise<Outcome> {
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  const brandSignals = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.brandId, brandId),
        inArray(signals.status, ["PROCESSING", "PROCESSED"]),
        gte(signals.signalDate, addDays(today, -SIGNAL_LOOKBACK_DAYS)),
      ),
    );

  let output: unknown;
  try {
    const message = buildUserMessage(
      { name: brand.name, legalName: brand.legalName, domain: brand.domain, hqState: brand.hqState },
      brandSignals.map(toPromptSignal),
      today,
    );
    const result = await backend.analyze(SYSTEM_PROMPT, message);
    tokens.input += result.usage?.inputTokens ?? 0;
    tokens.output += result.usage?.outputTokens ?? 0;
    output = result.output;
  } catch (err) {
    return handleFailure(db, brandId, err);
  }

  const parsed = AnalysisSchema.safeParse(output);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return handleFailure(db, brandId, new Error(`Invalid analysis output: ${issues}`));
  }
  const a = parsed.data;

  if (!a.is_consumer_brand) {
    await db
      .update(brands)
      .set({ excluded: true, exclusionReason: a.exclusion_reason ?? "Not a consumer brand" })
      .where(eq(brands.id, brandId));
    await releaseClaimed(db, brandId, { status: "SKIPPED", processedAt: now });
    await db
      .update(prospects)
      .set({ status: "ARCHIVED", statusChangedAt: now, statusChangedBy: "pipeline" })
      .where(and(eq(prospects.brandId, brandId), sql`${prospects.status} <> 'ARCHIVED'`));
    return "excluded";
  }

  const scoring = brandSignals.map((s) => ({ type: s.signalType as PromptSignal["type"], date: s.signalDate, amountUsd: s.amountUsd }));
  const score = computeScore(scoring, a, today);
  const lastSignalAt = brandSignals.reduce((max, s) => (s.signalDate > max ? s.signalDate : max), "0000-00-00");
  const analysis = {
    readinessScore: score.total,
    scoreBreakdown: score.breakdown,
    scoreRationale: a.score_rationale,
    fundingSummary: a.funding_summary.slice(0, 255),
    recentSignalSummary: buildRecentSignalSummary(scoring, today),
    expansionStage: a.expansion_stage,
    keyHiringRoles: a.key_hiring_roles,
    targetDemographics: a.target_demographics,
    pitchAngle: a.pitch_angle,
    recommendedFormats: a.recommended_formats,
    lastSignalAt: lastSignalAt === "0000-00-00" ? today : lastSignalAt,
    model: backend.name.slice(0, 50),
    analyzedAt: now,
  };

  // Upsert keeps the rep's status fields untouched on re-analysis.
  await db
    .insert(prospects)
    .values({ brandId, ...analysis })
    .onConflictDoUpdate({ target: prospects.brandId, set: analysis });
  await db
    .update(brands)
    .set({ name: a.brand_name.slice(0, 255), category: a.category, description: a.description })
    .where(eq(brands.id, brandId));
  await releaseClaimed(db, brandId, { status: "PROCESSED", processedAt: now, lastError: null });
  return "analyzed";
}

async function handleFailure(db: Db, brandId: string, err: unknown): Promise<Outcome> {
  const lastError = describeError(err);
  if (err instanceof UsageLimitError || err instanceof AuthError) {
    await releaseClaimed(db, brandId, { status: "PENDING", lastError }, true);
    return err instanceof UsageLimitError ? "usage_limit" : "auth_error";
  }
  if (err instanceof NonRetryableError) {
    await releaseClaimed(db, brandId, { status: "FAILED", lastError });
    return "failed";
  }
  const rows = await releaseClaimed(db, brandId, {
    status: sql`CASE WHEN ${signals.attempts} >= ${MAX_ATTEMPTS} THEN 'FAILED' ELSE 'PENDING' END` as unknown as string,
    lastError,
  });
  return rows.some((r) => r.status === "FAILED") ? "failed" : "retried";
}

// SPEC §5.1. The prompt is built from the brand's PROCESSING and PROCESSED signals dated within
// SIGNAL_LOOKBACK_DAYS. raw_payload holds the parsed source record: a FormDFiling for SEC_FORM_D,
// a JobListing for JOB_LISTING (location = "City, ST" from city/state, null when both are missing).
// Writes a pipeline_runs row (job "analyze"):
// SUCCEEDED for drained/max_analyses/deadline, PARTIAL for usage_limit, FAILED for auth_error,
// with stats { analyzed, excluded, failed, retried, carried_over, stop_reason, input_tokens, output_tokens }.
// Per brand:
// - success: update brand name/category/description; upsert prospect keeping status; signals PROCESSED
// - is_consumer_brand false: brand excluded, signals SKIPPED, existing prospect ARCHIVED
// - UsageLimitError / AuthError: signals back to PENDING with the attempt undone; stop the run
// - RetryableError or output failing AnalysisSchema: PENDING (FAILED once attempts reach MAX_ATTEMPTS)
// - NonRetryableError: FAILED immediately
export async function runAnalyze(db: Db, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const now = opts.now ?? (() => new Date());
  const today = opts.today ?? utcDate(now());
  const [run] = await db.insert(pipelineRuns).values({ job: "analyze" }).returning({ id: pipelineRuns.id });

  const counts = { analyzed: 0, excluded: 0, failed: 0, retried: 0 };
  const tokens = { input: 0, output: 0 };
  const tried: string[] = [];
  const errors: { brandId: string; outcome: Outcome }[] = [];
  let started = 0;
  let halt: "usage_limit" | "auth_error" | null = null;
  let hitDeadline = false;
  let hitMax = false;

  try {
    await recoverStaleLocks(db, now());

    const worker = async () => {
      while (!halt) {
        if (now() >= opts.deadline) return void (hitDeadline = true);
        if (started >= opts.maxAnalyses) return void (hitMax = true);
        started++;
        const brandId = await claimNextBrand(db, { now: now(), excludeBrandIds: tried });
        if (!brandId) {
          started--;
          return;
        }
        tried.push(brandId);
        const outcome = await analyzeBrand(db, brandId, opts.backend, today, now(), tokens);
        if (outcome === "usage_limit" || outcome === "auth_error") {
          halt ??= outcome;
          errors.push({ brandId, outcome });
        } else {
          counts[outcome]++;
          if (outcome === "failed" || outcome === "retried") errors.push({ brandId, outcome });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  } catch (err) {
    await db
      .update(pipelineRuns)
      .set({ status: "FAILED", finishedAt: new Date(), errors: [{ error: describeError(err) }] })
      .where(eq(pipelineRuns.id, run.id));
    throw err;
  }

  const pending = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(DISTINCT brand_id)::int AS n FROM signals WHERE status = 'PENDING'`),
  );
  const carriedOver = pending[0]?.n ?? 0;
  const stopReason: StopReason =
    halt ?? (carriedOver > 0 && hitDeadline ? "deadline" : carriedOver > 0 && hitMax ? "max_analyses" : "drained");

  const result: AnalyzeResult = {
    runId: run.id,
    ...counts,
    carriedOver,
    stopReason,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };
  await db
    .update(pipelineRuns)
    .set({
      status: halt === "usage_limit" ? "PARTIAL" : halt === "auth_error" ? "FAILED" : "SUCCEEDED",
      finishedAt: new Date(),
      errors,
      stats: {
        analyzed: counts.analyzed,
        excluded: counts.excluded,
        failed: counts.failed,
        retried: counts.retried,
        carried_over: carriedOver,
        stop_reason: stopReason,
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        backend: opts.backend.name,
      },
    })
    .where(eq(pipelineRuns.id, run.id));
  return result;
}
