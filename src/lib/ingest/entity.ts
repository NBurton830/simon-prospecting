import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { brands, signals, type KeyPerson } from "@/lib/db/schema";
import type { SignalType } from "@/config/taxonomy";

const LEGAL_SUFFIXES = new Set([
  "inc",
  "llc",
  "ltd",
  "lp",
  "llp",
  "co",
  "corp",
  "corporation",
  "holdings",
  "group",
  "company",
]);

// Matching key for brands (SPEC §4.3):
// - lowercase, strip accents, "&" → "and";
// - apostrophes removed, other punctuation → space;
// - drop a leading "the" and any trailing legal suffixes
//   (inc, llc, ltd, lp, llp, co, corp, corporation, holdings, group, company);
// - collapse whitespace.
export function normalizeCompanyName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "") // "Lowe's" → "lowes", "L.L.C." → "llc"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length > 1 && words[0] === "the") words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// "https://www.Example.com:8080/careers" → "example.com". Only "www." is stripped. Not a hostname → null.
export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host = url.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0];
  host = host.slice(host.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

export type BrandCandidate =
  | { source: "SEC_FORM_D"; name: string; cik: string; hqState: string | null; keyPeople: KeyPerson[] }
  | { source: "JOB_LISTING"; name: string; domain: string | null };

export interface ResolvedBrand {
  id: string;
  excluded: boolean;
}

type BrandRow = typeof brands.$inferSelect;

async function findBy(db: Db, column: typeof brands.cik | typeof brands.domain | typeof brands.normalizedName, value: string) {
  const [row] = await db.select().from(brands).where(eq(column, value)).limit(1);
  return row as BrandRow | undefined;
}

async function findExisting(db: Db, c: BrandCandidate, normalizedName: string): Promise<BrandRow | undefined> {
  if (c.source === "SEC_FORM_D") {
    return (await findBy(db, brands.cik, c.cik)) ?? (await findBy(db, brands.normalizedName, normalizedName));
  }
  const domain = normalizeDomain(c.domain);
  return (domain ? await findBy(db, brands.domain, domain) : undefined) ?? (await findBy(db, brands.normalizedName, normalizedName));
}

// Fills identifiers and Form D details the matched brand is missing; never overwrites existing values.
async function fillMissing(db: Db, row: BrandRow, c: BrandCandidate): Promise<void> {
  const patch: Partial<typeof brands.$inferInsert> = {};
  if (c.source === "SEC_FORM_D") {
    if (!row.cik) patch.cik = c.cik;
    if (!row.legalName) patch.legalName = c.name;
    if (!row.hqState && c.hqState) patch.hqState = c.hqState;
    if (row.keyPeople.length === 0 && c.keyPeople.length > 0) patch.keyPeople = c.keyPeople;
  } else {
    const domain = normalizeDomain(c.domain);
    if (!row.domain && domain) patch.domain = domain;
  }
  if (Object.keys(patch).length === 0) return;
  // Another brand may already hold this cik/domain; matching is best-effort, so skip the fill then.
  await db
    .update(brands)
    .set(patch)
    .where(eq(brands.id, row.id))
    .catch(() => undefined);
}

// Form D: match cik, then normalized name. Job: match domain, then normalized name.
// Otherwise upsert a stub. Fills a missing cik/domain on a matched brand. Safe to call concurrently.
export async function resolveBrand(db: Db, candidate: BrandCandidate): Promise<ResolvedBrand> {
  const normalizedName = normalizeCompanyName(candidate.name) || candidate.name.trim().toLowerCase();

  const existing = await findExisting(db, candidate, normalizedName);
  if (existing) {
    await fillMissing(db, existing, candidate);
    return { id: existing.id, excluded: existing.excluded };
  }

  const values: typeof brands.$inferInsert =
    candidate.source === "SEC_FORM_D"
      ? {
          name: candidate.name,
          normalizedName,
          legalName: candidate.name,
          cik: candidate.cik,
          hqState: candidate.hqState,
          keyPeople: candidate.keyPeople,
        }
      : { name: candidate.name, normalizedName, domain: normalizeDomain(candidate.domain) };

  const [inserted] = await db
    .insert(brands)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: brands.id, excluded: brands.excluded });
  if (inserted) return inserted;

  // Lost a race with a concurrent insert of the same company.
  const winner = await findExisting(db, candidate, normalizedName);
  if (!winner) throw new Error(`Could not resolve brand for "${candidate.name}"`);
  return { id: winner.id, excluded: winner.excluded };
}

export interface NewSignal {
  signalType: SignalType;
  externalId: string;
  sourceUrl: string;
  companyNameRaw: string;
  signalDate: string; // YYYY-MM-DD
  amountUsd?: number | null;
  title?: string | null;
  rawPayload: unknown;
}

// ON CONFLICT (signal_type, external_id) DO NOTHING. Signals for excluded brands are inserted as SKIPPED.
export async function insertSignal(db: Db, brand: ResolvedBrand, signal: NewSignal): Promise<"inserted" | "duplicate"> {
  const inserted = await db
    .insert(signals)
    .values({
      brandId: brand.id,
      signalType: signal.signalType,
      externalId: signal.externalId,
      sourceUrl: signal.sourceUrl,
      companyNameRaw: signal.companyNameRaw.slice(0, 255),
      signalDate: signal.signalDate,
      amountUsd: signal.amountUsd ?? null,
      title: signal.title?.slice(0, 255) ?? null,
      rawPayload: signal.rawPayload,
      status: brand.excluded ? "SKIPPED" : "PENDING",
    })
    .onConflictDoNothing({ target: [signals.signalType, signals.externalId] })
    .returning({ id: signals.id });
  return inserted.length > 0 ? "inserted" : "duplicate";
}

// Marks the brand excluded and moves its PENDING signals to SKIPPED.
export async function markBrandExcluded(db: Db, brandId: string, reason: string): Promise<void> {
  await db.update(brands).set({ excluded: true, exclusionReason: reason }).where(eq(brands.id, brandId));
  await db
    .update(signals)
    .set({ status: "SKIPPED" })
    .where(and(eq(signals.brandId, brandId), eq(signals.status, "PENDING")));
}
