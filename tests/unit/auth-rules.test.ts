import { describe, expect, test } from "vitest";
import { isAllowedEmail, isAuthDisabled, parseAllowedDomains } from "@/lib/auth-rules";

describe("parseAllowedDomains", () => {
  test("splits, trims, lowercases and drops a leading @", () => {
    expect(parseAllowedDomains(" Company.com, @partner.io ,,")).toEqual(["company.com", "partner.io"]);
  });

  test("unset or empty → no domains", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains("  ")).toEqual([]);
  });
});

describe("isAllowedEmail", () => {
  const domains = ["company.com"];

  test("allows an exact domain match, case-insensitive", () => {
    expect(isAllowedEmail("rep@company.com", domains)).toBe(true);
    expect(isAllowedEmail("Rep@COMPANY.com", domains)).toBe(true);
  });

  test.each([
    ["rep@evil-company.com"],
    ["rep@company.com.evil.io"],
    ["rep@sub.company.com"],
    ["company.com"],
    ["@company.com"],
    [""],
    [null],
    [undefined],
  ])("rejects %s", (email) => {
    expect(isAllowedEmail(email as string | null | undefined, domains)).toBe(false);
  });

  test("an empty allowlist lets nobody in", () => {
    expect(isAllowedEmail("rep@company.com", [])).toBe(false);
  });
});

describe("isAuthDisabled", () => {
  test("only with AUTH_DISABLED=true outside production", () => {
    expect(isAuthDisabled({ NODE_ENV: "development", AUTH_DISABLED: "true" })).toBe(true);
    expect(isAuthDisabled({ NODE_ENV: "development", AUTH_DISABLED: "1" })).toBe(false);
    expect(isAuthDisabled({ NODE_ENV: "development" })).toBe(false);
  });

  test("never in production", () => {
    expect(isAuthDisabled({ NODE_ENV: "production", AUTH_DISABLED: "true" })).toBe(false);
  });
});
