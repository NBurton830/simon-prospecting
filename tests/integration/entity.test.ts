import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { insertSignal, markBrandExcluded, resolveBrand, type NewSignal } from "@/lib/ingest/entity";
import { createTestDb, type TestDb } from "../helpers/db";
import { brandById, count, makeBrand, makeSignal, signalsOf } from "../helpers/factories";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => t.reset());
afterAll(async () => t.close());

const formDCandidate = (overrides = {}) => ({
  source: "SEC_FORM_D" as const,
  name: "hiyo Inc.",
  cik: "2046308",
  hqState: "CA",
  keyPeople: [{ name: "Evan Quinn", relationship: "Executive Officer, Director" }],
  ...overrides,
});
const jobCandidate = (overrides = {}) => ({
  source: "JOB_LISTING" as const,
  name: "Fernwood Skin Co",
  domain: "fernwoodskin.com",
  ...overrides,
});
const signal = (overrides: Partial<NewSignal> = {}): NewSignal => ({
  signalType: "JOB_LISTING",
  externalId: "job-1",
  sourceUrl: "https://example.com/jobs/1",
  companyNameRaw: "Fernwood Skin Co",
  signalDate: "2026-10-18",
  title: "Director of Retail",
  rawPayload: { job_id: "job-1" },
  ...overrides,
});

describe("resolveBrand — Form D", () => {
  test("creates a stub with legal name, cik, state and key people", async () => {
    const r = await resolveBrand(t.db, formDCandidate());
    expect(r.excluded).toBe(false);
    const b = await brandById(t.db, r.id);
    expect(b).toMatchObject({
      name: "hiyo Inc.",
      legalName: "hiyo Inc.",
      normalizedName: "hiyo",
      cik: "2046308",
      hqState: "CA",
      domain: null,
      category: null,
      keyPeople: [{ name: "Evan Quinn", relationship: "Executive Officer, Director" }],
    });
  });

  test("matches an existing brand by cik even if the name changed", async () => {
    const first = await resolveBrand(t.db, formDCandidate());
    const second = await resolveBrand(t.db, formDCandidate({ name: "Hiyo Beverages, Inc." }));
    expect(second.id).toBe(first.id);
    expect(await count(t.db, "brands")).toBe(1);
  });

  test("matches by normalized name and fills in the missing cik", async () => {
    const job = await resolveBrand(t.db, jobCandidate({ name: "Hiyo", domain: "drinkhiyo.com" }));
    const filing = await resolveBrand(t.db, formDCandidate());
    expect(filing.id).toBe(job.id);
    const b = await brandById(t.db, job.id);
    expect(b.cik).toBe("2046308");
    expect(b.domain).toBe("drinkhiyo.com");
  });
});

describe("resolveBrand — job listings", () => {
  test("creates a stub with the domain", async () => {
    const r = await resolveBrand(t.db, jobCandidate());
    expect(await brandById(t.db, r.id)).toMatchObject({
      name: "Fernwood Skin Co",
      normalizedName: "fernwood skin",
      domain: "fernwoodskin.com",
      cik: null,
      legalName: null,
    });
  });

  test("matches by domain across different employer names", async () => {
    const a = await resolveBrand(t.db, jobCandidate());
    const b = await resolveBrand(t.db, jobCandidate({ name: "Fernwood Skincare" }));
    expect(b.id).toBe(a.id);
  });

  test("matches by normalized name and fills in the missing domain", async () => {
    const a = await resolveBrand(t.db, jobCandidate({ domain: null }));
    const b = await resolveBrand(t.db, jobCandidate({ name: "Fernwood Skin Co." }));
    expect(b.id).toBe(a.id);
    expect((await brandById(t.db, a.id)).domain).toBe("fernwoodskin.com");
  });

  test("a different domain under the same name keeps the first domain", async () => {
    const a = await resolveBrand(t.db, jobCandidate());
    const b = await resolveBrand(t.db, jobCandidate({ domain: "fernwood-careers.com" }));
    expect(b.id).toBe(a.id);
    expect((await brandById(t.db, a.id)).domain).toBe("fernwoodskin.com");
  });

  test("Form D stub and job listing for the same company merge by name", async () => {
    const filing = await resolveBrand(t.db, formDCandidate({ name: "Fernwood Skin Co, Inc.", cik: "9999999" }));
    const job = await resolveBrand(t.db, jobCandidate());
    expect(job.id).toBe(filing.id);
  });
});

describe("resolveBrand — general", () => {
  test("reports an excluded brand", async () => {
    await makeBrand(t.db, { name: "Big Chain", normalizedName: "big chain outfitters", excluded: true });
    const r = await resolveBrand(t.db, jobCandidate({ name: "Big Chain Outfitters", domain: null }));
    expect(r.excluded).toBe(true);
  });

  test("concurrent calls for the same new company create one brand", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => resolveBrand(t.db, jobCandidate())));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await count(t.db, "brands")).toBe(1);
  });
});

describe("insertSignal", () => {
  test("inserts a PENDING signal", async () => {
    const brand = await resolveBrand(t.db, jobCandidate());
    expect(await insertSignal(t.db, brand, signal())).toBe("inserted");
    const [s] = await signalsOf(t.db, brand.id);
    expect(s).toMatchObject({
      signalType: "JOB_LISTING",
      externalId: "job-1",
      status: "PENDING",
      signalDate: "2026-10-18",
      title: "Director of Retail",
      rawPayload: { job_id: "job-1" },
    });
  });

  test("a repeat is reported as a duplicate and not inserted", async () => {
    const brand = await resolveBrand(t.db, jobCandidate());
    await insertSignal(t.db, brand, signal());
    expect(await insertSignal(t.db, brand, signal({ title: "changed" }))).toBe("duplicate");
    expect(await count(t.db, "signals")).toBe(1);
    expect((await signalsOf(t.db, brand.id))[0].title).toBe("Director of Retail");
  });

  test("stores the Form D amount", async () => {
    const brand = await resolveBrand(t.db, formDCandidate());
    await insertSignal(t.db, brand, signal({ signalType: "SEC_FORM_D", externalId: "0002046308-26-000005", amountUsd: 20_824_987, title: null }));
    expect((await signalsOf(t.db, brand.id))[0].amountUsd).toBe(20_824_987);
  });

  test("signals for an excluded brand are inserted as SKIPPED", async () => {
    const b = await makeBrand(t.db, { excluded: true });
    await insertSignal(t.db, { id: b.id, excluded: true }, signal());
    expect((await signalsOf(t.db, b.id))[0].status).toBe("SKIPPED");
  });
});

describe("markBrandExcluded", () => {
  test("excludes the brand and skips its pending signals only", async () => {
    const b = await makeBrand(t.db);
    await makeSignal(t.db, b.id, { status: "PENDING", signalDate: "2026-10-01" });
    await makeSignal(t.db, b.id, { status: "PROCESSED", signalDate: "2026-10-02" });
    await markBrandExcluded(t.db, b.id, "high-volume employer");
    expect(await brandById(t.db, b.id)).toMatchObject({ excluded: true, exclusionReason: "high-volume employer" });
    expect((await signalsOf(t.db, b.id)).map((s) => s.status)).toEqual(["SKIPPED", "PROCESSED"]);
  });
});
