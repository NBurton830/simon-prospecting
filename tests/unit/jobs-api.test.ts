import { describe, expect, test } from "vitest";
import { MAX_DESCRIPTION_CHARS } from "@/lib/analysis/prompt";
import {
  filterJobListings,
  jobSignalDate,
  jsearchUrl,
  parseJSearchResponse,
  shouldRunJobs,
  type JobListing,
} from "@/lib/ingest/jobs-api";
import { fixtureJson } from "../helpers/fixtures";

const listings = () => parseJSearchResponse(fixtureJson("jsearch/search.SYNTHETIC.json"));

describe("parseJSearchResponse", () => {
  test("maps every listing", () => {
    const all = listings();
    expect(all).toHaveLength(23);
    expect(all[0]).toMatchObject({
      jobId: "synthetic-001",
      employerName: "Fernwood Skin Co",
      employerWebsite: "https://www.fernwoodskin.com/careers",
      title: "Director of Retail",
      city: "Austin",
      state: "TX",
      applyLink: "https://example.com/jobs/synthetic-001",
      postedAt: "2026-10-18T14:00:00.000Z",
    });
  });

  test(`truncates descriptions to ${MAX_DESCRIPTION_CHARS} characters`, () => {
    const long = listings()[0];
    expect(long.description.length).toBe(MAX_DESCRIPTION_CHARS);
    expect(long.description.startsWith("Fernwood Skin Co is opening its first three brand stores.")).toBe(true);
  });

  test("keeps nulls for a missing website or posting date", () => {
    const all = listings();
    expect(all.find((l) => l.employerName === "Lumen Candle Co.")!.employerWebsite).toBeNull();
    expect(all.find((l) => l.employerName === "Halcyon Footwear")!.postedAt).toBeNull();
  });

  test("throws on a response without a data array", () => {
    expect(() => parseJSearchResponse({ status: "ERROR", message: "quota exceeded" })).toThrow();
    expect(() => parseJSearchResponse(null)).toThrow();
  });

  test("returns [] for an empty data array", () => {
    expect(parseJSearchResponse({ status: "OK", data: [] })).toEqual([]);
  });
});

describe("jsearchUrl", () => {
  test("sets the documented query parameters", () => {
    const url = new URL(jsearchUrl("Director of Retail"));
    expect(url.origin + url.pathname).toBe("https://jsearch.p.rapidapi.com/search");
    expect(url.searchParams.get("query")).toBe("Director of Retail");
    expect(url.searchParams.get("country")).toBe("us");
    expect(url.searchParams.get("date_posted")).toBe("3days");
    expect(url.searchParams.get("num_pages")).toBe("1");
  });
});

describe("filterJobListings", () => {
  const result = () => filterJobListings(listings());

  test("keeps emerging-brand retail roles", () => {
    expect(result().kept.map((l) => l.jobId)).toEqual([
      "synthetic-001", // Fernwood — Director of Retail
      "synthetic-002", // Lumen — Pop-Up Shop Manager
      "synthetic-003", // Northbound — Retail Experiential Manager
      "synthetic-007", // Halcyon — Opening Store Manager
    ]);
  });

  test("counts what each rule dropped", () => {
    expect(result().dropped).toEqual({ duplicate: 0, blocklisted: 2, titleMismatch: 1, highVolume: 16 });
  });

  test("flags employers over the volume threshold", () => {
    expect(result().highVolumeEmployers).toEqual(["Big Chain Outfitters"]);
  });

  test("an employer at exactly the threshold is not high-volume", () => {
    const fifteen = listings().filter((l) => l.employerName === "Big Chain Outfitters").slice(0, 15);
    const r = filterJobListings(fifteen);
    expect(r.highVolumeEmployers).toEqual([]);
    expect(r.kept).toHaveLength(15);
  });

  test("blocklist matches after name normalization", () => {
    const base = listings()[0];
    const r = filterJobListings([
      { ...base, jobId: "a", employerName: "Walmart Inc." },
      { ...base, jobId: "b", employerName: "THE HOME DEPOT" },
      { ...base, jobId: "c", employerName: "Targeted Skincare" }, // not "Target"
    ]);
    expect(r.kept.map((l) => l.jobId)).toEqual(["c"]);
    expect(r.dropped.blocklisted).toBe(2);
  });

  test("de-duplicates by jobId across queries before counting volume", () => {
    const base = listings()[0];
    const dupes: JobListing[] = Array.from({ length: 20 }, () => ({ ...base }));
    const r = filterJobListings(dupes);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped.duplicate).toBe(19);
    expect(r.highVolumeEmployers).toEqual([]);
  });

  test("accepts overrides for the blocklist, threshold, and title pattern", () => {
    const all = listings();
    const r = filterJobListings(all, { excludedEmployers: [], highVolumeThreshold: 100, titlePattern: /./ });
    expect(r.kept).toHaveLength(23);
  });
});

describe("shouldRunJobs", () => {
  const days = (start: string, n: number) =>
    Array.from({ length: n }, (_, i) => new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10));

  test("every day when N = 1 (and for N < 1)", () => {
    for (const d of days("2026-10-01", 7)) {
      expect(shouldRunJobs(d, 1)).toBe(true);
      expect(shouldRunJobs(d, 0)).toBe(true);
    }
  });

  test("every Nth day", () => {
    expect(days("2026-10-01", 6).filter((d) => shouldRunJobs(d, 3))).toHaveLength(2);
    const two = days("2026-10-20", 2).map((d) => shouldRunJobs(d, 2));
    expect(two.filter(Boolean)).toHaveLength(1);
  });
});

describe("jobSignalDate", () => {
  test("posting date in UTC", () => {
    const l = listings()[0];
    expect(jobSignalDate(l, "2026-10-21")).toBe("2026-10-18");
    expect(jobSignalDate({ ...l, postedAt: "2026-10-18T23:30:00-05:00" }, "2026-10-21")).toBe("2026-10-19");
  });

  test("falls back to today", () => {
    expect(jobSignalDate({ ...listings()[0], postedAt: null }, "2026-10-21")).toBe("2026-10-21");
  });
});
