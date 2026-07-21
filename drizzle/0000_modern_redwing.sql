CREATE TYPE "public"."discovered_url_status" AS ENUM('active', 'excluded', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'failed', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."sitemap_source_status" AS ENUM('pending', 'success', 'failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."sitemap_source_type" AS ENUM('robots', 'sitemap', 'sitemap_index', 'manual');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('dns_txt', 'html_file');--> statement-breakpoint
CREATE TABLE "discovered_urls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"sitemap_source_id" uuid,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"path" text NOT NULL,
	"status" "discovered_url_status" DEFAULT 'active' NOT NULL,
	"lastmod" text,
	"priority" text,
	"changefreq" text,
	"first_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"normalized_hostname" text NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"verification_method" "verification_method" NOT NULL,
	"verification_token_hash" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_verification_attempt_at" timestamp with time zone,
	"verification_failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitemap_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"type" "sitemap_source_type" NOT NULL,
	"status" "sitemap_source_status" DEFAULT 'pending' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_http_status" integer,
	"last_error_code" text,
	"etag" text,
	"last_modified" text,
	"discovered_url_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovered_urls" ADD CONSTRAINT "discovered_urls_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_urls" ADD CONSTRAINT "discovered_urls_sitemap_source_id_sitemap_sources_id_fk" FOREIGN KEY ("sitemap_source_id") REFERENCES "public"."sitemap_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_sources" ADD CONSTRAINT "sitemap_sources_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_urls_domain_url_unique" ON "discovered_urls" USING btree ("domain_id","normalized_url");--> statement-breakpoint
CREATE INDEX "discovered_urls_domain_id_idx" ON "discovered_urls" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_normalized_hostname_unique" ON "domains" USING btree ("normalized_hostname") WHERE status != 'suspended';--> statement-breakpoint
CREATE INDEX "domains_project_id_idx" ON "domains" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "sitemap_sources_domain_url_unique" ON "sitemap_sources" USING btree ("domain_id","normalized_url");--> statement-breakpoint
CREATE INDEX "sitemap_sources_domain_id_idx" ON "sitemap_sources" USING btree ("domain_id");