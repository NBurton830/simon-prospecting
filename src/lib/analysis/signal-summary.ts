import type { SignalType } from "@/config/taxonomy";
import { daysBetween } from "@/lib/dates";
import { largestRecentRaise } from "./score";

export interface SummarySignal {
  type: SignalType;
  date: string; // YYYY-MM-DD
  amountUsd: number | null;
}

const HIRING_WINDOW_DAYS = 90;

// 8_500_000 → "$8.5M", 10_000_000 → "$10M", 750_000 → "$750K", 1_250_000_000 → "$1.3B", 999 → "$999".
export function formatUsdShort(amount: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (amount >= size) {
      const rounded = Math.round((amount / size) * 10) / 10;
      return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${suffix}`;
    }
  }
  return `$${Math.round(amount)}`;
}

const monthYear = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

// "Raised $8.5M (Sep 2026) + hiring 2 retail roles" (SPEC §5.6):
// - funding part: the largest Form D amount (> 0) dated within 365 days, with that filing's month;
// - hiring part: job listings dated within 90 days;
// - either part alone is capitalized; with neither, "No recent signals". Never names a funding round.
export function buildRecentSignalSummary(signals: SummarySignal[], today: string): string {
  const parts: string[] = [];

  const raise = largestRecentRaise(signals, today);
  if (raise?.amountUsd) parts.push(`raised ${formatUsdShort(raise.amountUsd)} (${monthYear(raise.date)})`);

  const roles = signals.filter((s) => s.type === "JOB_LISTING" && daysBetween(s.date, today) <= HIRING_WINDOW_DAYS).length;
  if (roles > 0) parts.push(`hiring ${roles} retail ${roles === 1 ? "role" : "roles"}`);

  if (parts.length === 0) return "No recent signals";
  const summary = parts.join(" + ");
  return (summary[0].toUpperCase() + summary.slice(1)).slice(0, 255);
}
