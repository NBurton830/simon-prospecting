import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { pipelineRuns, syncState } from "@/lib/db/schema";
import { JOB_QUERIES } from "@/config/job-queries";
import { insertSignal, markBrandExcluded, normalizeDomain, resolveBrand } from "@/lib/ingest/entity";
import {
  filterJobListings,
  jobSignalDate,
  JSEARCH_HOST,
  jsearchUrl,
  parseJSearchResponse,
  shouldRunJobs,
  type JobListing,
} from "@/lib/ingest/jobs-api";
import {
  businessDatesToSync,
  dailyIndexUrl,
  filingIndexUrl,
  formDAmountUsd,
  formDDocumentUrl,
  nonConsumerReason,
  parseDailyIndex,
  parseFormD,
  passesFormDFilters,
} from "@/lib/ingest/sec-edgar";

export const EDGAR_CURSOR_KEY = "edgar_last_index_date";
const SEC_REQUEST_INTERVAL_MS = 125; // 8 requests/second, under the SEC's 10/second limit
const SEC_RETRIES = 3;

export interface SyncDeps {
  fetch: typeof fetch;
  today: string; // YYYY-MM-DD (UTC)
  secUserAgent: string;
  rapidApiKey: string | null; // null → jobs source skipped
  minOffering: number;
  jobsEveryNDays: number;
  sleep?: (ms: number) => Promise<void>; // SEC throttle; tests pass a no-op
}

export interface SourceResult {
  status: "ok" | "skipped" | "failed";
  inserted: number;
  duplicates: number;
  filtered: number; // Form D: failed filters; jobs: dropped by filterJobListings
  error?: string;
}

export interface SyncResult {
  runId: string;
  sec: SourceResult & { datesProcessed: string[] };
  jobs: SourceResult & { highVolumeEmployers: string[] };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function setCursor(db: Db, value: string) {
  await db
    .insert(syncState)
    .values({ key: EDGAR_CURSOR_KEY, value })
    .onConflictDoUpdate({ target: syncState.key, set: { value } });
}

async function syncSec(db: Db, deps: SyncDeps): Promise<SyncResult["sec"]> {
  const result: SyncResult["sec"] = { status: "ok", inserted: 0, duplicates: 0, filtered: 0, datesProcessed: [] };
  const sleep = deps.sleep ?? defaultSleep;

  // Throttled GET with the SEC User-Agent; retries 429/5xx with exponential backoff.
  const secGet = async (url: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      await sleep(SEC_REQUEST_INTERVAL_MS);
      const res = await deps.fetch(url, { headers: { "User-Agent": deps.secUserAgent } });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= SEC_RETRIES) return res;
      await sleep(1000 * 2 ** attempt);
    }
  };

  try {
    const [cursor] = await db.select().from(syncState).where(eq(syncState.key, EDGAR_CURSOR_KEY));
    for (const date of businessDatesToSync(cursor?.value ?? null, deps.today)) {
      const indexRes = await secGet(dailyIndexUrl(date));
      if (indexRes.status !== 404) {
        if (!indexRes.ok) throw new Error(`EDGAR index ${date}: HTTP ${indexRes.status}`);
        const entries = parseDailyIndex(await indexRes.text()).filter((e) => e.formType === "D");
        for (const entry of entries) {
          const docRes = await secGet(formDDocumentUrl(entry));
          if (docRes.status === 404) {
            result.filtered++; // filing without a primary_doc.xml
            continue;
          }
          if (!docRes.ok) throw new Error(`Form D ${entry.accessionNumber}: HTTP ${docRes.status}`);
          const filing = parseFormD(await docRes.text());
          if (!passesFormDFilters(filing, deps.minOffering) || nonConsumerReason(filing)) {
            result.filtered++;
            continue;
          }
          const brand = await resolveBrand(db, {
            source: "SEC_FORM_D",
            name: filing.issuerName,
            cik: filing.cik,
            hqState: filing.hqState,
            keyPeople: filing.relatedPersons,
          });
          const outcome = await insertSignal(db, brand, {
            signalType: "SEC_FORM_D",
            externalId: entry.accessionNumber,
            sourceUrl: filingIndexUrl(entry),
            companyNameRaw: filing.issuerName,
            signalDate: entry.dateFiled,
            amountUsd: formDAmountUsd(filing),
            title: null,
            rawPayload: filing,
          });
          result[outcome === "inserted" ? "inserted" : "duplicates"]++;
        }
      }
      result.datesProcessed.push(date);
      await setCursor(db, date);
    }
  } catch (err) {
    result.status = "failed";
    result.error = errorMessage(err);
  }
  return result;
}

async function syncJobs(db: Db, deps: SyncDeps): Promise<SyncResult["jobs"]> {
  const result: SyncResult["jobs"] = { status: "ok", inserted: 0, duplicates: 0, filtered: 0, highVolumeEmployers: [] };
  if (!deps.rapidApiKey || !shouldRunJobs(deps.today, deps.jobsEveryNDays)) return { ...result, status: "skipped" };

  try {
    const all: JobListing[] = [];
    for (const query of JOB_QUERIES) {
      const res = await deps.fetch(jsearchUrl(query), {
        headers: { "X-RapidAPI-Key": deps.rapidApiKey, "X-RapidAPI-Host": JSEARCH_HOST },
      });
      if (!res.ok) throw new Error(`JSearch "${query}": HTTP ${res.status}`);
      all.push(...parseJSearchResponse(await res.json()));
    }

    const filtered = filterJobListings(all);
    result.filtered = all.length - filtered.kept.length;
    result.highVolumeEmployers = filtered.highVolumeEmployers;

    for (const name of filtered.highVolumeEmployers) {
      const website = all.find((l) => l.employerName === name)?.employerWebsite ?? null;
      const brand = await resolveBrand(db, { source: "JOB_LISTING", name, domain: normalizeDomain(website) });
      await markBrandExcluded(db, brand.id, "high-volume employer");
    }

    for (const listing of filtered.kept) {
      const brand = await resolveBrand(db, {
        source: "JOB_LISTING",
        name: listing.employerName,
        domain: normalizeDomain(listing.employerWebsite),
      });
      const outcome = await insertSignal(db, brand, {
        signalType: "JOB_LISTING",
        externalId: listing.jobId,
        sourceUrl: listing.applyLink,
        companyNameRaw: listing.employerName,
        signalDate: jobSignalDate(listing, deps.today),
        title: listing.title,
        rawPayload: listing,
      });
      result[outcome === "inserted" ? "inserted" : "duplicates"]++;
    }
  } catch (err) {
    result.status = "failed";
    result.error = errorMessage(err);
  }
  return result;
}

// SPEC §4. Runs both sources with Promise.allSettled and writes a pipeline_runs row (job "sync"):
// SUCCEEDED when no source failed, PARTIAL when one failed, FAILED when both failed.
// SEC: for each date from businessDatesToSync(cursor), fetch the index (404 → skip the date),
//   fetch primary_doc.xml for form "D" rows, ingest those passing the filters, then advance the cursor.
//   Any other error stops the SEC source without advancing past the failed date.
//   Every SEC request sends User-Agent: secUserAgent.
// Jobs: when rapidApiKey is set and shouldRunJobs(today), one request per JOB_QUERIES entry with
//   X-RapidAPI-Key / X-RapidAPI-Host headers; filterJobListings over the combined results;
//   high-volume employers are resolved and marked excluded ("high-volume employer").
export async function runSync(db: Db, deps: SyncDeps): Promise<SyncResult> {
  const [run] = await db.insert(pipelineRuns).values({ job: "sync" }).returning({ id: pipelineRuns.id });

  const failedSource = (err: unknown) => ({
    status: "failed" as const,
    inserted: 0,
    duplicates: 0,
    filtered: 0,
    error: errorMessage(err),
  });
  const [secSettled, jobsSettled] = await Promise.allSettled([syncSec(db, deps), syncJobs(db, deps)]);
  const sec = secSettled.status === "fulfilled" ? secSettled.value : { ...failedSource(secSettled.reason), datesProcessed: [] };
  const jobs = jobsSettled.status === "fulfilled" ? jobsSettled.value : { ...failedSource(jobsSettled.reason), highVolumeEmployers: [] };

  const failures = [
    ...(sec.status === "failed" ? [{ source: "sec", error: sec.error }] : []),
    ...(jobs.status === "failed" ? [{ source: "jobs", error: jobs.error }] : []),
  ];
  await db
    .update(pipelineRuns)
    .set({
      status: failures.length === 0 ? "SUCCEEDED" : failures.length === 1 ? "PARTIAL" : "FAILED",
      finishedAt: new Date(),
      stats: { sec, jobs },
      errors: failures,
    })
    .where(eq(pipelineRuns.id, run.id));

  return { runId: run.id, sec, jobs };
}
