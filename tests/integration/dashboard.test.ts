import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { pipelineRuns } from "@/lib/db/schema";
import { loadDashboard, loadProspectSignals, setProspectStatus } from "@/lib/dashboard/queries";
import { createTestDb, type TestDb } from "../helpers/db";
import { makeBrand, makeProspect, makeSignal, prospectsOf } from "../helpers/factories";

const NOW = new Date("2026-10-21T12:00:00Z");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => t.reset());
afterAll(async () => t.close());

async function prospect(score: number, overrides: { category?: string; status?: string; lastSignalAt?: string; statusChangedAt?: Date } = {}) {
  const b = await makeBrand(t.db, { category: overrides.category ?? "Apparel" });
  return makeProspect(t.db, b.id, {
    readinessScore: score,
    status: overrides.status ?? "NEW",
    lastSignalAt: overrides.lastSignalAt ?? "2026-10-15",
    statusChangedAt: overrides.statusChangedAt ?? new Date("2026-10-16T00:00:00Z"),
  });
}

describe("loadDashboard — prospects", () => {
  test("sorted by score, with brand fields", async () => {
    const b = await makeBrand(t.db, { name: "Fernwood Skin Co", domain: "fernwoodskin.com", category: "Beauty & Cosmetics" });
    await makeProspect(t.db, b.id, { readinessScore: 79, pitchAngle: "pitch" });
    await prospect(91);
    await prospect(40);

    const { prospects } = await loadDashboard(t.db, NOW);
    expect(prospects.map((p) => p.readinessScore)).toEqual([91, 79, 40]);
    expect(prospects[1]).toMatchObject({
      brandName: "Fernwood Skin Co",
      domain: "fernwoodskin.com",
      category: "Beauty & Cosmetics",
      pitchAngle: "pitch",
      status: "NEW",
    });
  });

  test("includes archived prospects (the table hides them by default)", async () => {
    await prospect(50, { status: "ARCHIVED" });
    expect((await loadDashboard(t.db, NOW)).prospects).toHaveLength(1);
  });

  test("respects the row limit", async () => {
    for (const s of [10, 20, 30]) await prospect(s);
    expect((await loadDashboard(t.db, NOW, 2)).prospects.map((p) => p.readinessScore)).toEqual([30, 20]);
  });

  test("new activity = a signal after the last status change", async () => {
    await prospect(60, { lastSignalAt: "2026-10-20", statusChangedAt: new Date("2026-10-10T09:00:00Z") });
    await prospect(50, { lastSignalAt: "2026-10-10", statusChangedAt: new Date("2026-10-10T09:00:00Z") });
    const { prospects } = await loadDashboard(t.db, NOW);
    expect(prospects.map((p) => p.hasNewActivity)).toEqual([true, false]);
  });
});

describe("loadDashboard — metrics", () => {
  test("high intent counts score ≥ 80, excluding archived", async () => {
    await prospect(80);
    await prospect(95);
    await prospect(79);
    await prospect(99, { status: "ARCHIVED" });
    expect((await loadDashboard(t.db, NOW)).metrics.highIntent).toBe(2);
  });

  test("average score excludes archived and is rounded", async () => {
    await prospect(80);
    await prospect(71);
    await prospect(1, { status: "ARCHIVED" });
    expect((await loadDashboard(t.db, NOW)).metrics.avgScore).toBe(76);
  });

  test("empty database", async () => {
    expect((await loadDashboard(t.db, NOW)).metrics).toEqual({ highIntent: 0, signals7d: 0, topCategory: null, avgScore: null });
  });

  test("signals in the last 7 days, excluding SKIPPED", async () => {
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id, { detectedAt: new Date("2026-10-20T00:00:00Z") });
    await makeSignal(t.db, b.id, { detectedAt: new Date("2026-10-15T00:00:00Z"), status: "PROCESSED" });
    await makeSignal(t.db, b.id, { detectedAt: new Date("2026-10-13T00:00:00Z") }); // 8+ days
    await makeSignal(t.db, b.id, { detectedAt: new Date("2026-10-20T00:00:00Z"), status: "SKIPPED" });
    expect((await loadDashboard(t.db, NOW)).metrics.signals7d).toBe(2);
  });

  test("top category: most prospects with a signal in the last 30 days", async () => {
    await prospect(50, { category: "Footwear", lastSignalAt: "2026-10-01" });
    await prospect(50, { category: "Footwear", lastSignalAt: "2026-10-02" });
    await prospect(50, { category: "Apparel", lastSignalAt: "2026-10-03" });
    for (let i = 0; i < 3; i++) await prospect(50, { category: "Pets", lastSignalAt: "2026-08-01" }); // too old
    await prospect(50, { category: "Pets", lastSignalAt: "2026-10-05", status: "ARCHIVED" });
    expect((await loadDashboard(t.db, NOW)).metrics.topCategory).toBe("Footwear");
  });
});

describe("loadDashboard — pipeline status", () => {
  test("latest sync and analyze runs and the FAILED count", async () => {
    await t.db.insert(pipelineRuns).values([
      { job: "sync", status: "SUCCEEDED", startedAt: new Date("2026-10-20T06:17:00Z") },
      { job: "sync", status: "PARTIAL", startedAt: new Date("2026-10-21T06:17:00Z") },
      { job: "analyze", status: "PARTIAL", startedAt: new Date("2026-10-21T06:20:00Z"), stats: { stop_reason: "usage_limit", carried_over: 14 } },
    ]);
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id, { status: "FAILED" });

    const { pipeline } = await loadDashboard(t.db, NOW);
    expect(pipeline.lastSync).toMatchObject({ status: "PARTIAL", startedAt: "2026-10-21T06:17:00.000Z" });
    expect(pipeline.lastAnalyze).toMatchObject({ status: "PARTIAL", stats: { stop_reason: "usage_limit", carried_over: 14 } });
    expect(pipeline.failedSignals).toBe(1);
  });

  test("no runs yet", async () => {
    const { pipeline } = await loadDashboard(t.db, NOW);
    expect(pipeline).toEqual({ lastSync: null, lastAnalyze: null, failedSignals: 0 });
  });
});

describe("loadProspectSignals", () => {
  test("the prospect's processed signals, newest first, with source details", async () => {
    const b = await makeBrand(t.db);
    const p = await makeProspect(t.db, b.id);
    await makeSignal(t.db, b.id, {
      signalType: "SEC_FORM_D",
      status: "PROCESSED",
      signalDate: "2026-09-14",
      amountUsd: 8_500_000,
      title: null,
      rawPayload: { industryGroupType: "Retailing", totalOfferingAmount: 8_500_000, totalAmountSold: 6_200_000, dateOfFirstSale: "2026-08-30" },
    });
    await makeSignal(t.db, b.id, {
      status: "PROCESSED",
      signalDate: "2026-10-18",
      title: "Director of Retail",
      sourceUrl: "https://example.com/jobs/1",
      rawPayload: { city: "Austin", state: "TX", description: "Lead mall pop-ups." },
    });
    await makeSignal(t.db, b.id, { status: "PENDING", signalDate: "2026-10-20" }); // not analyzed yet
    const other = await makeBrand(t.db);
    await makeSignal(t.db, other.id, { status: "PROCESSED" });

    const details = await loadProspectSignals(t.db, p.id);
    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({
      type: "JOB_LISTING",
      date: "2026-10-18",
      url: "https://example.com/jobs/1",
      title: "Director of Retail",
      location: "Austin, TX",
      description: "Lead mall pop-ups.",
      offering: null,
    });
    expect(details[1]).toMatchObject({
      type: "SEC_FORM_D",
      amountUsd: 8_500_000,
      offering: { total: 8_500_000, sold: 6_200_000, firstSale: "2026-08-30", industryGroup: "Retailing" },
    });
  });

  test("unknown prospect → []", async () => {
    expect(await loadProspectSignals(t.db, "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("setProspectStatus", () => {
  test("records the status, time and rep", async () => {
    const b = await makeBrand(t.db);
    const p = await makeProspect(t.db, b.id);
    const result = await setProspectStatus(t.db, p.id, "CONTACTED", "rep@company.com", NOW);
    expect(result).toEqual({ id: p.id, status: "CONTACTED", statusChangedAt: NOW.toISOString() });
    expect((await prospectsOf(t.db, b.id))[0]).toMatchObject({ status: "CONTACTED", statusChangedBy: "rep@company.com" });
  });

  test("unknown prospect → null", async () => {
    expect(await setProspectStatus(t.db, "00000000-0000-0000-0000-000000000000", "REVIEWED", "rep@company.com")).toBeNull();
  });

  test("the database rejects an invalid status", async () => {
    const b = await makeBrand(t.db);
    const p = await makeProspect(t.db, b.id);
    await expect(setProspectStatus(t.db, p.id, "WON" as never, "rep@company.com")).rejects.toThrow();
    expect((await prospectsOf(t.db, b.id))[0].status).toBe("NEW");
  });
});
