import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// Any Drizzle Postgres database with this schema: Neon in production, PGlite locally and in tests.
// Pipeline code takes a Db argument instead of importing a global client, and must not
// use interactive transactions (neon-http doesn't support them).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const PGLITE_PREFIX = "pglite:";

// DATABASE_URL is a Neon/Postgres URL, or "pglite:<directory>" for a local file-backed database.
export async function createDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (!url) throw new Error("DATABASE_URL is not set");
  if (url.startsWith(PGLITE_PREFIX)) {
    const [{ PGlite }, { drizzle: drizzlePglite }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("drizzle-orm/pglite"),
    ]);
    const dir = url.slice(PGLITE_PREFIX.length);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    return drizzlePglite(new PGlite(dir), { schema }) as unknown as Db;
  }
  return drizzle(neon(url), { schema }) as unknown as Db;
}

// One database per server process (the dashboard). Pipeline scripts call createDb directly.
// Cached on globalThis because Next can load this module more than once (page rendering and
// Server Actions); two PGlite instances on one directory don't see each other's writes.
const cache = globalThis as unknown as { __prospectorDb?: Promise<Db> };
export function getDb(): Promise<Db> {
  cache.__prospectorDb ??= createDb();
  return cache.__prospectorDb;
}

export { schema };
