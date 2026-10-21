import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AuthError, NonRetryableError, RetryableError, UsageLimitError } from "@/lib/analysis/backend";
import { SYSTEM_PROMPT } from "@/lib/analysis/prompt";
import { pipelineRuns, signals } from "@/lib/db/schema";
import type { FormDFiling } from "@/lib/ingest/sec-edgar";
import type { JobListing } from "@/lib/ingest/jobs-api";
import { claimNextBrand, recoverStaleLocks, runAnalyze, type AnalyzeOptions } from "@/lib/pipeline/analyze";
import { createTestDb, type TestDb } from "../helpers/db";
import { fakeBackend } from "../helpers/fake-backend";
import { brandById, makeBrand, makeProspect, makeSignal, prospectsOf, signalsOf } from "../helpers/factories";
import { realBrandAnalysis, realExcludedAnalysis } from "../helpers/fixtures";

const TODAY = "2026-10-21";
const NOW = new Date("2026-10-21T06:20:00Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => t.reset());
afterAll(async () => t.close());

// raw_payload shapes written by sync (SPEC §4)
const formDPayload = (overrides: Partial<FormDFiling> = {}): FormDFiling => ({
  cik: "9999999",
  issuerName: "Fernwood Skin Co, Inc.",
  hqState: "TX",
  entityType: "Corporation",
  industryGroupType: "Retailing",
  isAmendment: false,
  totalOfferingAmount: 8_500_000,
  totalAmountSold: 6_200_000,
  dateOfFirstSale: "2026-08-30",
  relatedPersons: [{ name: "Jane Doe", relationship: "Executive Officer" }],
  ...overrides,
});
const jobPayload = (overrides: Partial<JobListing> = {}): JobListing => ({
  jobId: "job-1",
  employerName: "Fernwood Skin Co",
  employerWebsite: "https://www.fernwoodskin.com",
  title: "Director of Retail",
  city: "Austin",
  state: "TX",
  applyLink: "https://example.com/jobs/1",
  postedAt: "2026-10-18T14:00:00.000Z",
  description: "Lead site selection and mall pop-up tests ahead of our first stores.",
  ...overrides,
});

async function addFormD(brandId: string, date: string, payload: Partial<FormDFiling> = {}, extra = {}) {
  const p = formDPayload(payload);
  return makeSignal(t.db, brandId, {
    signalType: "SEC_FORM_D",
    signalDate: date,
    amountUsd: Math.max(p.totalOfferingAmount ?? 0, p.totalAmountSold ?? 0),
    title: null,
    rawPayload: p,
    ...extra,
  });
}
async function addJob(brandId: string, date: string, payload: Partial<JobListing> = {}, extra = {}) {
  const p = jobPayload(payload);
  return makeSignal(t.db, brandId, { signalType: "JOB_LISTING", signalDate: date, title: p.title, rawPayload: p, ...extra });
}

// A brand with one pending job listing dated `date` (dates decide claim order: newest first).
async function pendingBrand(name: string, date: string) {
  const b = await makeBrand(t.db, { name, normalizedName: name.toLowerCase() });
  await addJob(b.id, date, { employerName: name, jobId: `${name}-job` });
  return b;
}

const ok = (output: unknown = realBrandAnalysis(), usage = { inputTokens: 100, outputTokens: 50 }) => ({ output, usage });

function options(backend: AnalyzeOptions["backend"], overrides: Partial<AnalyzeOptions> = {}): AnalyzeOptions {
  return { backend, maxAnalyses: 60, concurrency: 1, deadline: FAR_FUTURE, now: () => NOW, today: TODAY, ...overrides };
}

async function lastRun() {
  const [run] = await t.db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);
  return run;
}

describe("claimNextBrand", () => {
  test("returns null when nothing is pending", async () => {
    expect(await claimNextBrand(t.db, { now: NOW })).toBeNull();
  });

  test("claims all pending signals of the brand with the newest pending signal", async () => {
    const older = await pendingBrand("Older", "2026-10-10");
    const newer = await pendingBrand("Newer", "2026-10-19");
    await addFormD(newer.id, "2026-09-01");

    expect(await claimNextBrand(t.db, { now: NOW })).toBe(newer.id);
    for (const s of await signalsOf(t.db, newer.id)) {
      expect(s).toMatchObject({ status: "PROCESSING", attempts: 1 });
      expect(s.lockedAt).toEqual(NOW);
    }
    expect((await signalsOf(t.db, older.id))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  test("leaves the brand's non-pending signals alone", async () => {
    const b = await pendingBrand("Mixed", "2026-10-19");
    await addFormD(b.id, "2026-09-01", {}, { status: "PROCESSED", attempts: 1 });
    await claimNextBrand(t.db, { now: NOW });
    expect((await signalsOf(t.db, b.id)).map((s) => [s.status, s.attempts])).toEqual([
      ["PROCESSED", 1],
      ["PROCESSING", 1],
    ]);
  });

  test("ignores SKIPPED and FAILED signals", async () => {
    const b = await makeBrand(t.db);
    await addJob(b.id, "2026-10-19", {}, { status: "SKIPPED" });
    await addJob(b.id, "2026-10-18", { jobId: "j2" }, { status: "FAILED", externalId: "j2" });
    expect(await claimNextBrand(t.db, { now: NOW })).toBeNull();
  });

  test("successive claims return each brand once", async () => {
    const a = await pendingBrand("A", "2026-10-19");
    const b = await pendingBrand("B", "2026-10-18");
    expect(await claimNextBrand(t.db, { now: NOW })).toBe(a.id);
    expect(await claimNextBrand(t.db, { now: NOW })).toBe(b.id);
    expect(await claimNextBrand(t.db, { now: NOW })).toBeNull();
  });

  test("concurrent claims never return the same brand", async () => {
    await pendingBrand("A", "2026-10-19");
    await pendingBrand("B", "2026-10-18");
    const ids = await Promise.all([1, 2, 3].map(() => claimNextBrand(t.db, { now: NOW })));
    const claimed = ids.filter((id): id is string => id !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed).size).toBe(2);
  });

  test("skips excluded brand ids", async () => {
    const a = await pendingBrand("A", "2026-10-19");
    const b = await pendingBrand("B", "2026-10-18");
    expect(await claimNextBrand(t.db, { now: NOW, excludeBrandIds: [a.id] })).toBe(b.id);
    expect(await claimNextBrand(t.db, { now: NOW, excludeBrandIds: [a.id] })).toBeNull();
  });
});

describe("recoverStaleLocks", () => {
  test("returns PROCESSING signals locked over 30 minutes ago to PENDING", async () => {
    const stale = await makeBrand(t.db);
    const fresh = await makeBrand(t.db);
    await addJob(stale.id, "2026-10-19", {}, { status: "PROCESSING", attempts: 1, lockedAt: new Date("2026-10-21T05:49:00Z") });
    await addJob(fresh.id, "2026-10-19", { jobId: "j2" }, { status: "PROCESSING", attempts: 1, externalId: "j2", lockedAt: new Date("2026-10-21T06:10:00Z") });

    expect(await recoverStaleLocks(t.db, NOW)).toBe(1);
    expect((await signalsOf(t.db, stale.id))[0]).toMatchObject({ status: "PENDING", attempts: 1 });
    expect((await signalsOf(t.db, fresh.id))[0].status).toBe("PROCESSING");
  });
});

describe("runAnalyze — success", () => {
  async function seedFernwood() {
    const b = await makeBrand(t.db, { name: "Fernwood Skin Co, Inc.", normalizedName: "fernwood skin", legalName: "Fernwood Skin Co, Inc.", domain: "fernwoodskin.com", hqState: "TX" });
    await addFormD(b.id, "2026-09-14");
    await addJob(b.id, "2026-10-18");
    return b;
  }

  test("creates the prospect with the code-computed score", async () => {
    const b = await seedFernwood();
    const { backend } = fakeBackend([ok()]);
    const result = await runAnalyze(t.db, options(backend));
    expect(result).toMatchObject({ analyzed: 1, excluded: 0, failed: 0, retried: 0, carriedOver: 0, stopReason: "drained" });

    const [p] = await prospectsOf(t.db, b.id);
    const a = realBrandAnalysis();
    expect(p).toMatchObject({
      readinessScore: 18 + 28 + 14 + 9 + 10, // $8.5M, real capture's scores, signal 3 days old
      scoreBreakdown: { funding: 18, retail_hiring: 28, physical_stage: 14, category_fit: 9, recency: 10 },
      scoreRationale: a.score_rationale,
      fundingSummary: a.funding_summary.slice(0, 255),
      recentSignalSummary: "Raised $8.5M (Sep 2026) + hiring 1 retail role",
      expansionStage: "Testing Pop-ups",
      keyHiringRoles: a.key_hiring_roles,
      targetDemographics: a.target_demographics,
      pitchAngle: a.pitch_angle,
      recommendedFormats: ["Concourse Pop-ups", "Pop-Up Kiosks", "Experiential Activations"],
      status: "NEW",
      lastSignalAt: "2026-10-18",
      model: "fake:test",
    });
  });

  test("updates the brand from the analysis", async () => {
    const b = await seedFernwood();
    await runAnalyze(t.db, options(fakeBackend([ok()]).backend));
    expect(await brandById(t.db, b.id)).toMatchObject({
      name: "Fernwood Skin Co",
      category: "Beauty & Cosmetics",
      description: realBrandAnalysis().description,
      excluded: false,
    });
  });

  test("marks the signals PROCESSED", async () => {
    const b = await seedFernwood();
    await runAnalyze(t.db, options(fakeBackend([ok()]).backend));
    for (const s of await signalsOf(t.db, b.id)) {
      expect(s.status).toBe("PROCESSED");
      expect(s.processedAt).not.toBeNull();
    }
  });

  test("sends the system prompt and a message built from the signals", async () => {
    await seedFernwood();
    const { backend, calls } = fakeBackend([ok()]);
    await runAnalyze(t.db, options(backend));
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt).toBe(SYSTEM_PROMPT);
    const msg = calls[0].userMessage;
    expect(msg).toContain("Legal name: Fernwood Skin Co, Inc.");
    expect(msg).toContain("Total offering: $8,500,000.");
    expect(msg).toContain("Related persons: Jane Doe (Executive Officer)");
    expect(msg).toContain("Title: Director of Retail. Location: Austin, TX.");
    expect(msg).toContain("Today's date: 2026-10-21");
  });

  test("funding comes from the Form D amount, not from Claude", async () => {
    const b = await makeBrand(t.db);
    await addFormD(b.id, "2026-10-01", { totalOfferingAmount: 30_000_000, totalAmountSold: 0 });
    await runAnalyze(t.db, options(fakeBackend([ok()]).backend));
    expect((await prospectsOf(t.db, b.id))[0].scoreBreakdown.funding).toBe(30);
  });

  test("records token usage and a SUCCEEDED run", async () => {
    await pendingBrand("A", "2026-10-19");
    await pendingBrand("B", "2026-10-18");
    const result = await runAnalyze(t.db, options(fakeBackend([ok(undefined, { inputTokens: 100, outputTokens: 50 })]).backend));
    expect(result).toMatchObject({ analyzed: 2, inputTokens: 200, outputTokens: 100 });
    const run = await lastRun();
    expect(run).toMatchObject({ id: result.runId, job: "analyze", status: "SUCCEEDED" });
    expect(run.finishedAt).not.toBeNull();
    expect(run.stats).toMatchObject({ analyzed: 2, stop_reason: "drained", input_tokens: 200, output_tokens: 100 });
  });

  test("picks up brands left stuck by a crashed run", async () => {
    const b = await makeBrand(t.db);
    await addJob(b.id, "2026-10-19", {}, { status: "PROCESSING", attempts: 1, lockedAt: new Date("2026-10-21T04:00:00Z") });
    const result = await runAnalyze(t.db, options(fakeBackend([ok()]).backend));
    expect(result.analyzed).toBe(1);
    expect((await signalsOf(t.db, b.id))[0].status).toBe("PROCESSED");
  });

  test("with concurrency, analyzes every brand exactly once", async () => {
    for (const [i, name] of ["A", "B", "C", "D"].entries()) await pendingBrand(name, `2026-10-1${i}`);
    const { backend, calls } = fakeBackend([ok()]);
    const result = await runAnalyze(t.db, options(backend, { concurrency: 2 }));
    expect(result.analyzed).toBe(4);
    const names = calls.map((c) => /Name: (\S+)/.exec(c.userMessage)![1]);
    expect(names.sort()).toEqual(["A", "B", "C", "D"]);
  });
});

describe("runAnalyze — re-analysis", () => {
  test("updates the one prospect row and keeps the rep's status", async () => {
    const b = await makeBrand(t.db);
    await addJob(b.id, "2026-09-01", { jobId: "old", title: "Head of Retail" }, { status: "PROCESSED", externalId: "old" });
    const statusChangedAt = new Date("2026-09-05T12:00:00Z");
    await makeProspect(t.db, b.id, { status: "CONTACTED", statusChangedAt, statusChangedBy: "rep@company.com", readinessScore: 50 });
    await addJob(b.id, "2026-10-19", { jobId: "new" }, { externalId: "new" });

    const { backend, calls } = fakeBackend([ok()]);
    await runAnalyze(t.db, options(backend));

    const rows = await prospectsOf(t.db, b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "CONTACTED", statusChangedBy: "rep@company.com", lastSignalAt: "2026-10-19" });
    expect(rows[0].statusChangedAt).toEqual(statusChangedAt);
    expect(rows[0].readinessScore).not.toBe(50);
    // earlier processed signals are included as context
    expect(calls[0].userMessage).toContain("Head of Retail");
  });

  test("leaves out signals older than 180 days", async () => {
    const b = await makeBrand(t.db);
    await addJob(b.id, "2026-01-02", { jobId: "ancient", title: "Ancient Role" }, { status: "PROCESSED", externalId: "ancient" });
    await addJob(b.id, "2026-10-19");
    const { backend, calls } = fakeBackend([ok()]);
    await runAnalyze(t.db, options(backend));
    expect(calls[0].userMessage).not.toContain("Ancient Role");
  });
});

describe("runAnalyze — exclusion", () => {
  test("excludes the brand and skips its signals", async () => {
    const b = await pendingBrand("Harbor Ridge", "2026-10-20");
    const result = await runAnalyze(t.db, options(fakeBackend([ok(realExcludedAnalysis())]).backend));
    expect(result).toMatchObject({ analyzed: 0, excluded: 1 });
    expect(await brandById(t.db, b.id)).toMatchObject({ excluded: true, exclusionReason: realExcludedAnalysis().exclusion_reason });
    expect((await signalsOf(t.db, b.id))[0].status).toBe("SKIPPED");
    expect(await prospectsOf(t.db, b.id)).toHaveLength(0);
  });

  test("archives an existing prospect", async () => {
    const b = await pendingBrand("Harbor Ridge", "2026-10-20");
    await makeProspect(t.db, b.id, { status: "REVIEWED" });
    await runAnalyze(t.db, options(fakeBackend([ok(realExcludedAnalysis())]).backend));
    expect((await prospectsOf(t.db, b.id))[0].status).toBe("ARCHIVED");
  });
});

describe("runAnalyze — limits and errors", () => {
  test("usage limit stops the run and carries brands over without counting an attempt", async () => {
    const a = await pendingBrand("A", "2026-10-20");
    const b = await pendingBrand("B", "2026-10-19");
    const c = await pendingBrand("C", "2026-10-18");
    const { backend, calls } = fakeBackend([ok(), new UsageLimitError("Claude AI usage limit reached")]);

    const result = await runAnalyze(t.db, options(backend));
    expect(result).toMatchObject({ analyzed: 1, carriedOver: 2, stopReason: "usage_limit" });
    expect(calls).toHaveLength(2);
    expect((await signalsOf(t.db, a.id))[0].status).toBe("PROCESSED");
    expect((await signalsOf(t.db, b.id))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await signalsOf(t.db, c.id))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await lastRun()).toMatchObject({ status: "PARTIAL", stats: expect.objectContaining({ stop_reason: "usage_limit", carried_over: 2 }) });
  });

  test("auth error stops the run as FAILED without counting an attempt", async () => {
    const a = await pendingBrand("A", "2026-10-20");
    const result = await runAnalyze(t.db, options(fakeBackend([new AuthError("401 OAuth access token is invalid")]).backend));
    expect(result).toMatchObject({ analyzed: 0, stopReason: "auth_error", carriedOver: 1 });
    expect((await signalsOf(t.db, a.id))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await lastRun()).status).toBe("FAILED");
  });

  test("retryable error: back to PENDING with the attempt counted, not retried in the same run", async () => {
    const a = await pendingBrand("A", "2026-10-20");
    const b = await pendingBrand("B", "2026-10-19");
    const { backend, calls } = fakeBackend([new RetryableError("API Error: 500"), ok()]);

    const result = await runAnalyze(t.db, options(backend));
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ analyzed: 1, retried: 1, carriedOver: 1, stopReason: "drained" });
    const [s] = await signalsOf(t.db, a.id);
    expect(s).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(s.lastError).toContain("500");
    expect((await signalsOf(t.db, b.id))[0].status).toBe("PROCESSED");
  });

  test("third failed attempt → FAILED", async () => {
    const a = await makeBrand(t.db);
    await addJob(a.id, "2026-10-20", {}, { attempts: 2 });
    const result = await runAnalyze(t.db, options(fakeBackend([new RetryableError("timeout")]).backend));
    expect(result).toMatchObject({ failed: 1, retried: 0 });
    expect((await signalsOf(t.db, a.id))[0]).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  test("output that fails the schema is retried like any transient error", async () => {
    const a = await pendingBrand("A", "2026-10-20");
    const bad = { ...realBrandAnalysis(), category: "Clean Skincare / Beauty" };
    const result = await runAnalyze(t.db, options(fakeBackend([ok(bad)]).backend));
    expect(result).toMatchObject({ analyzed: 0, retried: 1 });
    const [s] = await signalsOf(t.db, a.id);
    expect(s).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(s.lastError).toMatch(/category/);
    expect(await prospectsOf(t.db, a.id)).toHaveLength(0);
  });

  test("non-retryable error → FAILED immediately, and the run continues", async () => {
    const a = await pendingBrand("A", "2026-10-20");
    const b = await pendingBrand("B", "2026-10-19");
    const result = await runAnalyze(t.db, options(fakeBackend([new NonRetryableError("refusal"), ok()]).backend));
    expect(result).toMatchObject({ failed: 1, analyzed: 1 });
    expect((await signalsOf(t.db, a.id))[0]).toMatchObject({ status: "FAILED", attempts: 1, lastError: expect.stringContaining("refusal") });
    expect((await signalsOf(t.db, b.id))[0].status).toBe("PROCESSED");
  });

  test("stops at maxAnalyses", async () => {
    for (const [i, name] of ["A", "B", "C"].entries()) await pendingBrand(name, `2026-10-1${i}`);
    const { backend, calls } = fakeBackend([ok()]);
    const result = await runAnalyze(t.db, options(backend, { maxAnalyses: 2 }));
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ analyzed: 2, carriedOver: 1, stopReason: "max_analyses" });
  });

  test("starts nothing after the deadline", async () => {
    const a = await pendingBrand("A", "2026-10-20");
    const { backend, calls } = fakeBackend([ok()]);
    const result = await runAnalyze(t.db, options(backend, { deadline: new Date("2026-10-21T06:00:00Z") }));
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ analyzed: 0, carriedOver: 1, stopReason: "deadline" });
    expect((await signalsOf(t.db, a.id))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  test("no signal is left PROCESSING after any run", async () => {
    await pendingBrand("A", "2026-10-20");
    await pendingBrand("B", "2026-10-19");
    await pendingBrand("C", "2026-10-18");
    await runAnalyze(t.db, options(fakeBackend([ok(), new RetryableError("x"), new UsageLimitError("limit")]).backend));
    const stuck = await t.db.select().from(signals).where(eq(signals.status, "PROCESSING"));
    expect(stuck).toHaveLength(0);
  });
});
