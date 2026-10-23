# Test fixtures

File names say where each fixture came from:

- **No suffix**: captured from the real service (Oct 21, 2026).
- **`.DERIVED`**: a real capture, edited by hand to produce one specific failure.
- **`.SYNTHETIC`**: written from documentation because no real capture exists yet. Replace it when a real one shows up.

## `sec/` (real, from EDGAR)

| File | Why it's here |
|---|---|
| `form.20261020.idx` | Daily form index, trimmed to 9 rows. Includes `D`, `D/A`, a multi-word form type (`DEF 14A`), and a row whose filing date (20261016) differs from the index date. |
| `formd-manufacturing-hiyo.xml` | Consumer beverage brand filed under Manufacturing, $20.8M. Should pass the filters. |
| `formd-retailing-coop.xml` | Retailing, $3M offering. Should pass the filters. |
| `formd-restaurant-entity-escape.xml` | Restaurants, $4M. The issuer name contains `&amp;`. |
| `formd-retailing-below-min.xml` | Retailing, $45K. Fails the $2M minimum. |
| `formd-other-indefinite.xml` | Offering amount is `Indefinite` and $0 is sold. Fails the minimum. The related persons include an entity with first name `N/A`. |
| `formd-other-canada.xml` | State code `A1` (British Columbia). The HQ state must come out as null. |
| `formd-pooled-fund.xml` | Pooled Investment Fund. Excluded by industry group. |
| `formd-commercial-real-estate.xml` | Commercial real estate. Excluded by industry group. The first sale is yet to occur. |

## `claude-code/` (from `scripts/capture-claude-fixtures.ts`)

Each capture has a `*.stdout.json` (the CLI's `--output-format json` output) and a `*.meta.json` (exit code and stderr).

| File | Origin |
|---|---|
| `success-brand` | Real. A fictional skincare brand, analyzed. |
| `success-excluded-fund` | Real. A fictional investment fund, which came back excluded. |
| `auth-invalid-token` | Real. A bogus `CLAUDE_CODE_OAUTH_TOKEN` produces a 401. |
| `auth-not-logged-in` | Real. No credentials at all. |
| `success-no-structured-output.DERIVED` | `structured_output` removed and the JSON put in `result`. This is what the CLI returns when it ignores the schema. |
| `success-schema-invalid.DERIVED` | `category` and `recommended_formats` set to values outside the taxonomy. |
| `usage-limit-429.SYNTHETIC` | A 429 rate-limit error. |
| `usage-limit-plan.SYNTHETIC` | A plan usage limit with no HTTP status. |
| `server-error-500.SYNTHETIC` | A transient server error. |

What the real captures showed:

- On errors, `subtype` is still `"success"` while `is_error` is `true`. Classify by `is_error`.
- The CLI silently ignores a JSON Schema that includes Zod's `$schema` key. The output then has no `structured_output` field and no error.
- `--tools ""` also disables `--json-schema`. Use `--tools StructuredOutput`.

## `jsearch/`

`search-v2.json` is a real `/search-v2` response for "Head of Retail" (Oct 23, 2026), with logos, reviews, highlights and apply options removed. JSearch renamed `/search` to `/search-v2` that month and wrapped the list in `data.jobs`. `job_state` is now a full state name ("Maryland").

`search.SYNTHETIC.json` follows the older `/search` format (a `data` array). The parser still accepts it. The companies are fictional, apart from the blocklisted big employers. It covers:

- a description over 4,000 characters;
- a title that fails the retail filter;
- blocklisted employers (a big-box retailer and a staffing agency);
- a website with and without `www.` and a path;
- a missing website and a missing posted date;
- 16 listings from one employer, which trips the high-volume rule.

It stays because it covers edge cases the real capture doesn't.
