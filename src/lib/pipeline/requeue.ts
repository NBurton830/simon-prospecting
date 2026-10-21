import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { brands, prospects, signals } from "@/lib/db/schema";

// Claude exclusions made under the original, stricter relevance rule (Oct 2026): "not enough
// evidence" and restaurants-as-services. Matched case-insensitively against exclusion_reason.
export const DEFAULT_REQUEUE_PATTERN =
  "insufficient evidence|only signal is|no evidence of a consumer|not an identifiable consumer|restaurant|hospitality";

// Reasons that name positive evidence stay excluded even if they also mention thin evidence.
export const KEEP_EXCLUDED_PATTERN =
  "real estate|established|holding (company|entity)|mining|mineral|uranium|b2b|industrial|investment (fund|vehicle)";

// Sync's own exclusions are deliberate and never re-queued.
const NEVER_REQUEUE = ["high-volume employer"];

export interface RequeueCandidate {
  id: string;
  name: string;
  exclusionReason: string | null;
}

export async function findRequeueCandidates(
  db: Db,
  pattern = DEFAULT_REQUEUE_PATTERN,
  keepPattern: string | null = KEEP_EXCLUDED_PATTERN,
): Promise<RequeueCandidate[]> {
  return db
    .select({ id: brands.id, name: brands.name, exclusionReason: brands.exclusionReason })
    .from(brands)
    .where(
      and(
        eq(brands.excluded, true),
        sql`${brands.exclusionReason} ~* ${pattern}`,
        keepPattern ? sql`${brands.exclusionReason} !~* ${keepPattern}` : undefined,
        sql`${brands.exclusionReason} NOT IN (${sql.join(NEVER_REQUEUE.map((r) => sql`${r}`), sql`, `)})`,
      ),
    )
    .orderBy(brands.name);
}

// Un-excludes the brands and puts their skipped signals back in the queue with a fresh attempt count.
// Prospects the pipeline archived on exclusion go back to NEW; a rep's own status is left alone.
export async function requeueExcludedBrands(
  db: Db,
  brandIds: string[],
  now: Date = new Date(),
): Promise<{ brands: number; signals: number; prospectsRestored: number }> {
  if (brandIds.length === 0) return { brands: 0, signals: 0, prospectsRestored: 0 };

  const unexcluded = await db
    .update(brands)
    .set({ excluded: false, exclusionReason: null })
    .where(and(inArray(brands.id, brandIds), eq(brands.excluded, true)))
    .returning({ id: brands.id });
  const ids = unexcluded.map((b) => b.id);
  if (ids.length === 0) return { brands: 0, signals: 0, prospectsRestored: 0 };

  const requeued = await db
    .update(signals)
    .set({ status: "PENDING", attempts: 0, lastError: null, lockedAt: null, processedAt: null })
    .where(and(inArray(signals.brandId, ids), eq(signals.status, "SKIPPED")))
    .returning({ id: signals.id });

  const restored = await db
    .update(prospects)
    .set({ status: "NEW", statusChangedAt: now, statusChangedBy: "pipeline" })
    .where(and(inArray(prospects.brandId, ids), eq(prospects.status, "ARCHIVED"), eq(prospects.statusChangedBy, "pipeline")))
    .returning({ id: prospects.id });

  return { brands: ids.length, signals: requeued.length, prospectsRestored: restored.length };
}
