export type ProjectStatus = 'active' | 'suspended' | 'deleted';
export type DomainStatus = 'pending' | 'verified' | 'failed' | 'suspended';
export type VerificationMethod = 'dns_txt' | 'html_file';
export type SitemapSourceType = 'robots' | 'sitemap' | 'sitemap_index' | 'manual';
export type SitemapSourceStatus = 'pending' | 'success' | 'failed' | 'disabled';
export type DiscoveredUrlStatus = 'active' | 'excluded' | 'invalid';

export interface Project {
  id: string;
  name: string;
  slug: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Domain {
  id: string;
  projectId: string;
  hostname: string;
  normalizedHostname: string;
  status: DomainStatus;
  verificationMethod: VerificationMethod;
  verificationTokenHash: string;
  verifiedAt: Date | null;
  lastVerificationAttemptAt: Date | null;
  verificationFailureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SitemapSource {
  id: string;
  domainId: string;
  url: string;
  normalizedUrl: string;
  type: SitemapSourceType;
  status: SitemapSourceStatus;
  lastFetchedAt: Date | null;
  lastHttpStatus: number | null;
  lastErrorCode: string | null;
  etag: string | null;
  lastModified: string | null;
  discoveredUrlCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscoveredUrl {
  id: string;
  domainId: string;
  sitemapSourceId: string | null;
  url: string;
  normalizedUrl: string;
  path: string;
  status: DiscoveredUrlStatus;
  lastmod: string | null;
  priority: string | null;
  changefreq: string | null;
  firstDiscoveredAt: Date;
  lastDiscoveredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  status?: ProjectStatus;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  findBySlug(slug: string): Promise<Project | null>;
  list(options: { limit: number; cursor?: string | null }): Promise<PageResult<Project>>;
  update(id: string, input: UpdateProjectInput): Promise<Project | null>;
  softDeleteWithCascade(id: string): Promise<Project | null>;
}

export interface CreateDomainInput {
  projectId: string;
  hostname: string;
  normalizedHostname: string;
  verificationMethod: VerificationMethod;
  verificationTokenHash: string;
}

export interface DomainRepository {
  create(input: CreateDomainInput): Promise<Domain>;
  findById(id: string): Promise<Domain | null>;
  findByNormalizedHostname(normalizedHostname: string): Promise<Domain | null>;
  listByProject(projectId: string, options: { limit: number; cursor?: string | null }): Promise<PageResult<Domain>>;
  rotateVerificationToken(id: string, newTokenHash: string): Promise<Domain | null>;
  markVerificationAttempt(
    id: string,
    result: { success: true } | { success: false; failureCode: string },
  ): Promise<Domain | null>;
}

export interface UpsertSitemapSourceInput {
  domainId: string;
  url: string;
  normalizedUrl: string;
  type: SitemapSourceType;
}

export interface RecordSitemapFetchInput {
  status: SitemapSourceStatus;
  lastHttpStatus?: number | null;
  lastErrorCode?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  discoveredUrlCount?: number;
}

export interface SitemapRepository {
  upsert(input: UpsertSitemapSourceInput): Promise<SitemapSource>;
  findById(id: string): Promise<SitemapSource | null>;
  listByDomain(domainId: string): Promise<SitemapSource[]>;
  recordFetchResult(id: string, input: RecordSitemapFetchInput): Promise<SitemapSource | null>;
}

export interface UpsertDiscoveredUrlInput {
  domainId: string;
  sitemapSourceId: string | null;
  url: string;
  normalizedUrl: string;
  path: string;
  lastmod?: string | null;
  priority?: string | null;
  changefreq?: string | null;
}

export interface DiscoveredUrlRepository {
  upsertMany(inputs: UpsertDiscoveredUrlInput[]): Promise<number>;
  countByDomain(domainId: string): Promise<number>;
  listByDomain(domainId: string, options: { limit: number; cursor?: string | null }): Promise<PageResult<DiscoveredUrl>>;
}
