import type { SignalType } from "@/config/taxonomy";
import type { ScoreBreakdown } from "@/lib/db/schema";
import { daysBetween } from "@/lib/dates";

export interface ScoringSignal {
  type: SignalType;
  date: string; // YYYY-MM-DD
  amountUsd: number | null;
}

export interface ClaudeScores {
  retail_hiring_score: number;
  physical_stage_score: number;
  category_fit_score: number;
}

const FUNDING_WINDOW_DAYS = 365;

// ≥$25M → 30, ≥$10M → 24, ≥$5M → 18, ≥$2M → 12, otherwise 0.
export function fundingPoints(amountUsd: number | null): number {
  const a = amountUsd ?? 0;
  if (a >= 25_000_000) return 30;
  if (a >= 10_000_000) return 24;
  if (a >= 5_000_000) return 18;
  if (a >= 2_000_000) return 12;
  return 0;
}

// Whole days from lastSignalDate to today: ≤14 → 10, ≤45 → 6, ≤90 → 3, otherwise 0. Future dates count as 0 days.
export function recencyPoints(lastSignalDate: string, today: string): number {
  const age = Math.max(0, daysBetween(lastSignalDate, today));
  if (age <= 14) return 10;
  if (age <= 45) return 6;
  if (age <= 90) return 3;
  return 0;
}

// Largest Form D amount dated within the funding window, or null.
export function largestRecentRaise<T extends ScoringSignal>(signals: T[], today: string): T | null {
  let best: T | null = null;
  for (const s of signals) {
    if (s.type !== "SEC_FORM_D" || !s.amountUsd || daysBetween(s.date, today) > FUNDING_WINDOW_DAYS) continue;
    if (!best || s.amountUsd > (best.amountUsd ?? 0)) best = s;
  }
  return best;
}

// funding: largest Form D amount dated within 365 days of today. recency: newest signal of any type.
// total = clamp(sum of all five components, 1, 100).
export function computeScore(
  signals: ScoringSignal[],
  claude: ClaudeScores,
  today: string,
): { total: number; breakdown: ScoreBreakdown } {
  const newest = signals.reduce<string | null>((max, s) => (max === null || s.date > max ? s.date : max), null);
  const breakdown: ScoreBreakdown = {
    funding: fundingPoints(largestRecentRaise(signals, today)?.amountUsd ?? null),
    retail_hiring: claude.retail_hiring_score,
    physical_stage: claude.physical_stage_score,
    category_fit: claude.category_fit_score,
    recency: newest === null ? 0 : recencyPoints(newest, today),
  };
  const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total: Math.min(100, Math.max(1, Math.round(sum))), breakdown };
}
