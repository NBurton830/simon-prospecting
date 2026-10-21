import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface TestDb {
  db: Db;
  reset(): Promise<void>;
  close(): Promise<void>;
}

// In-process Postgres with the real migrations applied. One per test file; reset() between tests.
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    db: db as unknown as Db,
    async reset() {
      await db.execute(sql`TRUNCATE brands, signals, prospects, pipeline_runs, sync_state CASCADE`);
    },
    async close() {
      await client.close();
    },
  };
}
