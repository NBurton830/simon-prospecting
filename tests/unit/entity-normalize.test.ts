import { describe, expect, test } from "vitest";
import { normalizeCompanyName, normalizeDomain } from "@/lib/ingest/entity";

describe("normalizeCompanyName", () => {
  test.each([
    // Real Form D issuer names
    ["hiyo Inc.", "hiyo"],
    ["Takoma Park-Silver Spring Cooperative, Inc", "takoma park silver spring cooperative"],
    ["Gin & Luck Inc.", "gin and luck"],
    ["Dorado Parent, L.P.", "dorado parent"],
    ["Kraken Pop LLC", "kraken pop"],
    ["Oaks at Killeen, LLC", "oaks at killeen"],
    // Job-board employer names
    ["Lumen Candle Co.", "lumen candle"],
    ["Northbound Outdoor Supply, LLC", "northbound outdoor supply"],
    ["The Home Depot", "home depot"],
    ["Lowe's", "lowes"],
    ["Macy's, Inc.", "macys"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeCompanyName(input)).toBe(expected);
  });

  test("strips stacked trailing suffixes", () => {
    expect(normalizeCompanyName("Acme Holdings, LLC")).toBe("acme");
    expect(normalizeCompanyName("Acme Group Holdings Corp.")).toBe("acme");
    expect(normalizeCompanyName("Acme Company, L.L.C.")).toBe("acme");
  });

  test("keeps suffix words that aren't at the end", () => {
    expect(normalizeCompanyName("Group Therapy Skincare Inc")).toBe("group therapy skincare");
    expect(normalizeCompanyName("Co-Op Market")).toBe("co op market");
  });

  test("only drops 'the' at the start", () => {
    expect(normalizeCompanyName("Over The Moon Bakery")).toBe("over the moon bakery");
  });

  test("strips accents and collapses whitespace", () => {
    expect(normalizeCompanyName("  Café   Olé  ")).toBe("cafe ole");
  });

  test("is case-insensitive and idempotent", () => {
    const once = normalizeCompanyName("FERNWOOD SKIN CO");
    expect(once).toBe("fernwood skin");
    expect(normalizeCompanyName(once)).toBe(once);
    expect(normalizeCompanyName("Fernwood Skin Co")).toBe(once);
  });
});

describe("normalizeDomain", () => {
  test.each([
    ["https://www.fernwoodskin.com/careers", "fernwoodskin.com"],
    ["http://northboundoutdoor.com", "northboundoutdoor.com"],
    ["https://halcyonfootwear.com/", "halcyonfootwear.com"],
    ["WWW.Example.COM", "example.com"],
    ["https://shop.example.com:8080/x?y=1", "shop.example.com"],
    ["example.com/about", "example.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  test.each([[null], [undefined], [""], ["   "], ["not a url"], ["localhost"]])("%s → null", (input) => {
    expect(normalizeDomain(input as string | null | undefined)).toBeNull();
  });
});
