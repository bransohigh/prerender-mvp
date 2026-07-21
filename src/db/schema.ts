import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
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

// ---------------------------------------------------------------------------
// Better Auth core tables (user/session/account/verification) and the
// organization plugin's tables (organization/member/invitation), generated
// via `npx @better-auth/cli generate` against src/auth/auth.ts and merged in
// by hand — see auth.config.ts (generation-only, not imported at runtime).
// The `invitation` table below is the organization plugin's own built-in
// table; this app does NOT use its invitation endpoints (kept only because
// the plugin may reference the table internally). The actual onboarding
// flow uses the separate `invitations` (plural) table further down, with
// hashed single-use tokens matching the domain-verification-token pattern.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id'),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const organization = pgTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    createdAt: timestamp('created_at').notNull(),
    metadata: text('metadata'),
  },
  (table) => [uniqueIndex('organization_slug_uidx').on(table.slug)],
);

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').default('member').notNull(),
    createdAt: timestamp('created_at').notNull(),
  },
  (table) => [
    index('member_organizationId_idx').on(table.organizationId),
    index('member_userId_idx').on(table.userId),
  ],
);

// Better Auth's own built-in invitation table — unused by this app's
// onboarding flow (see `invitations` below), kept only for plugin
// compatibility.
export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('invitation_organizationId_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ],
);

export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('apikey_configId_idx').on(table.configId),
    index('apikey_referenceId_idx').on(table.referenceId),
    index('apikey_key_idx').on(table.key),
  ],
);

// ---------------------------------------------------------------------------
// Custom onboarding invitation table (see src/services/invitation-service.ts)
// ---------------------------------------------------------------------------

export const invitationRoleEnum = pgEnum('invitation_role', ['admin', 'member']);
export const invitationStatusEnum = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: invitationRoleEnum('role').notNull(),
  tokenHash: text('token_hash').notNull(),
  status: invitationStatusEnum('status').notNull().default('pending'),
  invitedByUserId: text('invited_by_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  acceptedByUserId: text('accepted_by_user_id').references(() => user.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  organizationIdIdx: index('invitations_organization_id_idx').on(table.organizationId),
  tokenHashIdx: uniqueIndex('invitations_token_hash_unique').on(table.tokenHash),
}));

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditActionEnum = pgEnum('audit_action', [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'organization.invitation.created',
  'organization.invitation.accepted',
  'organization.member.role_changed',
  'project.created',
  'project.updated',
  'project.deleted',
  'domain.created',
  'domain.verification.attempted',
  'domain.verification.succeeded',
  'domain.verification.failed',
  'api_key.created',
  'api_key.rotated',
  'api_key.revoked',
  'render.authorization_rejected',
]);

export const auditResultEnum = pgEnum('audit_result', ['success', 'failure']);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').references(() => organization.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
  actorApiKeyId: text('actor_api_key_id'),
  action: auditActionEnum('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  result: auditResultEnum('result').notNull(),
  errorCode: text('error_code'),
  requestId: text('request_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  organizationIdIdx: index('audit_events_organization_id_idx').on(table.organizationId),
  createdAtIdx: index('audit_events_created_at_idx').on(table.createdAt),
}));

// ---------------------------------------------------------------------------
// Application tables (Phase 6), now organization-scoped
// ---------------------------------------------------------------------------

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable in this migration step for backward-compatible backfill (see
  // scripts/db/backfill-organizations.ts and drizzle/0002_*). A later
  // migration adds NOT NULL once no orphan rows remain.
  organizationId: text('organization_id').references(() => organization.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  status: projectStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  slugUnique: uniqueIndex('projects_slug_unique').on(table.slug),
  organizationIdIdx: index('projects_organization_id_idx').on(table.organizationId),
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
