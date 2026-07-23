ALTER TYPE "public"."audit_action" ADD VALUE 'organization.invitation.cancelled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organization.member.removed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'domain.verification_token.rotated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sitemap.discovery.started';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sitemap.discovery.completed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sitemap.discovery.failed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sitemap.fetch.started';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sitemap.fetch.completed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sitemap.fetch.failed';