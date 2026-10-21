import type { ProspectStatus } from "@/config/taxonomy";
import type { ProspectRow } from "./queries";

export interface ProspectFilters {
  search: string;
  categories: string[]; // empty = all
  minScore: number;
  statuses: ProspectStatus[]; // empty = all
  newOnly: boolean;
}

export const DEFAULT_FILTERS: ProspectFilters = {
  search: "",
  categories: [],
  minScore: 1,
  statuses: ["NEW", "REVIEWED", "CONTACTED"],
  newOnly: false,
};

export type SortKey = "score" | "lastSignal" | "name";
export type SortDir = "asc" | "desc";

// Search matches when every word appears in the brand name, description, hiring roles or pitch.
export function filterProspects(rows: ProspectRow[], f: ProspectFilters): ProspectRow[] {
  const terms = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((p) => {
    if (p.readinessScore < f.minScore) return false;
    if (f.categories.length && !f.categories.includes(p.category ?? "")) return false;
    if (f.statuses.length && !f.statuses.includes(p.status)) return false;
    if (f.newOnly && !p.hasNewActivity) return false;
    if (!terms.length) return true;
    const haystack = [p.brandName, p.description ?? "", ...p.keyHiringRoles, p.pitchAngle].join(" ").toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

export function sortProspects(rows: ProspectRow[], key: SortKey, dir: SortDir): ProspectRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const compare = (a: ProspectRow, b: ProspectRow): number => {
    if (key === "score") return a.readinessScore - b.readinessScore || a.brandName.localeCompare(b.brandName);
    if (key === "lastSignal") return a.lastSignalAt.localeCompare(b.lastSignalAt) || b.readinessScore - a.readinessScore;
    return a.brandName.localeCompare(b.brandName, "en", { sensitivity: "base" });
  };
  return [...rows].sort((a, b) => sign * compare(a, b));
}

// Distinct categories present in the data, for the filter menu.
export function categoriesIn(rows: ProspectRow[]): string[] {
  return [...new Set(rows.map((p) => p.category).filter((c): c is string => !!c))].sort();
}
