CREATE TYPE "public"."cache_entry_status" AS ENUM('pending', 'ready', 'failed', 'invalidated');--> statement-breakpoint
CREATE TABLE "cache_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"cache_key_version" integer NOT NULL,
	"cache_key_hash" text NOT NULL,
	"normalized_url" text NOT NULL,
	"normalized_url_hash" text NOT NULL,
	"render_profile_hash" text NOT NULL,
	"status" "cache_entry_status" DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"content_hash" text,
	"content_encoding" text,
	"content_bytes" bigint,
	"response_status" integer,
	"rendered_at" timestamp with time zone,
	"fresh_until" timestamp with time zone,
	"stale_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"invalidated_at" timestamp with time zone,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cache_entries_generation_check" CHECK ("cache_entries"."generation" >= 1),
	CONSTRAINT "cache_entries_content_bytes_check" CHECK ("cache_entries"."content_bytes" IS NULL OR "cache_entries"."content_bytes" >= 0),
	CONSTRAINT "cache_entries_response_status_check" CHECK ("cache_entries"."response_status" IS NULL OR ("cache_entries"."response_status" >= 100 AND "cache_entries"."response_status" < 600)),
	CONSTRAINT "cache_entries_stale_after_fresh_check" CHECK ("cache_entries"."stale_until" IS NULL OR "cache_entries"."fresh_until" IS NULL OR "cache_entries"."stale_until" >= "cache_entries"."fresh_until"),
	CONSTRAINT "cache_entries_ready_requires_content_check" CHECK ("cache_entries"."status" != 'ready' OR (
      "cache_entries"."storage_key" IS NOT NULL AND
      "cache_entries"."content_hash" IS NOT NULL AND
      "cache_entries"."rendered_at" IS NOT NULL AND
      "cache_entries"."fresh_until" IS NOT NULL AND
      "cache_entries"."stale_until" IS NOT NULL
    )),
	CONSTRAINT "cache_entries_pending_no_content_check" CHECK ("cache_entries"."status" != 'pending' OR ("cache_entries"."storage_key" IS NULL AND "cache_entries"."content_hash" IS NULL)),
	CONSTRAINT "cache_entries_invalidated_requires_timestamp_check" CHECK ("cache_entries"."status" != 'invalidated' OR "cache_entries"."invalidated_at" IS NOT NULL),
	CONSTRAINT "cache_entries_cache_key_hash_format_check" CHECK ("cache_entries"."cache_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cache_entries_normalized_url_hash_format_check" CHECK ("cache_entries"."normalized_url_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cache_entries_render_profile_hash_format_check" CHECK ("cache_entries"."render_profile_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cache_entries_content_hash_format_check" CHECK ("cache_entries"."content_hash" IS NULL OR "cache_entries"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cache_entries_storage_key_no_traversal_check" CHECK ("cache_entries"."storage_key" IS NULL OR "cache_entries"."storage_key" NOT LIKE '%..%')
);
--> statement-breakpoint
-- These two composite UNIQUE constraints must be created BEFORE the
-- composite foreign keys below that reference them (Postgres requires the
-- referenced columns to already have a unique constraint) — moved ahead
-- of drizzle-kit's generated order, which put them last.
ALTER TABLE "domains" ADD CONSTRAINT "domains_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "cache_entries" ADD CONSTRAINT "cache_entries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_entries" ADD CONSTRAINT "cache_entries_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_entries" ADD CONSTRAINT "cache_entries_domain_project_fk" FOREIGN KEY ("domain_id","project_id") REFERENCES "public"."domains"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cache_entries_identity_unique" ON "cache_entries" USING btree ("organization_id","project_id","domain_id","cache_key_version","cache_key_hash");--> statement-breakpoint
CREATE INDEX "cache_entries_lookup_idx" ON "cache_entries" USING btree ("organization_id","project_id","domain_id","cache_key_hash");--> statement-breakpoint
CREATE INDEX "cache_entries_project_id_idx" ON "cache_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "cache_entries_domain_id_idx" ON "cache_entries" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "cache_entries_status_fresh_until_idx" ON "cache_entries" USING btree ("status","fresh_until");