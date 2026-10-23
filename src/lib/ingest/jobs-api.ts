import { EXCLUDED_EMPLOYERS, HIGH_VOLUME_EMPLOYER_THRESHOLD } from "@/config/excluded-employers";
import { isSeniorOrGrowthTitle, RETAIL_TITLE_PATTERN } from "@/config/job-queries";
import { MAX_DESCRIPTION_CHARS } from "@/lib/analysis/prompt";
import { toEpochDay } from "@/lib/dates";
import { normalizeCompanyName } from "./entity";

// JSearch moved search from /search (data: [...]) to /search-v2 (data: { jobs, cursor }) in Oct 2026.
export const JSEARCH_URL = "https://jsearch.p.rapidapi.com/search-v2";
export const JSEARCH_HOST = "jsearch.p.rapidapi.com";

export interface JobListing {
  jobId: string;
  employerName: string;
  employerWebsite: string | null;
  title: string;
  city: string | null;
  state: string | null;
  applyLink: string;
  postedAt: string | null; // ISO timestamp
  description: string; // truncated to MAX_DESCRIPTION_CHARS
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// Maps a JSearch response to listings: /search-v2 (`data.jobs`) or the older /search (`data` array).
// Throws when neither holds an array.
export function parseJSearchResponse(json: unknown): JobListing[] {
  const raw = (json as { data?: unknown } | null)?.data;
  const data = Array.isArray(raw) ? raw : (raw as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(data)) {
    const message = str((json as { message?: unknown } | null)?.message);
    throw new Error(`Unexpected JSearch response${message ? `: ${message}` : ""}`);
  }
  return data.map((j: Record<string, unknown>) => ({
    jobId: String(j.job_id),
    employerName: str(j.employer_name) ?? "Unknown employer",
    employerWebsite: str(j.employer_website),
    title: str(j.job_title) ?? "",
    city: str(j.job_city),
    state: str(j.job_state),
    applyLink: str(j.job_apply_link) ?? "",
    postedAt: str(j.job_posted_at_datetime_utc),
    description: (str(j.job_description) ?? "").slice(0, MAX_DESCRIPTION_CHARS),
  }));
}

// Request URL for one query: country=us, date_posted=3days, num_pages=1.
export function jsearchUrl(query: string): string {
  const url = new URL(JSEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("num_pages", "1");
  url.searchParams.set("country", "us");
  url.searchParams.set("date_posted", "3days");
  return url.href;
}

export interface JobFilterResult {
  kept: JobListing[];
  dropped: { duplicate: number; blocklisted: number; titleMismatch: number; highVolume: number };
  highVolumeEmployers: string[]; // employer names as first seen
}

// In order: de-duplicate by jobId, drop blocklisted employers (compared after normalizeCompanyName),
// drop titles not matching the retail pattern or naming entry-level store roles, then drop every listing from employers with more
// than `highVolumeThreshold` remaining listings.
export function filterJobListings(
  listings: JobListing[],
  opts: { excludedEmployers?: readonly string[]; highVolumeThreshold?: number; titlePattern?: RegExp } = {},
): JobFilterResult {
  const {
    excludedEmployers = EXCLUDED_EMPLOYERS,
    highVolumeThreshold = HIGH_VOLUME_EMPLOYER_THRESHOLD,
    titlePattern = RETAIL_TITLE_PATTERN,
  } = opts;
  const blocklist = new Set(excludedEmployers.map(normalizeCompanyName));
  const dropped = { duplicate: 0, blocklisted: 0, titleMismatch: 0, highVolume: 0 };

  const seen = new Set<string>();
  const candidates: JobListing[] = [];
  for (const listing of listings) {
    if (seen.has(listing.jobId)) {
      dropped.duplicate++;
    } else if ((seen.add(listing.jobId), blocklist.has(normalizeCompanyName(listing.employerName)))) {
      dropped.blocklisted++;
    } else if (!titlePattern.test(listing.title) || !isSeniorOrGrowthTitle(listing.title)) {
      dropped.titleMismatch++;
    } else {
      candidates.push(listing);
    }
  }

  const perEmployer = new Map<string, { name: string; count: number }>();
  for (const listing of candidates) {
    const key = normalizeCompanyName(listing.employerName);
    const entry = perEmployer.get(key) ?? { name: listing.employerName, count: 0 };
    entry.count++;
    perEmployer.set(key, entry);
  }
  const highVolume = new Set([...perEmployer].filter(([, e]) => e.count > highVolumeThreshold).map(([key]) => key));

  const kept = candidates.filter((listing) => {
    if (!highVolume.has(normalizeCompanyName(listing.employerName))) return true;
    dropped.highVolume++;
    return false;
  });

  return { kept, dropped, highVolumeEmployers: [...highVolume].map((key) => perEmployer.get(key)!.name) };
}

// Jobs run on days where (days since 1970-01-01 UTC) % everyNDays === 0. everyNDays < 1 is treated as 1.
export function shouldRunJobs(today: string, everyNDays: number): boolean {
  const n = Math.max(1, Math.floor(everyNDays) || 1);
  return toEpochDay(today) % n === 0;
}

// The posting date (UTC) as YYYY-MM-DD, or `today` when the listing has none.
export function jobSignalDate(listing: JobListing, today: string): string {
  const ms = listing.postedAt ? Date.parse(listing.postedAt) : NaN;
  return Number.isNaN(ms) ? today : new Date(ms).toISOString().slice(0, 10);
}
