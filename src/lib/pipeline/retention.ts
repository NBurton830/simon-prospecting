import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { addDays } from "@/lib/dates";

const DESCRIPTION_RETENTION_DAYS = 180;
const EXCLUDED_SIGNAL_RETENTION_DAYS = 90;

const rowCount = (result: unknown) => (result as { rows: unknown[] }).rows.length;

// SPEC §11: removes job_description from raw_payload on JOB_LISTING signals older than 180 days,
// and deletes signals of excluded brands older than 90 days (by signal_date).
export async function runRetention(
  db: Db,
  today: string,
): Promise<{ descriptionsStripped: number; signalsDeleted: number }> {
  const stripped = await db.execute(sql`
    UPDATE signals SET raw_payload = raw_payload - 'description'
    WHERE signal_type = 'JOB_LISTING'
      AND signal_date < ${addDays(today, -DESCRIPTION_RETENTION_DAYS)}::date
      AND raw_payload ->> 'description' IS NOT NULL
    RETURNING id
  `);
  const deleted = await db.execute(sql`
    DELETE FROM signals s USING brands b
    WHERE s.brand_id = b.id AND b.excluded
      AND s.signal_date < ${addDays(today, -EXCLUDED_SIGNAL_RETENTION_DAYS)}::date
    RETURNING s.id
  `);
  return { descriptionsStripped: rowCount(stripped), signalsDeleted: rowCount(deleted) };
}
