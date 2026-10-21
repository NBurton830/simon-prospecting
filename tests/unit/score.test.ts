import { describe, expect, test } from "vitest";
import { computeScore, fundingPoints, recencyPoints, type ScoringSignal } from "@/lib/analysis/score";

const TODAY = "2026-10-21";
const claude = { retail_hiring_score: 28, physical_stage_score: 14, category_fit_score: 9 }; // real capture's scores

describe("fundingPoints", () => {
  test.each([
    [null, 0],
    [0, 0],
    [1_999_999, 0],
    [2_000_000, 12],
    [4_999_999, 12],
    [5_000_000, 18],
    [9_999_999, 18],
    [10_000_000, 24],
    [24_999_999, 24],
    [25_000_000, 30],
    [500_000_000, 30],
  ])("$%s → %s", (amount, points) => {
    expect(fundingPoints(amount)).toBe(points);
  });
});

describe("recencyPoints", () => {
  test.each([
    ["2026-10-21", 10], // today
    ["2026-10-07", 10], // 14 days
    ["2026-10-06", 6], // 15 days
    ["2026-09-06", 6], // 45 days
    ["2026-09-05", 3], // 46 days
    ["2026-07-23", 3], // 90 days
    ["2026-07-22", 0], // 91 days
    ["2026-10-25", 10], // future-dated counts as today
  ])("%s → %s", (date, points) => {
    expect(recencyPoints(date, TODAY)).toBe(points);
  });
});

describe("computeScore", () => {
  test("adds code-scored funding and recency to Claude's three components", () => {
    const signals: ScoringSignal[] = [
      { type: "SEC_FORM_D", date: "2026-09-14", amountUsd: 8_500_000 },
      { type: "JOB_LISTING", date: "2026-10-18", amountUsd: null },
    ];
    expect(computeScore(signals, claude, TODAY)).toEqual({
      total: 18 + 28 + 14 + 9 + 10,
      breakdown: { funding: 18, retail_hiring: 28, physical_stage: 14, category_fit: 9, recency: 10 },
    });
  });

  test("funding uses the largest Form D within 12 months", () => {
    const signals: ScoringSignal[] = [
      { type: "SEC_FORM_D", date: "2026-03-01", amountUsd: 3_000_000 },
      { type: "SEC_FORM_D", date: "2026-08-01", amountUsd: 12_000_000 },
      { type: "SEC_FORM_D", date: "2025-09-01", amountUsd: 40_000_000 }, // older than 365 days
    ];
    expect(computeScore(signals, claude, TODAY).breakdown.funding).toBe(24);
  });

  test("job listings never count toward funding", () => {
    const signals: ScoringSignal[] = [{ type: "JOB_LISTING", date: "2026-10-18", amountUsd: 30_000_000 }];
    expect(computeScore(signals, claude, TODAY).breakdown.funding).toBe(0);
  });

  test("recency uses the newest signal of any type", () => {
    const signals: ScoringSignal[] = [
      { type: "SEC_FORM_D", date: "2026-05-01", amountUsd: 5_000_000 },
      { type: "JOB_LISTING", date: "2026-09-20", amountUsd: null }, // 31 days
    ];
    expect(computeScore(signals, claude, TODAY).breakdown.recency).toBe(6);
  });

  test("no signals → funding and recency 0", () => {
    const r = computeScore([], claude, TODAY);
    expect(r.breakdown.funding).toBe(0);
    expect(r.breakdown.recency).toBe(0);
    expect(r.total).toBe(51);
  });

  test("total is clamped to 1..100", () => {
    const zero = { retail_hiring_score: 0, physical_stage_score: 0, category_fit_score: 0 };
    expect(computeScore([], zero, TODAY).total).toBe(1);
    const max = { retail_hiring_score: 30, physical_stage_score: 20, category_fit_score: 10 };
    const signals: ScoringSignal[] = [{ type: "SEC_FORM_D", date: TODAY, amountUsd: 50_000_000 }];
    expect(computeScore(signals, max, TODAY).total).toBe(100);
  });
});
