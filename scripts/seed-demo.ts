// Fills a LOCAL database with fictional prospects for trying the dashboard.
// Usage: DATABASE_URL=pglite:./.data/demo npm run db:migrate && DATABASE_URL=pglite:./.data/demo npx tsx scripts/seed-demo.ts
import { CATEGORIES, EXPANSION_STAGES, MEDIA_FORMATS, PROSPECT_STATUSES } from "@/config/taxonomy";
import { computeScore } from "@/lib/analysis/score";
import { buildRecentSignalSummary } from "@/lib/analysis/signal-summary";
import { createDb } from "@/lib/db";
import { brands, pipelineRuns, prospects, signals } from "@/lib/db/schema";
import { addDays, utcDate } from "@/lib/dates";
import { normalizeCompanyName } from "@/lib/ingest/entity";

const COUNT = 220;
const FIRST = ["Fernwood", "Lumen", "Halcyon", "Northbound", "Juniper", "Marlow", "Saltbox", "Wren", "Copperline", "Bramble", "Kestrel", "Tidewater", "Hollis", "Ember", "Quarry", "Sable", "Meadowlark", "Ridgeway", "Calla", "Ostara", "Pinecrest", "Larkspur"];
const SECOND = ["Skin Co", "Candle Co", "Footwear", "Outdoor Supply", "Apparel", "Home", "Pet Goods", "Tea Co", "Jewelry", "Kids", "Beauty", "Wellness", "Coffee Roasters", "Activewear"];
const STATES = ["TX", "CA", "NY", "CO", "OR", "FL", "IL", "GA", "WA", "MA"];
const ROLES = ["Director of Retail", "Head of Retail", "Opening Store Manager", "Retail Experiential Manager", "Director of Store Development", "Pop-up Shop Manager"];

// Deterministic PRNG so every seed looks the same.
let state = 42;
const rand = () => ((state = (state * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("pglite:")) {
    throw new Error("seed-demo only writes to a local pglite: database, never to Neon. Set DATABASE_URL=pglite:./.data/demo");
  }
  const db = await createDb(url);
  const today = utcDate(new Date());
  const used = new Set<string>();

  for (let i = 0; i < COUNT; i++) {
    let name = `${pick(FIRST)} ${pick(SECOND)}`;
    while (used.has(normalizeCompanyName(name))) name = `${pick(FIRST)} ${pick(SECOND)} ${int(2, 99)}`;
    used.add(normalizeCompanyName(name));

    const category = pick(CATEGORIES.slice(0, -1));
    const slug = normalizeCompanyName(name).replace(/ /g, "");
    const [brand] = await db
      .insert(brands)
      .values({
        name,
        normalizedName: normalizeCompanyName(name),
        legalName: `${name}, Inc.`,
        domain: `${slug}.example`,
        category,
        description: `${name} is a fictional ${category.toLowerCase()} brand used for demo data.`,
        hqState: pick(STATES),
        keyPeople: [{ name: "Demo Founder", relationship: "Executive Officer, Director" }],
      })
      .returning();

    const sigs: (typeof signals.$inferInsert)[] = [];
    if (rand() < 0.7) {
      const amount = pick([2_500_000, 4_000_000, 8_500_000, 12_000_000, 30_000_000]);
      sigs.push({
        brandId: brand.id,
        signalType: "SEC_FORM_D",
        externalId: `demo-formd-${i}`,
        sourceUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
        companyNameRaw: `${name}, Inc.`,
        signalDate: addDays(today, -int(5, 200)),
        amountUsd: amount,
        rawPayload: { industryGroupType: "Retailing", totalOfferingAmount: amount, totalAmountSold: Math.round(amount * 0.7), dateOfFirstSale: null },
        status: "PROCESSED",
      });
    }
    const roles = int(rand() < 0.3 ? 0 : 1, 3);
    for (let r = 0; r < roles; r++) {
      const title = pick(ROLES);
      sigs.push({
        brandId: brand.id,
        signalType: "JOB_LISTING",
        externalId: `demo-job-${i}-${r}`,
        sourceUrl: "https://example.com/jobs",
        companyNameRaw: name,
        signalDate: addDays(today, -int(0, 60)),
        title,
        rawPayload: { title, city: "Austin", state: "TX", description: `${name} is hiring a ${title} to lead its first stores and mall pop-ups. (Demo data.)` },
        status: "PROCESSED",
      });
    }
    if (sigs.length === 0) continue;
    await db.insert(signals).values(sigs);

    const claude = { retail_hiring_score: roles ? int(10, 30) : 0, physical_stage_score: int(3, 20), category_fit_score: int(4, 10) };
    const scoring = sigs.map((s) => ({ type: s.signalType as "SEC_FORM_D" | "JOB_LISTING", date: s.signalDate as string, amountUsd: s.amountUsd ?? null }));
    const score = computeScore(scoring, claude, today);
    const lastSignalAt = scoring.reduce((m, s) => (s.date > m ? s.date : m), "0000-00-00");
    const status = rand() < 0.65 ? "NEW" : pick(PROSPECT_STATUSES);
    const format = [...MEDIA_FORMATS].sort(() => rand() - 0.5).slice(0, int(1, 3));
    await db.insert(prospects).values({
      brandId: brand.id,
      readinessScore: score.total,
      scoreBreakdown: score.breakdown,
      scoreRationale: "Demo data: scores are random within the rubric's ranges.",
      fundingSummary: sigs[0].signalType === "SEC_FORM_D" ? `Raised per SEC Form D (demo)` : "No disclosed funding",
      recentSignalSummary: buildRecentSignalSummary(scoring, today),
      expansionStage: pick(EXPANSION_STAGES),
      keyHiringRoles: sigs.filter((s) => s.title).map((s) => s.title as string),
      targetDemographics: "Demo audience: shoppers aged 25–44.",
      pitchAngle: `${name} is entering physical retail; a concourse pop-up lets them test mall traffic before signing a lease. (Demo pitch.)`,
      recommendedFormats: format,
      status,
      statusChangedAt: new Date(`${addDays(today, -int(1, 40))}T12:00:00Z`),
      lastSignalAt,
      model: "demo",
    });
  }

  await db.insert(pipelineRuns).values([
    { job: "sync", status: "SUCCEEDED", finishedAt: new Date(), stats: { sec: { inserted: 46 }, jobs: { status: "skipped" } } },
    { job: "analyze", status: "PARTIAL", finishedAt: new Date(), stats: { analyzed: 37, carried_over: 9, stop_reason: "usage_limit" } },
  ]);
  console.log(`Seeded ${COUNT} fictional brands into ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
