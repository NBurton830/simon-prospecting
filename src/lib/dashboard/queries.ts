import { and, desc, eq, sql } from "drizzle-orm";
import type { ProspectStatus } from "@/config/taxonomy";
import type { Db } from "@/lib/db";
import { brands, pipelineRuns, prospects, signals, type KeyPerson, type ScoreBreakdown } from "@/lib/db/schema";
import { addDays } from "@/lib/dates";

export const HIGH_INTENT_SCORE = 80;
const TOP_CATEGORY_WINDOW_DAYS = 30;
const SIGNALS_WINDOW_DAYS = 7;

export interface ProspectRow {
  id: string;
  brandId: string;
  brandName: string;
  domain: string | null;
  category: string | null;
  description: string | null;
  hqState: string | null;
  keyPeople: KeyPerson[];
  readinessScore: number;
  scoreBreakdown: ScoreBreakdown;
  scoreRationale: string;
  fundingSummary: string;
  recentSignalSummary: string;
  expansionStage: string;
  keyHiringRoles: string[];
  targetDemographics: string;
  pitchAngle: string;
  recommendedFormats: string[];
  status: ProspectStatus;
  statusChangedAt: string; // ISO
  lastSignalAt: string; // YYYY-MM-DD
  hasNewActivity: boolean;
}

export interface DashboardMetrics {
  highIntent: number; // score ≥ HIGH_INTENT_SCORE, not archived
  signals7d: number; // detected in the last 7 days, excluding SKIPPED
  topCategory: string | null; // most prospects with a signal in the last 30 days
  avgScore: number | null; // non-archived, rounded
}

export interface RunSummary {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
}

export interface PipelineStatus {
  lastSync: RunSummary | null;
  lastAnalyze: RunSummary | null;
  failedSignals: number;
}

export interface DashboardData {
  prospects: ProspectRow[];
  metrics: DashboardMetrics;
  pipeline: PipelineStatus;
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

async function lastRun(db: Db, job: "sync" | "analyze"): Promise<RunSummary | null> {
  const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.job, job)).orderBy(desc(pipelineRuns.startedAt)).limit(1);
  return run ? { status: run.status, startedAt: iso(run.startedAt)!, finishedAt: iso(run.finishedAt), stats: run.stats } : null;
}

export async function loadDashboard(db: Db, now: Date, limit = 500): Promise<DashboardData> {
  const today = now.toISOString().slice(0, 10);

  const rows = await db
    .select({ p: prospects, b: brands })
    .from(prospects)
    .innerJoin(brands, eq(brands.id, prospects.brandId))
    .orderBy(desc(prospects.readinessScore), desc(prospects.lastSignalAt))
    .limit(limit);

  const prospectRows: ProspectRow[] = rows.map(({ p, b }) => ({
    id: p.id,
    brandId: b.id,
    brandName: b.name,
    domain: b.domain,
    category: b.category,
    description: b.description,
    hqState: b.hqState,
    keyPeople: b.keyPeople,
    readinessScore: p.readinessScore,
    scoreBreakdown: p.scoreBreakdown,
    scoreRationale: p.scoreRationale,
    fundingSummary: p.fundingSummary,
    recentSignalSummary: p.recentSignalSummary,
    expansionStage: p.expansionStage,
    keyHiringRoles: p.keyHiringRoles,
    targetDemographics: p.targetDemographics,
    pitchAngle: p.pitchAngle,
    recommendedFormats: p.recommendedFormats,
    status: p.status as ProspectStatus,
    statusChangedAt: iso(p.statusChangedAt)!,
    lastSignalAt: p.lastSignalAt,
    hasNewActivity: p.lastSignalAt > iso(p.statusChangedAt)!.slice(0, 10),
  }));

  const [counts] = rowsOf<{ high_intent: number; avg_score: number | null }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE readiness_score >= ${HIGH_INTENT_SCORE})::int AS high_intent,
             round(avg(readiness_score))::int AS avg_score
      FROM prospects WHERE status <> 'ARCHIVED'
    `),
  );
  const [recent] = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM signals
      WHERE status <> 'SKIPPED' AND detected_at >= ${new Date(now.getTime() - SIGNALS_WINDOW_DAYS * 86_400_000).toISOString()}::timestamptz
    `),
  );
  const [top] = rowsOf<{ category: string }>(
    await db.execute(sql`
      SELECT b.category FROM prospects p JOIN brands b ON b.id = p.brand_id
      WHERE p.status <> 'ARCHIVED' AND b.category IS NOT NULL
        AND p.last_signal_at >= ${addDays(today, -TOP_CATEGORY_WINDOW_DAYS)}::date
      GROUP BY b.category ORDER BY count(*) DESC, b.category LIMIT 1
    `),
  );
  const [failed] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM signals WHERE status = 'FAILED'`));

  return {
    prospects: prospectRows,
    metrics: {
      highIntent: counts?.high_intent ?? 0,
      signals7d: recent?.n ?? 0,
      topCategory: top?.category ?? null,
      avgScore: counts?.avg_score ?? null,
    },
    pipeline: {
      lastSync: await lastRun(db, "sync"),
      lastAnalyze: await lastRun(db, "analyze"),
      failedSignals: failed?.n ?? 0,
    },
  };
}

export interface SignalDetail {
  id: string;
  type: "SEC_FORM_D" | "JOB_LISTING";
  date: string;
  url: string;
  title: string | null;
  amountUsd: number | null;
  location: string | null;
  description: string | null; // job description
  offering: { total: number | null; sold: number | null; firstSale: string | null; industryGroup: string | null } | null;
}

// The signals behind one prospect, newest first (SPEC §7.3).
export async function loadProspectSignals(db: Db, prospectId: string): Promise<SignalDetail[]> {
  const rows = await db
    .select({ s: signals })
    .from(signals)
    .innerJoin(prospects, eq(prospects.brandId, signals.brandId))
    .where(and(eq(prospects.id, prospectId), eq(signals.status, "PROCESSED")))
    .orderBy(desc(signals.signalDate));

  return rows.map(({ s }) => {
    const p = (s.rawPayload ?? {}) as Record<string, unknown>;
    const isFormD = s.signalType === "SEC_FORM_D";
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      id: s.id,
      type: s.signalType as SignalDetail["type"],
      date: s.signalDate,
      url: s.sourceUrl,
      title: s.title,
      amountUsd: s.amountUsd,
      location: isFormD ? null : [str(p.city), str(p.state)].filter(Boolean).join(", ") || null,
      description: isFormD ? null : str(p.description),
      offering: isFormD
        ? {
            total: num(p.totalOfferingAmount),
            sold: num(p.totalAmountSold),
            firstSale: str(p.dateOfFirstSale),
            industryGroup: str(p.industryGroupType),
          }
        : null,
    };
  });
}

// Records a rep's status change. Returns null when the prospect doesn't exist.
export async function setProspectStatus(
  db: Db,
  prospectId: string,
  status: ProspectStatus,
  userEmail: string,
  now: Date = new Date(),
): Promise<{ id: string; status: ProspectStatus; statusChangedAt: string } | null> {
  const [row] = await db
    .update(prospects)
    .set({ status, statusChangedAt: now, statusChangedBy: userEmail.slice(0, 255) })
    .where(eq(prospects.id, prospectId))
    .returning({ id: prospects.id, status: prospects.status, statusChangedAt: prospects.statusChangedAt });
  return row ? { id: row.id, status: row.status as ProspectStatus, statusChangedAt: iso(row.statusChangedAt)! } : null;
}
