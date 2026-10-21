import { describe, expect, test } from "vitest";
import {
  businessDatesToSync,
  dailyIndexUrl,
  filingIndexUrl,
  formDAmountUsd,
  formDDocumentUrl,
  parseDailyIndex,
  parseFormD,
  nonConsumerReason,
  passesFormDFilters,
} from "@/lib/ingest/sec-edgar";
import { fixtureText } from "../helpers/fixtures";

const MIN = 2_000_000;
const formD = (name: string) => parseFormD(fixtureText(`sec/formd-${name}.xml`));

describe("parseDailyIndex (real index, Oct 20 2026)", () => {
  const entries = () => parseDailyIndex(fixtureText("sec/form.20261020.idx"));

  test("parses every data row and skips the header", () => {
    expect(entries()).toHaveLength(9);
    expect(entries().map((e) => e.formType)).toEqual(["1-A", "144", "D", "D", "D", "D", "D/A", "D/A", "DEF 14A"]);
  });

  test("parses a Form D row", () => {
    expect(entries().find((e) => e.companyName === "Bad Chicken 2 LLC")).toEqual({
      formType: "D",
      companyName: "Bad Chicken 2 LLC",
      cik: "2156132",
      dateFiled: "2026-10-20",
      fileName: "edgar/data/2156132/0002156132-26-000001.txt",
      accessionNumber: "0002156132-26-000001",
    });
  });

  test("keeps multi-word form types and company names with punctuation", () => {
    const def14a = entries().find((e) => e.formType === "DEF 14A")!;
    expect(def14a.companyName).toBe("Banzai International, Inc.");
    const da = entries().filter((e) => e.formType === "D/A");
    expect(da[0].companyName).toBe("451-455 South Galvez Qualified Opportunity Zone Fund, LLC");
  });

  test("uses each row's own filing date", () => {
    expect(entries().find((e) => e.formType === "DEF 14A")!.dateFiled).toBe("2026-10-16");
  });

  test("returns no rows for an empty or header-only file", () => {
    expect(parseDailyIndex("")).toEqual([]);
    expect(parseDailyIndex(fixtureText("sec/form.20261020.idx").split("\n").slice(0, 11).join("\n"))).toEqual([]);
  });
});

describe("EDGAR URLs", () => {
  test("daily index URL uses the right quarter", () => {
    expect(dailyIndexUrl("2026-10-20")).toBe(
      "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261020.idx",
    );
    expect(dailyIndexUrl("2026-02-03")).toContain("/2026/QTR1/form.20260203.idx");
    expect(dailyIndexUrl("2026-04-01")).toContain("/2026/QTR2/");
    expect(dailyIndexUrl("2026-09-30")).toContain("/2026/QTR3/");
  });

  test("primary_doc and filing index URLs drop the accession dashes", () => {
    const entry = { cik: "2156132", accessionNumber: "0002156132-26-000001" };
    expect(formDDocumentUrl(entry)).toBe(
      "https://www.sec.gov/Archives/edgar/data/2156132/000215613226000001/primary_doc.xml",
    );
    expect(filingIndexUrl(entry)).toBe("https://www.sec.gov/Archives/edgar/data/2156132/000215613226000001/");
  });
});

describe("parseFormD (real filings)", () => {
  test("consumer brand filed under Manufacturing", () => {
    expect(formD("manufacturing-hiyo")).toEqual({
      cik: "2046308",
      issuerName: "hiyo Inc.",
      hqState: "CA",
      entityType: "Corporation",
      industryGroupType: "Manufacturing",
      isAmendment: false,
      totalOfferingAmount: 20824987,
      totalAmountSold: 20824987,
      dateOfFirstSale: "2026-02-17",
      relatedPersons: [
        { name: "Evan Quinn", relationship: "Executive Officer, Director" },
        { name: "George Youmans", relationship: "Executive Officer, Director" },
        { name: "Robert Knowles", relationship: "Executive Officer, Director" },
        { name: "Cygne Cooper", relationship: "Executive Officer" },
      ],
    });
  });

  test("decodes XML entities in the issuer name", () => {
    expect(formD("restaurant-entity-escape").issuerName).toBe("Gin & Luck Inc.");
  });

  test("keeps middle names and apostrophes in related persons", () => {
    expect(formD("other-canada").relatedPersons[0]).toEqual({
      name: "Michael G. Allen",
      relationship: "Executive Officer, Director",
    });
    expect(formD("restaurant-entity-escape").relatedPersons.map((p) => p.name)).toContain("Leland O'Connor");
  });

  test("skips placeholder first names on entity related persons", () => {
    expect(formD("other-indefinite").relatedPersons[0]).toEqual({
      name: "Dorado Parent GP, L.L.C.",
      relationship: "Promoter",
    });
    expect(formD("pooled-fund").relatedPersons.map((p) => p.name)).toEqual([
      "Coatue Capital CI, LP",
      "Coatue Management, L.L.C.",
    ]);
  });

  test("Indefinite offering amount → null; amount sold still parsed", () => {
    const f = formD("other-indefinite");
    expect(f.totalOfferingAmount).toBeNull();
    expect(f.totalAmountSold).toBe(0);
  });

  test("first sale yet to occur → null", () => {
    expect(formD("commercial-real-estate").dateOfFirstSale).toBeNull();
  });

  test("non-US state code → null", () => {
    expect(formD("other-canada").hqState).toBeNull();
  });

  test("strips leading zeros from the CIK", () => {
    expect(formD("retailing-coop").cik).toBe("2154475");
  });
});

describe("Form D amount and filters", () => {
  test("amount is the larger of offering and sold, treating Indefinite as 0", () => {
    expect(formDAmountUsd(formD("retailing-coop"))).toBe(3_000_000);
    expect(formDAmountUsd(formD("other-indefinite"))).toBe(0);
    expect(formDAmountUsd({ ...formD("retailing-coop"), totalOfferingAmount: null, totalAmountSold: 2_500_000 })).toBe(
      2_500_000,
    );
  });

  test.each([
    ["manufacturing-hiyo", true],
    ["retailing-coop", true],
    ["restaurant-entity-escape", true],
    ["other-canada", true], // "Other" passes; Claude makes the relevance call
    ["retailing-below-min", false], // $45K
    ["other-indefinite", false], // Indefinite, $0 sold
    ["pooled-fund", false], // excluded industry group
    ["commercial-real-estate", false], // excluded industry group
  ])("%s passes: %s", (name, expected) => {
    expect(passesFormDFilters(formD(name), MIN)).toBe(expected);
  });

  test("minimum is inclusive", () => {
    const f = { ...formD("retailing-coop"), totalOfferingAmount: MIN, totalAmountSold: 0 };
    expect(passesFormDFilters(f, MIN)).toBe(true);
    expect(passesFormDFilters({ ...f, totalOfferingAmount: MIN - 1 }, MIN)).toBe(false);
  });

  test("amendments never pass", () => {
    expect(passesFormDFilters({ ...formD("manufacturing-hiyo"), isAmendment: true }, MIN)).toBe(false);
  });
});

describe("nonConsumerReason", () => {
  const base = () => formD("manufacturing-hiyo");

  // Real issuer names from the Oct 14–20, 2026 filings that passed the industry and amount filters.
  test.each([
    "Triad Flex Fund LLC",
    "Sun Peak Metals Corp.",
    "SurgeU Ventures Fund LLC",
    "Next Level Blueline Ventures 1 LLC",
    "King Global Critical Minerals Inc.",
    "PST OZ AG Fund E LLC",
    "CORE X Partners LLC",
    "Crown Topco, LLC",
    "MOBILITY VENTURES GROUP LLC",
  ])("flags %s", (issuerName) => {
    expect(nonConsumerReason({ ...base(), issuerName })).not.toBeNull();
  });

  test.each([
    "hiyo Inc.",
    "MEND NUTRITION INC.",
    "DRINK HIPPIE CO.",
    "Youtopia Marketplace, LLC",
    "Gin & Luck Inc.",
    "Metro Diner Holdings LLC",
    "Red Bull Energy Drinks Inc.", // "energy" is deliberately allowed
    "Takoma Park-Silver Spring Cooperative, Inc", // a real grocery co-op; "silver" is allowed
    "Goldfinch Apparel Co.",
    "Silver & Stone Jewelry Inc.",
  ])("keeps %s", (issuerName) => {
    expect(nonConsumerReason({ ...base(), issuerName })).toBeNull();
  });

  test("flags limited partnerships", () => {
    expect(formD("other-indefinite").entityType).toBe("Limited Partnership");
    expect(nonConsumerReason(formD("other-indefinite"))).toMatch(/limited partnership/);
    expect(nonConsumerReason(formD("manufacturing-hiyo"))).toBeNull();
  });
});

describe("businessDatesToSync", () => {
  test("weekdays after the cursor up to yesterday", () => {
    // Fri Oct 16 → today Wed Oct 21
    expect(businessDatesToSync("2026-10-16", "2026-10-21")).toEqual(["2026-10-19", "2026-10-20"]);
  });

  test("nothing to do when the cursor is yesterday or later", () => {
    expect(businessDatesToSync("2026-10-20", "2026-10-21")).toEqual([]);
    expect(businessDatesToSync("2026-10-21", "2026-10-21")).toEqual([]);
  });

  test("Monday run after a Friday cursor has nothing new (weekend skipped)", () => {
    expect(businessDatesToSync("2026-10-16", "2026-10-19")).toEqual([]);
  });

  test("first run looks back 5 business days, oldest first", () => {
    expect(businessDatesToSync(null, "2026-10-21")).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(businessDatesToSync(null, "2026-10-21", { firstRunLookback: 2 })).toEqual(["2026-10-19", "2026-10-20"]);
  });

  test("a long gap is capped at maxDays, keeping the oldest so the cursor stays contiguous", () => {
    const dates = businessDatesToSync("2026-08-31", "2026-10-21", { maxDays: 3 });
    expect(dates).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });
});
