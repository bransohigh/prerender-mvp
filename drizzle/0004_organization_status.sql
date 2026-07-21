CREATE TYPE "public"."organization_status" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "status" "organization_status" DEFAULT 'active' NOT NULL;