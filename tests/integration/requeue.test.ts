import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { findRequeueCandidates, requeueExcludedBrands } from "@/lib/pipeline/requeue";
import { claimNextBrand } from "@/lib/pipeline/analyze";
import { createTestDb, type TestDb } from "../helpers/db";
import { brandById, makeBrand, makeProspect, makeSignal, prospectsOf, signalsOf } from "../helpers/factories";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => t.reset());
afterAll(async () => t.close());

// Exclusion reasons as Claude wrote them in the Oct 21, 2026 production run.
const REASONS = {
  hiyo: 'The only signal is a Form D with industry group "Manufacturing". It doesn\'t show that hiyo sells to consumers.',
  mend: "Insufficient evidence of an emerging consumer retail brand. The only signal is a Form D with industry group Other.",
  ginAndLuck: "Form D lists the industry group as Restaurants, which makes this a restaurant/hospitality business.",
  goldMiner: "Westward Gold Inc. appears to be a mineral exploration/mining company (gold), not a consumer brand.",
  steel: "Flux Steel Holdings LLC is a holding company with an industrial focus.",
};

async function excluded(name: string, reason: string) {
  const b = await makeBrand(t.db, { name, normalizedName: name.toLowerCase(), excluded: true, exclusionReason: reason });
  await makeSignal(t.db, b.id, { signalType: "SEC_FORM_D", status: "SKIPPED", attempts: 1, lastError: "old", processedAt: new Date("2026-10-21T23:05:00Z") });
  return b;
}

describe("findRequeueCandidates", () => {
  test("matches thin-evidence and restaurant exclusions, not real non-consumer ones", async () => {
    await excluded("hiyo Inc.", REASONS.hiyo);
    await excluded("MEND NUTRITION INC.", REASONS.mend);
    await excluded("Gin & Luck Inc.", REASONS.ginAndLuck);
    await excluded("Westward Gold Inc.", REASONS.goldMiner);
    await excluded("Flux Steel Holdings LLC", REASONS.steel);
    const names = (await findRequeueCandidates(t.db)).map((c) => c.name);
    expect(names).toEqual(["Gin & Luck Inc.", "MEND NUTRITION INC.", "hiyo Inc."]);
  });

  test("never matches sync's high-volume exclusions or brands that aren't excluded", async () => {
    await excluded("Big Chain Outfitters", "high-volume employer");
    await makeBrand(t.db, { name: "Active", exclusionReason: "insufficient evidence (stale text)", excluded: false });
    expect(await findRequeueCandidates(t.db, "high-volume|insufficient")).toEqual([]);
  });

  test("keeps exclusions that name positive evidence, even when they mention thin evidence", async () => {
    await excluded("Metro Diner Holdings LLC", "Metro Diner is an established restaurant chain with a large multi-state footprint.");
    await excluded("Tuckahoe Holdings, LLC", "Tuckahoe Holdings, LLC appears to be a holding entity. The only signal is a $150M Form D.");
    await excluded("Monetization Solutions, Inc.", "No evidence of a consumer brand. The name suggests a service or B2B business.");
    await excluded("hiyo Inc.", REASONS.hiyo);
    expect((await findRequeueCandidates(t.db)).map((c) => c.name)).toEqual(["hiyo Inc."]);
    expect(await findRequeueCandidates(t.db, undefined, null)).toHaveLength(4);
  });

  test("accepts a custom pattern, case-insensitive", async () => {
    await excluded("Gin & Luck Inc.", REASONS.ginAndLuck);
    await excluded("hiyo Inc.", REASONS.hiyo);
    expect((await findRequeueCandidates(t.db, "RESTAURANT")).map((c) => c.name)).toEqual(["Gin & Luck Inc."]);
  });
});

describe("requeueExcludedBrands", () => {
  test("un-excludes the brand and queues its skipped signals with a fresh attempt count", async () => {
    const b = await excluded("hiyo Inc.", REASONS.hiyo);
    const result = await requeueExcludedBrands(t.db, [b.id]);
    expect(result).toEqual({ brands: 1, signals: 1, prospectsRestored: 0 });
    expect(await brandById(t.db, b.id)).toMatchObject({ excluded: false, exclusionReason: null });
    expect((await signalsOf(t.db, b.id))[0]).toMatchObject({ status: "PENDING", attempts: 0, lastError: null, processedAt: null });
  });

  test("the next analyze run can claim it", async () => {
    const b = await excluded("hiyo Inc.", REASONS.hiyo);
    await requeueExcludedBrands(t.db, [b.id]);
    expect(await claimNextBrand(t.db)).toBe(b.id);
  });

  test("leaves PROCESSED and FAILED signals alone", async () => {
    const b = await excluded("hiyo Inc.", REASONS.hiyo);
    await makeSignal(t.db, b.id, { status: "PROCESSED", signalDate: "2026-10-01" });
    await makeSignal(t.db, b.id, { status: "FAILED", signalDate: "2026-10-02" });
    await requeueExcludedBrands(t.db, [b.id]);
    expect((await signalsOf(t.db, b.id)).map((s) => s.status).sort()).toEqual(["FAILED", "PENDING", "PROCESSED"]);
  });

  test("restores prospects the pipeline archived, but not ones a rep archived", async () => {
    const byPipeline = await excluded("A Brand", REASONS.mend);
    await makeProspect(t.db, byPipeline.id, { status: "ARCHIVED", statusChangedBy: "pipeline" });
    const byRep = await excluded("B Brand", REASONS.mend);
    await makeProspect(t.db, byRep.id, { status: "ARCHIVED", statusChangedBy: "rep@company.com" });

    const result = await requeueExcludedBrands(t.db, [byPipeline.id, byRep.id]);
    expect(result.prospectsRestored).toBe(1);
    expect((await prospectsOf(t.db, byPipeline.id))[0].status).toBe("NEW");
    expect((await prospectsOf(t.db, byRep.id))[0].status).toBe("ARCHIVED");
  });

  test("ignores brands that aren't excluded and an empty list", async () => {
    const active = await makeBrand(t.db);
    await makeSignal(t.db, active.id, { status: "SKIPPED" });
    expect(await requeueExcludedBrands(t.db, [active.id])).toEqual({ brands: 0, signals: 0, prospectsRestored: 0 });
    expect((await signalsOf(t.db, active.id))[0].status).toBe("SKIPPED");
    expect(await requeueExcludedBrands(t.db, [])).toEqual({ brands: 0, signals: 0, prospectsRestored: 0 });
  });
});
