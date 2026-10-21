import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { JOB_QUERIES } from "@/config/job-queries";
import { brands, pipelineRuns, signals, syncState } from "@/lib/db/schema";
import { EDGAR_CURSOR_KEY, runSync, type SyncDeps } from "@/lib/pipeline/sync";
import { createTestDb, type TestDb } from "../helpers/db";
import { count, makeBrand } from "../helpers/factories";
import { fixtureText } from "../helpers/fixtures";

const TODAY = "2026-10-21";
const UA = "Simon Prospecting test@example.com";
const SEC = "https://www.sec.gov/Archives/edgar";
const INDEX_1020 = `${SEC}/daily-index/2026/QTR4/form.20261020.idx`;
const INDEX_1019 = `${SEC}/daily-index/2026/QTR4/form.20261019.idx`;

// The four "D" rows in the trimmed Oct 20 index, each served one of the real Form D fixtures.
// (The XML's issuer differs from the index row's company; sync takes issuer data from the XML.)
const PRIMARY_DOCS: Record<string, string> = {
  [`${SEC}/data/2146260/000214626026000001/primary_doc.xml`]: "sec/formd-manufacturing-hiyo.xml", // passes
  [`${SEC}/data/2160407/000216040726000001/primary_doc.xml`]: "sec/formd-retailing-coop.xml", // passes
  [`${SEC}/data/2154979/000215497926000002/primary_doc.xml`]: "sec/formd-pooled-fund.xml", // industry
  [`${SEC}/data/2156132/000215613226000001/primary_doc.xml`]: "sec/formd-retailing-below-min.xml", // amount
};

type Route = (url: URL) => { status: number; body: string } | undefined;

function fakeFetch(routes: Route[] = []) {
  const requests: { url: string; headers: Headers }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ url: url.href, headers: new Headers(init?.headers) });
    for (const route of [...routes, defaultRoute]) {
      const hit = route(url);
      if (hit) return new Response(hit.body, { status: hit.status });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: impl as typeof fetch, requests };
}

const defaultRoute: Route = (url) => {
  if (url.href === INDEX_1020) return { status: 200, body: fixtureText("sec/form.20261020.idx") };
  if (PRIMARY_DOCS[url.href]) return { status: 200, body: fixtureText(PRIMARY_DOCS[url.href]) };
  if (url.hostname === "jsearch.p.rapidapi.com") return { status: 200, body: fixtureText("jsearch/search.SYNTHETIC.json") };
  return undefined;
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => {
  await t.reset();
  await setCursor("2026-10-19"); // → only Oct 20 to sync
});
afterAll(async () => t.close());

async function setCursor(value: string) {
  await t.db.insert(syncState).values({ key: EDGAR_CURSOR_KEY, value }).onConflictDoUpdate({ target: syncState.key, set: { value } });
}
async function cursor() {
  const [row] = await t.db.select().from(syncState).where(eq(syncState.key, EDGAR_CURSOR_KEY));
  return row?.value;
}

function deps(f: typeof fetch, overrides: Partial<SyncDeps> = {}): SyncDeps {
  return { fetch: f, today: TODAY, secUserAgent: UA, rapidApiKey: "test-key", minOffering: 2_000_000, jobsEveryNDays: 1, sleep: async () => {}, ...overrides };
}

const signalsByType = (type: string) => t.db.select().from(signals).where(eq(signals.signalType, type));

describe("runSync — SEC Form D", () => {
  test("ingests the Form D filings that pass the filters and advances the cursor", async () => {
    const { fetch } = fakeFetch();
    const result = await runSync(t.db, deps(fetch, { rapidApiKey: null }));

    expect(result.sec).toMatchObject({ status: "ok", inserted: 2, duplicates: 0, filtered: 2, datesProcessed: ["2026-10-20"] });
    expect(await cursor()).toBe("2026-10-20");

    const rows = await signalsByType("SEC_FORM_D");
    const hiyo = rows.find((s) => s.externalId === "0002146260-26-000001")!;
    expect(hiyo).toMatchObject({
      status: "PENDING",
      signalDate: "2026-10-20",
      amountUsd: 20_824_987,
      companyNameRaw: "hiyo Inc.",
      sourceUrl: `${SEC}/data/2146260/000214626026000001/`,
    });
    expect(hiyo.rawPayload).toMatchObject({ issuerName: "hiyo Inc.", cik: "2046308", industryGroupType: "Manufacturing" });
    expect(rows.map((s) => s.externalId).sort()).toEqual(["0002146260-26-000001", "0002160407-26-000001"]);
  });

  test("creates brand stubs from the filing's issuer", async () => {
    const { fetch } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    const [hiyo] = await t.db.select().from(brands).where(eq(brands.cik, "2046308"));
    expect(hiyo).toMatchObject({ legalName: "hiyo Inc.", hqState: "CA", normalizedName: "hiyo" });
    expect(hiyo.keyPeople).toHaveLength(4);
  });

  test("fetches primary docs only for form D rows, always with the SEC User-Agent", async () => {
    const { fetch, requests } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    const sec = requests.filter((r) => r.url.startsWith("https://www.sec.gov/"));
    expect(sec.map((r) => r.url).sort()).toEqual([INDEX_1020, ...Object.keys(PRIMARY_DOCS)].sort());
    for (const r of sec) expect(r.headers.get("user-agent")).toBe(UA);
  });

  test("throttles SEC requests", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null, sleep }));
    expect(sleep).toHaveBeenCalled();
  });

  test("a second run inserts nothing new", async () => {
    const { fetch } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    await setCursor("2026-10-19");
    const again = await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    expect(again.sec).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(await count(t.db, "signals")).toBe(2);
  });

  test("a missing index (holiday) is skipped and the cursor still advances", async () => {
    await setCursor("2026-10-16");
    const { fetch } = fakeFetch(); // Oct 19 index → 404
    const result = await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    expect(result.sec).toMatchObject({ status: "ok", inserted: 2, datesProcessed: ["2026-10-19", "2026-10-20"] });
    expect(await cursor()).toBe("2026-10-20");
  });

  test("a server error stops SEC ingest without advancing past the failed date", async () => {
    await setCursor("2026-10-16");
    const { fetch } = fakeFetch([
      (url) => (url.href === INDEX_1019 ? { status: 200, body: fixtureText("sec/form.20261020.idx").split("\n").slice(0, 11).join("\n") } : undefined),
      (url) => (url.href === INDEX_1020 ? { status: 503, body: "busy" } : undefined),
    ]);
    const result = await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    expect(result.sec.status).toBe("failed");
    expect(result.sec.error).toBeTruthy();
    expect(await cursor()).toBe("2026-10-19");
  });

  test("signals for an already-excluded brand are inserted as SKIPPED", async () => {
    await makeBrand(t.db, { name: "hiyo Inc.", normalizedName: "hiyo", cik: "2046308", excluded: true });
    const { fetch } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    const [s] = await t.db.select().from(signals).where(eq(signals.externalId, "0002146260-26-000001"));
    expect(s.status).toBe("SKIPPED");
  });

  test("first run with no cursor looks back 5 business days", async () => {
    await t.db.delete(syncState);
    const { fetch, requests } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    const indexes = requests.filter((r) => r.url.includes("/daily-index/")).map((r) => r.url.slice(-12, -4));
    expect(indexes).toEqual(["20261014", "20261015", "20261016", "20261019", "20261020"]);
  });
});

describe("runSync — job listings", () => {
  test("one request per query with RapidAPI headers", async () => {
    const { fetch, requests } = fakeFetch();
    await runSync(t.db, deps(fetch));
    const jobs = requests.filter((r) => r.url.startsWith("https://jsearch.p.rapidapi.com/"));
    expect(jobs).toHaveLength(JOB_QUERIES.length);
    expect(jobs.map((r) => new URL(r.url).searchParams.get("query")).sort()).toEqual([...JOB_QUERIES].sort());
    for (const r of jobs) {
      expect(r.headers.get("x-rapidapi-key")).toBe("test-key");
      expect(r.headers.get("x-rapidapi-host")).toBe("jsearch.p.rapidapi.com");
    }
  });

  test("inserts the filtered, de-duplicated listings", async () => {
    const { fetch } = fakeFetch();
    const result = await runSync(t.db, deps(fetch));
    // 8 queries × 23 listings, 4 kept
    expect(result.jobs).toMatchObject({ status: "ok", inserted: 4, filtered: JOB_QUERIES.length * 23 - 4 });
    const rows = await signalsByType("JOB_LISTING");
    expect(rows.map((s) => s.externalId).sort()).toEqual(["synthetic-001", "synthetic-002", "synthetic-003", "synthetic-007"]);
    const fernwood = rows.find((s) => s.externalId === "synthetic-001")!;
    expect(fernwood).toMatchObject({ signalDate: "2026-10-18", title: "Director of Retail", sourceUrl: "https://example.com/jobs/synthetic-001", companyNameRaw: "Fernwood Skin Co" });
    expect(rows.find((s) => s.externalId === "synthetic-007")!.signalDate).toBe(TODAY); // no posting date
  });

  test("job brands get their normalized domain", async () => {
    const { fetch } = fakeFetch();
    await runSync(t.db, deps(fetch));
    const [fernwood] = await t.db.select().from(brands).where(eq(brands.normalizedName, "fernwood skin"));
    expect(fernwood.domain).toBe("fernwoodskin.com");
    const [lumen] = await t.db.select().from(brands).where(eq(brands.normalizedName, "lumen candle"));
    expect(lumen.domain).toBeNull();
  });

  test("high-volume employers are excluded brands with no signals", async () => {
    const { fetch } = fakeFetch();
    const result = await runSync(t.db, deps(fetch));
    expect(result.jobs.highVolumeEmployers).toEqual(["Big Chain Outfitters"]);
    const [big] = await t.db.select().from(brands).where(eq(brands.normalizedName, "big chain outfitters"));
    expect(big).toMatchObject({ excluded: true, exclusionReason: "high-volume employer" });
    expect(await t.db.select().from(signals).where(eq(signals.brandId, big.id))).toHaveLength(0);
  });

  test("skipped without an API key", async () => {
    const { fetch, requests } = fakeFetch();
    const result = await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    expect(result.jobs.status).toBe("skipped");
    expect(requests.some((r) => r.url.includes("rapidapi"))).toBe(false);
  });

  test("skipped on days outside JOBS_RUN_EVERY_N_DAYS", async () => {
    const day = Date.parse(TODAY) / 86_400_000;
    expect(day % 1000).not.toBe(0); // guard: TODAY is not a run day for N = 1000
    const { fetch, requests } = fakeFetch();
    const result = await runSync(t.db, deps(fetch, { jobsEveryNDays: 1000 }));
    expect(result.jobs.status).toBe("skipped");
    expect(requests.some((r) => r.url.includes("rapidapi"))).toBe(false);
  });

  test("a JSearch error fails only the jobs source", async () => {
    const { fetch } = fakeFetch([(url) => (url.hostname === "jsearch.p.rapidapi.com" ? { status: 429, body: '{"message":"quota"}' } : undefined)]);
    const result = await runSync(t.db, deps(fetch));
    expect(result.jobs.status).toBe("failed");
    expect(result.sec).toMatchObject({ status: "ok", inserted: 2 });
  });
});

describe("runSync — run log", () => {
  async function lastRun() {
    const [run] = await t.db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1);
    return run;
  }

  test("SUCCEEDED when both sources succeed", async () => {
    const { fetch } = fakeFetch();
    const result = await runSync(t.db, deps(fetch));
    const run = await lastRun();
    expect(run).toMatchObject({ id: result.runId, job: "sync", status: "SUCCEEDED" });
    expect(run.finishedAt).not.toBeNull();
  });

  test("PARTIAL when one source fails", async () => {
    const { fetch } = fakeFetch([(url) => (url.href === INDEX_1020 ? { status: 500, body: "" } : undefined)]);
    await runSync(t.db, deps(fetch));
    expect((await lastRun()).status).toBe("PARTIAL");
  });

  test("FAILED when both sources fail", async () => {
    const { fetch } = fakeFetch([
      (url) => (url.href === INDEX_1020 ? { status: 500, body: "" } : undefined),
      (url) => (url.hostname === "jsearch.p.rapidapi.com" ? { status: 500, body: "" } : undefined),
    ]);
    await runSync(t.db, deps(fetch));
    const run = await lastRun();
    expect(run.status).toBe("FAILED");
    expect(run.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("a skipped jobs source doesn't make the run PARTIAL", async () => {
    const { fetch } = fakeFetch();
    await runSync(t.db, deps(fetch, { rapidApiKey: null }));
    expect((await lastRun()).status).toBe("SUCCEEDED");
  });
});
