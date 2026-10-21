// Direct inserts for integration tests, so a test exercises only the function under test.
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { brands, prospects, signals } from "@/lib/db/schema";

let seq = 0;
const next = () => ++seq;

export async function makeBrand(db: Db, overrides: Partial<typeof brands.$inferInsert> = {}) {
  const n = next();
  const [row] = await db
    .insert(brands)
    .values({ name: `Brand ${n}`, normalizedName: `brand ${n}`, ...overrides })
    .returning();
  return row;
}

export async function makeSignal(db: Db, brandId: string, overrides: Partial<typeof signals.$inferInsert> = {}) {
  const n = next();
  const [row] = await db
    .insert(signals)
    .values({
      brandId,
      signalType: "JOB_LISTING",
      externalId: `ext-${n}`,
      sourceUrl: `https://example.com/${n}`,
      companyNameRaw: `Company ${n}`,
      signalDate: "2026-10-15",
      title: "Director of Retail",
      rawPayload: { n },
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeProspect(db: Db, brandId: string, overrides: Partial<typeof prospects.$inferInsert> = {}) {
  const [row] = await db
    .insert(prospects)
    .values({
      brandId,
      readinessScore: 50,
      scoreBreakdown: { funding: 12, retail_hiring: 20, physical_stage: 10, category_fit: 5, recency: 3 },
      scoreRationale: "seeded",
      fundingSummary: "seeded",
      recentSignalSummary: "seeded",
      expansionStage: "Unknown",
      targetDemographics: "seeded",
      pitchAngle: "seeded",
      recommendedFormats: ["Digital Directories"],
      lastSignalAt: "2026-09-01",
      model: "seed",
      ...overrides,
    })
    .returning();
  return row;
}

export async function signalsOf(db: Db, brandId: string) {
  return db.select().from(signals).where(eq(signals.brandId, brandId)).orderBy(signals.signalDate);
}

export async function brandById(db: Db, id: string) {
  const [row] = await db.select().from(brands).where(eq(brands.id, id));
  return row;
}

export async function prospectsOf(db: Db, brandId: string) {
  return db.select().from(prospects).where(eq(prospects.brandId, brandId));
}

export async function count(db: Db, table: "brands" | "signals" | "prospects" | "pipeline_runs"): Promise<number> {
  const r = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as unknown as { rows: { n: number }[] };
  return r.rows[0].n;
}
