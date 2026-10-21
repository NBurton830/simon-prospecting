CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"normalized_name" varchar(255) NOT NULL,
	"legal_name" varchar(255),
	"cik" varchar(10),
	"domain" varchar(255),
	"category" varchar(50),
	"description" text,
	"hq_state" varchar(2),
	"key_people" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_normalized_name_unique" UNIQUE("normalized_name"),
	CONSTRAINT "brands_cik_unique" UNIQUE("cik"),
	CONSTRAINT "brands_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'RUNNING' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "pipeline_runs_job_check" CHECK ("pipeline_runs"."job" IN ('sync', 'analyze')),
	CONSTRAINT "pipeline_runs_status_check" CHECK ("pipeline_runs"."status" IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"readiness_score" integer NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"score_rationale" text NOT NULL,
	"funding_summary" varchar(255) NOT NULL,
	"recent_signal_summary" varchar(255) NOT NULL,
	"expansion_stage" varchar(50) NOT NULL,
	"key_hiring_roles" text[] DEFAULT '{}' NOT NULL,
	"target_demographics" text NOT NULL,
	"pitch_angle" text NOT NULL,
	"recommended_formats" text[] NOT NULL,
	"status" varchar(20) DEFAULT 'NEW' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_by" varchar(255),
	"last_signal_at" date NOT NULL,
	"model" varchar(50) NOT NULL,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospects_brand_id_unique" UNIQUE("brand_id"),
	CONSTRAINT "prospects_readiness_score_check" CHECK ("prospects"."readiness_score" BETWEEN 1 AND 100),
	CONSTRAINT "prospects_status_check" CHECK ("prospects"."status" IN ('NEW', 'REVIEWED', 'CONTACTED', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"signal_type" varchar(20) NOT NULL,
	"external_id" varchar(100) NOT NULL,
	"source_url" text NOT NULL,
	"company_name_raw" varchar(255) NOT NULL,
	"signal_date" date NOT NULL,
	"amount_usd" bigint,
	"title" varchar(255),
	"raw_payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "signals_type_external_id_unique" UNIQUE("signal_type","external_id"),
	CONSTRAINT "signals_signal_type_check" CHECK ("signals"."signal_type" IN ('SEC_FORM_D', 'JOB_LISTING')),
	CONSTRAINT "signals_status_check" CHECK ("signals"."status" IN ('PENDING', 'PROCESSING', 'PROCESSED', 'SKIPPED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" varchar(50) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_brands_category" ON "brands" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_prospects_score" ON "prospects" USING btree ("readiness_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_prospects_status" ON "prospects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_signals_queue" ON "signals" USING btree ("status","brand_id") WHERE "signals"."status" IN ('PENDING', 'PROCESSING');--> statement-breakpoint
CREATE INDEX "idx_signals_brand_date" ON "signals" USING btree ("brand_id","signal_date" DESC NULLS LAST);