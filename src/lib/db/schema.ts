import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export type KeyPerson = { name: string; relationship: string };

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 255 }).notNull().unique(),
    legalName: varchar("legal_name", { length: 255 }),
    cik: varchar("cik", { length: 10 }).unique(),
    domain: varchar("domain", { length: 255 }).unique(),
    category: varchar("category", { length: 50 }),
    description: text("description"),
    hqState: varchar("hq_state", { length: 2 }),
    keyPeople: jsonb("key_people").$type<KeyPerson[]>().notNull().default([]),
    excluded: boolean("excluded").notNull().default(false),
    exclusionReason: text("exclusion_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_brands_category").on(t.category)],
);

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    signalType: varchar("signal_type", { length: 20 }).notNull(),
    externalId: varchar("external_id", { length: 100 }).notNull(),
    sourceUrl: text("source_url").notNull(),
    companyNameRaw: varchar("company_name_raw", { length: 255 }).notNull(),
    signalDate: date("signal_date").notNull(),
    amountUsd: bigint("amount_usd", { mode: "number" }),
    title: varchar("title", { length: 255 }),
    rawPayload: jsonb("raw_payload").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    unique("signals_type_external_id_unique").on(t.signalType, t.externalId),
    index("idx_signals_queue")
      .on(t.status, t.brandId)
      .where(sql`${t.status} IN ('PENDING', 'PROCESSING')`),
    index("idx_signals_brand_date").on(t.brandId, t.signalDate.desc()),
    check("signals_signal_type_check", sql`${t.signalType} IN ('SEC_FORM_D', 'JOB_LISTING')`),
    check(
      "signals_status_check",
      sql`${t.status} IN ('PENDING', 'PROCESSING', 'PROCESSED', 'SKIPPED', 'FAILED')`,
    ),
  ],
);

export type ScoreBreakdown = {
  funding: number;
  retail_hiring: number;
  physical_stage: number;
  category_fit: number;
  recency: number;
};

export const prospects = pgTable(
  "prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .unique()
      .references(() => brands.id, { onDelete: "cascade" }),
    readinessScore: integer("readiness_score").notNull(),
    scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown>().notNull(),
    scoreRationale: text("score_rationale").notNull(),
    fundingSummary: varchar("funding_summary", { length: 255 }).notNull(),
    recentSignalSummary: varchar("recent_signal_summary", { length: 255 }).notNull(),
    expansionStage: varchar("expansion_stage", { length: 50 }).notNull(),
    keyHiringRoles: text("key_hiring_roles").array().notNull().default(sql`'{}'`),
    targetDemographics: text("target_demographics").notNull(),
    pitchAngle: text("pitch_angle").notNull(),
    recommendedFormats: text("recommended_formats").array().notNull(),
    status: varchar("status", { length: 20 }).notNull().default("NEW"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    statusChangedBy: varchar("status_changed_by", { length: 255 }),
    lastSignalAt: date("last_signal_at").notNull(),
    model: varchar("model", { length: 50 }).notNull(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_prospects_score").on(t.readinessScore.desc()),
    index("idx_prospects_status").on(t.status),
    check("prospects_readiness_score_check", sql`${t.readinessScore} BETWEEN 1 AND 100`),
    check("prospects_status_check", sql`${t.status} IN ('NEW', 'REVIEWED', 'CONTACTED', 'ARCHIVED')`),
  ],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    job: varchar("job", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("RUNNING"),
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    errors: jsonb("errors").$type<unknown[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("pipeline_runs_job_check", sql`${t.job} IN ('sync', 'analyze')`),
    check(
      "pipeline_runs_status_check",
      sql`${t.status} IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')`,
    ),
  ],
);

export const syncState = pgTable("sync_state", {
  key: varchar("key", { length: 50 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});
