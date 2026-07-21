import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const projectStatusEnum = pgEnum('project_status', [
  'active',
  'suspended',
  'deleted',
]);

export const domainStatusEnum = pgEnum('domain_status', [
  'pending',
  'verified',
  'failed',
  'suspended',
]);

export const verificationMethodEnum = pgEnum('verification_method', [
  'dns_txt',
  'html_file',
]);

export const sitemapSourceTypeEnum = pgEnum('sitemap_source_type', [
  'robots',
  'sitemap',
  'sitemap_index',
  'manual',
]);

export const sitemapSourceStatusEnum = pgEnum('sitemap_source_status', [
  'pending',
  'success',
  'failed',
  'disabled',
]);

export const discoveredUrlStatusEnum = pgEnum('discovered_url_status', [
  'active',
  'excluded',
  'invalid',
]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  status: projectStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  slugUnique: uniqueIndex('projects_slug_unique').on(table.slug),
}));

export const domains = pgTable('domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  normalizedHostname: text('normalized_hostname').notNull(),
  status: domainStatusEnum('status').notNull().default('pending'),
  verificationMethod: verificationMethodEnum('verification_method').notNull(),
  verificationTokenHash: text('verification_token_hash').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastVerificationAttemptAt: timestamp('last_verification_attempt_at', { withTimezone: true }),
  verificationFailureCount: integer('verification_failure_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Partial unique index: only one non-deleted domain per normalized
  // hostname across the whole system (single-tenant ownership in this MVP).
  normalizedHostnameUnique: uniqueIndex('domains_normalized_hostname_unique')
    .on(table.normalizedHostname)
    .where(sql`status != 'suspended'`),
  projectIdIdx: index('domains_project_id_idx').on(table.projectId),
}));

export const sitemapSources = pgTable('sitemap_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  domainId: uuid('domain_id')
    .notNull()
    .references(() => domains.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  normalizedUrl: text('normalized_url').notNull(),
  type: sitemapSourceTypeEnum('type').notNull(),
  status: sitemapSourceStatusEnum('status').notNull().default('pending'),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  lastHttpStatus: integer('last_http_status'),
  lastErrorCode: text('last_error_code'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  discoveredUrlCount: integer('discovered_url_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  domainUrlUnique: uniqueIndex('sitemap_sources_domain_url_unique').on(
    table.domainId,
    table.normalizedUrl,
  ),
  domainIdIdx: index('sitemap_sources_domain_id_idx').on(table.domainId),
}));

export const discoveredUrls = pgTable('discovered_urls', {
  id: uuid('id').primaryKey().defaultRandom(),
  domainId: uuid('domain_id')
    .notNull()
    .references(() => domains.id, { onDelete: 'cascade' }),
  sitemapSourceId: uuid('sitemap_source_id').references(() => sitemapSources.id, {
    onDelete: 'set null',
  }),
  url: text('url').notNull(),
  normalizedUrl: text('normalized_url').notNull(),
  path: text('path').notNull(),
  status: discoveredUrlStatusEnum('status').notNull().default('active'),
  lastmod: text('lastmod'),
  priority: text('priority'),
  changefreq: text('changefreq'),
  firstDiscoveredAt: timestamp('first_discovered_at', { withTimezone: true }).notNull().defaultNow(),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  domainUrlUnique: uniqueIndex('discovered_urls_domain_url_unique').on(
    table.domainId,
    table.normalizedUrl,
  ),
  domainIdIdx: index('discovered_urls_domain_id_idx').on(table.domainId),
}));
