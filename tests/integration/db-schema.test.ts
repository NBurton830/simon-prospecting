import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { brands, prospects, signals } from "@/lib/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { brandById, count, makeBrand, makeProspect, makeSignal } from "../helpers/factories";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => t.reset());
afterAll(async () => t.close());

describe("signals", () => {
  test("(signal_type, external_id) is unique", async () => {
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id, { externalId: "0002156132-26-000001", signalType: "SEC_FORM_D" });
    await expect(
      makeSignal(t.db, b.id, { externalId: "0002156132-26-000001", signalType: "SEC_FORM_D" }),
    ).rejects.toThrow();
    // same id from a different source is fine
    await makeSignal(t.db, b.id, { externalId: "0002156132-26-000001", signalType: "JOB_LISTING" });
    expect(await count(t.db, "signals")).toBe(2);
  });

  test("rejects unknown signal types and statuses", async () => {
    const b = await makeBrand(t.db);
    await expect(makeSignal(t.db, b.id, { signalType: "PRESS_RELEASE" })).rejects.toThrow();
    await expect(makeSignal(t.db, b.id, { status: "DONE" })).rejects.toThrow();
  });

  test("defaults to PENDING with 0 attempts", async () => {
    const b = await makeBrand(t.db);
    const s = await makeSignal(t.db, b.id);
    expect(s.status).toBe("PENDING");
    expect(s.attempts).toBe(0);
  });

  test("require a brand", async () => {
    await expect(
      t.db.insert(signals).values({
        brandId: "00000000-0000-0000-0000-000000000000",
        signalType: "JOB_LISTING",
        externalId: "x",
        sourceUrl: "x",
        companyNameRaw: "x",
        signalDate: "2026-10-01",
        rawPayload: {},
      }),
    ).rejects.toThrow();
  });
});

describe("brands", () => {
  test("normalized_name, cik and domain are unique; null cik/domain may repeat", async () => {
    await makeBrand(t.db, { normalizedName: "acme", cik: "1", domain: "acme.com" });
    await expect(makeBrand(t.db, { normalizedName: "acme" })).rejects.toThrow();
    await expect(makeBrand(t.db, { cik: "1" })).rejects.toThrow();
    await expect(makeBrand(t.db, { domain: "acme.com" })).rejects.toThrow();
    await makeBrand(t.db, { cik: null, domain: null });
    await makeBrand(t.db, { cik: null, domain: null });
    expect(await count(t.db, "brands")).toBe(3);
  });

  test("updated_at is bumped on update", async () => {
    const b = await makeBrand(t.db);
    await t.db.execute(sql`UPDATE brands SET updated_at = '2020-01-01' WHERE id = ${b.id}`);
    await t.db.update(brands).set({ description: "changed" }).where(eq(brands.id, b.id));
    expect((await brandById(t.db, b.id)).updatedAt.getUTCFullYear()).toBeGreaterThan(2020);
  });

  test("deleting a brand cascades to signals and prospects", async () => {
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id);
    await makeProspect(t.db, b.id);
    await t.db.delete(brands).where(eq(brands.id, b.id));
    expect(await count(t.db, "signals")).toBe(0);
    expect(await count(t.db, "prospects")).toBe(0);
  });
});

describe("prospects", () => {
  test("one per brand", async () => {
    const b = await makeBrand(t.db);
    await makeProspect(t.db, b.id);
    await expect(makeProspect(t.db, b.id)).rejects.toThrow();
  });

  test.each([0, 101])("rejects readiness_score %s", async (score) => {
    const b = await makeBrand(t.db);
    await expect(makeProspect(t.db, b.id, { readinessScore: score })).rejects.toThrow();
  });

  test("rejects unknown statuses; defaults to NEW", async () => {
    const b = await makeBrand(t.db);
    await expect(makeProspect(t.db, b.id, { status: "WON" })).rejects.toThrow();
    const p = await makeProspect(t.db, b.id);
    expect(p.status).toBe("NEW");
  });

  test("updated_at is bumped on update", async () => {
    const b = await makeBrand(t.db);
    const p = await makeProspect(t.db, b.id);
    await t.db.execute(sql`UPDATE prospects SET updated_at = '2020-01-01' WHERE id = ${p.id}`);
    await t.db.update(prospects).set({ status: "REVIEWED" }).where(eq(prospects.id, p.id));
    const [row] = await t.db.select().from(prospects).where(eq(prospects.id, p.id));
    expect(row.updatedAt.getUTCFullYear()).toBeGreaterThan(2020);
  });
});

describe("pipeline_runs", () => {
  test("rejects unknown jobs and statuses", async () => {
    await expect(t.db.execute(sql`INSERT INTO pipeline_runs (job) VALUES ('process')`)).rejects.toThrow();
    await expect(
      t.db.execute(sql`INSERT INTO pipeline_runs (job, status) VALUES ('sync', 'DONE')`),
    ).rejects.toThrow();
  });
});
