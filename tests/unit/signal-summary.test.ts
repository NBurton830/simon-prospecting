import { describe, expect, test } from "vitest";
import { buildRecentSignalSummary, formatUsdShort, type SummarySignal } from "@/lib/analysis/signal-summary";

const TODAY = "2026-10-21";
const formD = (date: string, amountUsd: number): SummarySignal => ({ type: "SEC_FORM_D", date, amountUsd });
const job = (date: string): SummarySignal => ({ type: "JOB_LISTING", date, amountUsd: null });

describe("formatUsdShort", () => {
  test.each([
    [8_500_000, "$8.5M"],
    [10_000_000, "$10M"],
    [20_824_987, "$20.8M"],
    [3_000_000, "$3M"],
    [750_000, "$750K"],
    [45_000, "$45K"],
    [1_250_000_000, "$1.3B"],
    [999, "$999"],
  ])("%s → %s", (n, s) => {
    expect(formatUsdShort(n)).toBe(s);
  });
});

describe("buildRecentSignalSummary", () => {
  test("funding and hiring", () => {
    const s = [formD("2026-09-14", 8_500_000), job("2026-10-18"), job("2026-10-01")];
    expect(buildRecentSignalSummary(s, TODAY)).toBe("Raised $8.5M (Sep 2026) + hiring 2 retail roles");
  });

  test("singular role", () => {
    expect(buildRecentSignalSummary([formD("2026-09-14", 8_500_000), job("2026-10-18")], TODAY)).toBe(
      "Raised $8.5M (Sep 2026) + hiring 1 retail role",
    );
  });

  test("hiring only is capitalized", () => {
    expect(buildRecentSignalSummary([job("2026-10-18"), job("2026-10-10")], TODAY)).toBe("Hiring 2 retail roles");
  });

  test("funding only", () => {
    expect(buildRecentSignalSummary([formD("2026-02-17", 20_824_987)], TODAY)).toBe("Raised $20.8M (Feb 2026)");
  });

  test("uses the largest raise within 12 months and that filing's month", () => {
    const s = [formD("2026-03-02", 3_000_000), formD("2026-07-29", 12_000_000), formD("2025-09-01", 40_000_000)];
    expect(buildRecentSignalSummary(s, TODAY)).toBe("Raised $12M (Jul 2026)");
  });

  test("ignores jobs older than 90 days and $0 filings", () => {
    expect(buildRecentSignalSummary([job("2026-07-01"), formD("2026-10-01", 0)], TODAY)).toBe("No recent signals");
  });

  test("no signals", () => {
    expect(buildRecentSignalSummary([], TODAY)).toBe("No recent signals");
  });

  test("never names a funding round and fits the column", () => {
    const s = [formD("2026-09-14", 8_500_000), ...Array.from({ length: 40 }, () => job("2026-10-18"))];
    const out = buildRecentSignalSummary(s, TODAY);
    expect(out).not.toMatch(/series|seed|round/i);
    expect(out.length).toBeLessThanOrEqual(255);
  });
});
