import { XMLParser } from "fast-xml-parser";
import { FORM_D_INDUSTRY_GROUPS } from "@/config/taxonomy";
import type { KeyPerson } from "@/lib/db/schema";
import { addDays, isWeekday } from "@/lib/dates";

const EDGAR = "https://www.sec.gov/Archives/edgar";
const FORM_TYPE_WIDTH = 17;

export interface DailyIndexEntry {
  formType: string; // e.g. "D", "D/A", "DEF 14A"
  companyName: string;
  cik: string; // no leading zeros
  dateFiled: string; // YYYY-MM-DD, from the row (can differ from the index date)
  fileName: string; // edgar/data/{cik}/{accession}.txt
  accessionNumber: string; // with dashes, e.g. 0002156132-26-000001
}

// Parses every data row of a daily form index (form type column is 17 characters wide).
export function parseDailyIndex(text: string): DailyIndexEntry[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{20,}/.test(l));
  if (start === -1) return [];

  const entries: DailyIndexEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const formType = line.slice(0, FORM_TYPE_WIDTH).trim();
    const m = /^(.*\S)\s+(\d+)\s+(\d{4})(\d{2})(\d{2})\s+(\S+)\s*$/.exec(line.slice(FORM_TYPE_WIDTH));
    if (!formType || !m) continue;
    const fileName = m[6];
    entries.push({
      formType,
      companyName: m[1].trim(),
      cik: stripZeros(m[2]),
      dateFiled: `${m[3]}-${m[4]}-${m[5]}`,
      fileName,
      accessionNumber: fileName.slice(fileName.lastIndexOf("/") + 1).replace(/\.txt$/, ""),
    });
  }
  return entries;
}

// "2026-10-20" → https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261020.idx
export function dailyIndexUrl(date: string): string {
  const [year, month] = date.split("-").map(Number);
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${EDGAR}/daily-index/${year}/QTR${quarter}/form.${date.replace(/-/g, "")}.idx`;
}

function filingFolder(entry: Pick<DailyIndexEntry, "cik" | "accessionNumber">): string {
  return `${EDGAR}/data/${entry.cik}/${entry.accessionNumber.replace(/-/g, "")}/`;
}

// https://www.sec.gov/Archives/edgar/data/{cik}/{accession without dashes}/primary_doc.xml
export function formDDocumentUrl(entry: Pick<DailyIndexEntry, "cik" | "accessionNumber">): string {
  return `${filingFolder(entry)}primary_doc.xml`;
}

// https://www.sec.gov/Archives/edgar/data/{cik}/{accession without dashes}/ (stored as source_url)
export function filingIndexUrl(entry: Pick<DailyIndexEntry, "cik" | "accessionNumber">): string {
  return filingFolder(entry);
}

export interface FormDFiling {
  cik: string; // no leading zeros
  issuerName: string; // XML entities decoded
  hqState: string | null; // two-letter US/territory code; non-US codes like "A1" → null
  entityType: string | null;
  industryGroupType: string;
  isAmendment: boolean;
  totalOfferingAmount: number | null; // null for "Indefinite"
  totalAmountSold: number | null;
  dateOfFirstSale: string | null; // null when yet to occur
  relatedPersons: KeyPerson[]; // name skips placeholder first names ("N/A", "-"); relationships joined with ", "
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep CIK leading zeros and "Indefinite" as strings
  trimValues: true,
  isArray: (name) => name === "relatedPersonInfo" || name === "relationship",
});

interface RelatedPersonXml {
  relatedPersonName?: { firstName?: unknown; middleName?: unknown; lastName?: unknown };
  relatedPersonRelationshipList?: { relationship?: unknown[] };
}

const PLACEHOLDER_NAMES = new Set(["n/a", "na", "-", "--", "none"]);

const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const stripZeros = (cik: string) => cik.replace(/^0+(?=\d)/, "");

function amount(v: unknown): number | null {
  const s = text(v).replace(/[$,]/g, "");
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null; // "Indefinite" or blank
  return Number(s);
}

export function parseFormD(xml: string): FormDFiling {
  const doc = parser.parse(xml)?.edgarSubmission;
  if (!doc?.primaryIssuer || !doc?.offeringData) throw new Error("Not a Form D submission");
  const issuer = doc.primaryIssuer;
  const offering = doc.offeringData;
  const state = text(issuer.issuerAddress?.stateOrCountry);
  const firstSale = text(offering.typeOfFiling?.dateOfFirstSale?.value);

  const relatedPersons: KeyPerson[] = (doc.relatedPersonsList?.relatedPersonInfo ?? []).map((p: RelatedPersonXml) => {
    const n = p.relatedPersonName ?? {};
    const name = [n.firstName, n.middleName, n.lastName]
      .map(text)
      .filter((part) => part && !PLACEHOLDER_NAMES.has(part.toLowerCase()))
      .join(" ");
    const relationship = (p.relatedPersonRelationshipList?.relationship ?? []).map(text).filter(Boolean).join(", ");
    return { name, relationship };
  });

  return {
    cik: stripZeros(text(issuer.cik)),
    issuerName: text(issuer.entityName),
    hqState: /^[A-Z]{2}$/.test(state) ? state : null,
    entityType: text(issuer.entityType) || null,
    industryGroupType: text(offering.industryGroup?.industryGroupType),
    isAmendment: text(offering.typeOfFiling?.newOrAmendment?.isAmendment).toLowerCase() === "true",
    totalOfferingAmount: amount(offering.offeringSalesAmounts?.totalOfferingAmount),
    totalAmountSold: amount(offering.offeringSalesAmounts?.totalAmountSold),
    dateOfFirstSale: /^\d{4}-\d{2}-\d{2}$/.test(firstSale) ? firstSale : null,
    relatedPersons,
  };
}

// max(totalOfferingAmount, totalAmountSold), treating null as 0.
export function formDAmountUsd(filing: FormDFiling): number {
  return Math.max(filing.totalOfferingAmount ?? 0, filing.totalAmountSold ?? 0);
}

// Not an amendment, industry group in FORM_D_INDUSTRY_GROUPS, amount >= minOffering.
export function passesFormDFilters(filing: FormDFiling, minOffering: number): boolean {
  return (
    !filing.isAmendment &&
    (FORM_D_INDUSTRY_GROUPS as readonly string[]).includes(filing.industryGroupType) &&
    formDAmountUsd(filing) >= minOffering
  );
}

// Issuer names that are almost never consumer brands. Deliberately narrow: "energy", "gold", "silver",
// "group" and "holdings" are left out because consumer brands and places use them
// (energy drinks, jewelers, "Silver Spring", "Acme Group").
const NON_CONSUMER_NAME =
  /\b(fund|funds|ventures?|capital|partners|investors|investments?|equity|spv|opportunity zone|oz|reit|realty|properties|mining|minerals?|metals?|lithium|uranium|petroleum|biotech|biosciences|therapeutics|pharmaceuticals?|topco|bidco|acquisition corp)\b/i;

// Why a filing that passed the filters still shouldn't reach Claude, or null. Saves analyses on
// funds, mining companies and holding vehicles that file under "Other" or "Manufacturing".
export function nonConsumerReason(filing: FormDFiling): string | null {
  const match = NON_CONSUMER_NAME.exec(filing.issuerName);
  if (match) return `issuer name suggests a non-consumer entity ("${match[0]}")`;
  if (filing.entityType === "Limited Partnership") return "limited partnership (fund or holding structure)";
  return null;
}

// Business days (Mon–Fri, UTC) after lastIndexDate up to yesterday, oldest first, at most maxDays.
// lastIndexDate null (first run) → the `firstRunLookback` business days before today.
export function businessDatesToSync(
  lastIndexDate: string | null,
  today: string,
  opts: { firstRunLookback?: number; maxDays?: number } = {},
): string[] {
  const { firstRunLookback = 5, maxDays = 30 } = opts;
  const yesterday = addDays(today, -1);
  const dates: string[] = [];

  if (lastIndexDate === null) {
    for (let d = yesterday; dates.length < firstRunLookback; d = addDays(d, -1)) {
      if (isWeekday(d)) dates.unshift(d);
    }
    return dates.slice(0, maxDays);
  }

  for (let d = addDays(lastIndexDate, 1); d <= yesterday && dates.length < maxDays; d = addDays(d, 1)) {
    if (isWeekday(d)) dates.push(d);
  }
  return dates;
}
