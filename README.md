# Retail Brand Prospector

A dashboard of emerging consumer brands showing signs of physical-retail expansion. A daily pipeline gathers SEC Form D filings and retail job listings, and Claude scores each brand and writes a sales pitch. The full design is in [SPEC.md](SPEC.md).

## Quick start (local, no accounts needed)

```bash
npm install
npm test                                                          # 338 tests, no network

# Dashboard with fictional demo data
DATABASE_URL=pglite:./.data/demo npm run db:migrate
DATABASE_URL=pglite:./.data/demo npx tsx scripts/seed-demo.ts
AUTH_DISABLED=true DATABASE_URL=pglite:./.data/demo npm run dev  # http://localhost:3000
```

### Real data

The pipeline below pulls real SEC filings. It analyzes up to 3 brands with Claude Code, using your logged-in Claude account.

```bash
export DATABASE_URL=pglite:./.data/local
npm run db:migrate
SEC_USER_AGENT="Your Name you@example.com" MAX_ANALYSES_PER_RUN=3 npm run pipeline
AUTH_DISABLED=true npm run dev
```

A `pglite:` database can be open in only one process at a time, so stop the dev server before running the pipeline on the same folder.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests (in-process PGlite Postgres; never calls live services) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run db:migrate` | Apply `drizzle/` migrations to `DATABASE_URL` (Neon or `pglite:<dir>`) |
| `npm run db:generate` | Generate a migration after editing `src/lib/db/schema.ts` |
| `npm run pipeline` | Sync, analyze, then retention on the 1st of the month (SPEC §6) |
| `npm run dev` | Dashboard. `AUTH_DISABLED=true` skips sign-in outside production. |

## Deploying

1. **Database:** create a Neon database and run `DATABASE_URL=<neon url> npm run db:migrate`.
2. **Pipeline (GitHub Actions):** add the secrets and variables from SPEC §9.1. The workflow in `.github/workflows/pipeline.yml` runs the tests, then the pipeline, every day at 06:17 UTC.
3. **Dashboard (Vercel):** import the repo and set the variables from SPEC §9.2: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` and `ALLOWED_EMAIL_DOMAINS`. Add `https://<your-domain>/api/auth/callback/google` as an authorized redirect URI in the Google OAuth client.
