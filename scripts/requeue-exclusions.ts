// Re-queues brands Claude excluded under the old, stricter relevance rule so the next pipeline run
// re-analyzes them. Dry run by default.
// Usage: npm run requeue                    # list what would be re-queued
//        npm run requeue -- --apply         # do it
//        npm run requeue -- --pattern "restaurant" --apply
//        npm run requeue -- --include-all       # also re-queue reasons naming real estate, chains, etc.
import { createDb } from "@/lib/db";
import { DEFAULT_REQUEUE_PATTERN, findRequeueCandidates, KEEP_EXCLUDED_PATTERN, requeueExcludedBrands } from "@/lib/pipeline/requeue";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const patternAt = args.indexOf("--pattern");
  const pattern = patternAt >= 0 ? args[patternAt + 1] : DEFAULT_REQUEUE_PATTERN;

  const db = await createDb();
  const keep = args.includes("--include-all") ? null : KEEP_EXCLUDED_PATTERN;
  const candidates = await findRequeueCandidates(db, pattern, keep);
  console.log(`${candidates.length} excluded brand(s) match /${pattern}/i${keep ? ` (keeping those matching /${keep}/i excluded)` : ""}:`);
  for (const c of candidates) console.log(`  - ${c.name}: ${(c.exclusionReason ?? "").slice(0, 100)}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to re-queue them.");
    return;
  }
  const result = await requeueExcludedBrands(db, candidates.map((c) => c.id));
  console.log(`\nRe-queued ${result.brands} brand(s), ${result.signals} signal(s); restored ${result.prospectsRestored} prospect(s).`);
  console.log("They'll be analyzed on the next pipeline run, within MAX_ANALYSES_PER_RUN.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
