import { describe, expect, test } from "vitest";
import { categoriesIn, DEFAULT_FILTERS, filterProspects, sortProspects } from "@/lib/dashboard/filter";
import { describeAnalyzeRun, describeSyncRun, formatDate, formatDateTimeUtc, formatUsd, scoreTone } from "@/lib/dashboard/format";
import type { ProspectRow, RunSummary } from "@/lib/dashboard/queries";

let n = 0;
function row(overrides: Partial<ProspectRow> = {}): ProspectRow {
  n++;
  return {
    id: `p${n}`,
    brandId: `b${n}`,
    brandName: `Brand ${n}`,
    domain: null,
    category: "Apparel",
    description: "Sells jackets.",
    hqState: "TX",
    keyPeople: [],
    readinessScore: 70,
    scoreBreakdown: { funding: 12, retail_hiring: 20, physical_stage: 10, category_fit: 8, recency: 10 },
    scoreRationale: "",
    fundingSummary: "",
    recentSignalSummary: "",
    expansionStage: "Unknown",
    keyHiringRoles: [],
    targetDemographics: "",
    pitchAngle: "Pop-ups help.",
    recommendedFormats: ["Digital Directories"],
    status: "NEW",
    statusChangedAt: "2026-10-01T00:00:00.000Z",
    lastSignalAt: "2026-10-15",
    hasNewActivity: false,
    ...overrides,
  };
}

describe("filterProspects", () => {
  test("default filters hide archived prospects only", () => {
    const rows = [row({ status: "NEW" }), row({ status: "REVIEWED" }), row({ status: "CONTACTED" }), row({ status: "ARCHIVED" })];
    expect(filterProspects(rows, DEFAULT_FILTERS).map((p) => p.status)).toEqual(["NEW", "REVIEWED", "CONTACTED"]);
  });

  test("an empty status list shows every status", () => {
    const rows = [row({ status: "ARCHIVED" })];
    expect(filterProspects(rows, { ...DEFAULT_FILTERS, statuses: [] })).toHaveLength(1);
  });

  test("minimum score is inclusive", () => {
    const rows = [row({ readinessScore: 59 }), row({ readinessScore: 60 })];
    expect(filterProspects(rows, { ...DEFAULT_FILTERS, minScore: 60 }).map((p) => p.readinessScore)).toEqual([60]);
  });

  test("categories", () => {
    const rows = [row({ category: "Apparel" }), row({ category: "Pets" }), row({ category: null })];
    expect(filterProspects(rows, { ...DEFAULT_FILTERS, categories: ["Pets"] }).map((p) => p.category)).toEqual(["Pets"]);
    expect(filterProspects(rows, DEFAULT_FILTERS)).toHaveLength(3);
  });

  test("new activity only", () => {
    const rows = [row({ hasNewActivity: true }), row()];
    expect(filterProspects(rows, { ...DEFAULT_FILTERS, newOnly: true })).toHaveLength(1);
  });

  test("search matches every word across name, description, roles and pitch, case-insensitively", () => {
    const rows = [
      row({ brandName: "Fernwood Skin Co", keyHiringRoles: ["Director of Retail"] }),
      row({ brandName: "Lumen Candle", pitchAngle: "Kiosks in Denver malls" }),
    ];
    const search = (s: string) => filterProspects(rows, { ...DEFAULT_FILTERS, search: s }).map((p) => p.brandName);
    expect(search("fernwood")).toEqual(["Fernwood Skin Co"]);
    expect(search("DIRECTOR retail")).toEqual(["Fernwood Skin Co"]);
    expect(search("denver kiosks")).toEqual(["Lumen Candle"]);
    expect(search("fernwood denver")).toEqual([]);
    expect(search("   ")).toHaveLength(2);
  });
});

describe("sortProspects", () => {
  const rows = [
    row({ brandName: "beta", readinessScore: 70, lastSignalAt: "2026-10-01" }),
    row({ brandName: "Alpha", readinessScore: 90, lastSignalAt: "2026-09-01" }),
    row({ brandName: "Gamma", readinessScore: 70, lastSignalAt: "2026-10-10" }),
  ];

  test("by score, ties broken by name", () => {
    expect(sortProspects(rows, "score", "desc").map((p) => p.brandName)).toEqual(["Alpha", "Gamma", "beta"]);
  });

  test("by last signal", () => {
    expect(sortProspects(rows, "lastSignal", "desc").map((p) => p.brandName)).toEqual(["Gamma", "beta", "Alpha"]);
  });

  test("by name, case-insensitive", () => {
    expect(sortProspects(rows, "name", "asc").map((p) => p.brandName)).toEqual(["Alpha", "beta", "Gamma"]);
  });

  test("doesn't mutate the input", () => {
    const before = rows.map((p) => p.id);
    sortProspects(rows, "name", "asc");
    expect(rows.map((p) => p.id)).toEqual(before);
  });
});

test("categoriesIn lists distinct categories, sorted", () => {
  expect(categoriesIn([row({ category: "Pets" }), row({ category: "Apparel" }), row({ category: "Pets" }), row({ category: null })])).toEqual([
    "Apparel",
    "Pets",
  ]);
});

describe("scoreTone", () => {
  test.each([
    [100, "high"],
    [80, "high"],
    [79, "mid"],
    [60, "mid"],
    [59, "low"],
    [1, "low"],
  ])("%s → %s", (score, tone) => {
    expect(scoreTone(score)).toBe(tone);
  });
});

describe("describeAnalyzeRun", () => {
  const run = (status: string, stats: Record<string, unknown>): RunSummary => ({ status, startedAt: "2026-10-21T06:20:00Z", finishedAt: null, stats });

  test.each([
    [null, "Analysis hasn't run yet"],
    [run("RUNNING", {}), "Analysis is running"],
    [run("SUCCEEDED", { analyzed: 12, stop_reason: "drained" }), "Analyzed 12 brands"],
    [run("SUCCEEDED", { analyzed: 1, stop_reason: "drained" }), "Analyzed 1 brand"],
    [run("PARTIAL", { analyzed: 3, carried_over: 14, stop_reason: "usage_limit" }), "Stopped early: Claude usage limit, 14 brands carried over"],
    [run("SUCCEEDED", { analyzed: 60, carried_over: 5, stop_reason: "max_analyses" }), "Analyzed 60 brands (per-run cap), 5 brands carried over"],
    [run("SUCCEEDED", { analyzed: 40, carried_over: 2, stop_reason: "deadline" }), "Analyzed 40 brands before the time limit, 2 brands carried over"],
    [run("FAILED", {}), "Analysis failed"],
  ])("%j → %s", (r, text) => {
    expect(describeAnalyzeRun(r)).toBe(text);
  });

  test("auth failure tells the user how to fix it", () => {
    expect(describeAnalyzeRun(run("FAILED", { stop_reason: "auth_error" }))).toContain("claude setup-token");
  });
});

describe("describeSyncRun", () => {
  const run = (status: string, stats: Record<string, unknown>): RunSummary => ({ status, startedAt: "2026-10-21T06:17:00Z", finishedAt: null, stats });

  test.each([
    [null, "Sync hasn't run yet"],
    [run("SUCCEEDED", { sec: { inserted: 46 }, jobs: { status: "skipped" } }), "Synced: 46 filings, jobs skipped"],
    [run("PARTIAL", { sec: { inserted: 1 }, jobs: { status: "failed", inserted: 0 } }), "Sync partly failed: 1 filing, 0 job listings"],
    [run("FAILED", { sec: { inserted: 0 }, jobs: { status: "failed", inserted: 0 } }), "Sync failed: 0 filings, 0 job listings"],
  ])("%j → %s", (r, text) => {
    expect(describeSyncRun(r)).toBe(text);
  });
});

test("formatting", () => {
  expect(formatDateTimeUtc("2026-10-21T06:17:00.000Z")).toBe("Oct 21, 06:17 UTC");
  expect(formatDate("2026-10-18")).toBe("Oct 18, 2026");
  expect(formatUsd(8_500_000)).toBe("$8,500,000");
  expect(formatUsd(null)).toBe("Unknown");
});
