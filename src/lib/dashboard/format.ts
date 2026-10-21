import type { RunSummary } from "./queries";

export type ScoreTone = "high" | "mid" | "low";

// Badge colors (SPEC §7.2): 80+ green, 60–79 yellow, under 60 gray.
export function scoreTone(score: number): ScoreTone {
  if (score >= 80) return "high";
  if (score >= 60) return "mid";
  return "low";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One line for the dashboard's pipeline status (SPEC §7.1).
export function describeAnalyzeRun(run: RunSummary | null): string {
  if (!run) return "Analysis hasn't run yet";
  if (run.status === "RUNNING") return "Analysis is running";
  const s = run.stats as { analyzed?: number; carried_over?: number; stop_reason?: string };
  const analyzed = plural(s.analyzed ?? 0, "brand");
  const carried = s.carried_over ? `, ${plural(s.carried_over, "brand")} carried over` : "";
  switch (s.stop_reason) {
    case "usage_limit":
      return `Stopped early: Claude usage limit${carried}`;
    case "auth_error":
      return "Failed: Claude sign-in expired or invalid (run `claude setup-token` and update the secret)";
    case "max_analyses":
      return `Analyzed ${analyzed} (per-run cap)${carried}`;
    case "deadline":
      return `Analyzed ${analyzed} before the time limit${carried}`;
    default:
      return run.status === "FAILED" ? "Analysis failed" : `Analyzed ${analyzed}`;
  }
}

export function describeSyncRun(run: RunSummary | null): string {
  if (!run) return "Sync hasn't run yet";
  const s = run.stats as { sec?: { inserted?: number }; jobs?: { inserted?: number; status?: string } };
  const filings = plural(s.sec?.inserted ?? 0, "filing");
  const jobs = s.jobs?.status === "skipped" ? "jobs skipped" : plural(s.jobs?.inserted ?? 0, "job listing");
  const prefix = run.status === "FAILED" ? "Sync failed" : run.status === "PARTIAL" ? "Sync partly failed" : "Synced";
  return `${prefix}: ${filings}, ${jobs}`;
}

// "Oct 21, 06:17 UTC"
export function formatDateTimeUtc(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

// "2026-10-18" → "Oct 18, 2026"
export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatUsd(amount: number | null): string {
  return amount === null ? "Unknown" : `$${amount.toLocaleString("en-US")}`;
}

export const STATUS_LABELS = {
  NEW: "New",
  REVIEWED: "Reviewed",
  CONTACTED: "Contacted",
  ARCHIVED: "Archived",
} as const;
