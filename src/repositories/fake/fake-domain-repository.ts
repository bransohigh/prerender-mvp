import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import type {
  Domain,
  DomainRepository,
  CreateDomainInput,
  PageResult,
} from '../types.js';

export function createFakeDomainRepository(): DomainRepository {
  const store = new Map<string, Domain>();

  return {
    async create(input: CreateDomainInput): Promise<Domain> {
      const existing = [...store.values()].find(
        (d) => d.normalizedHostname === input.normalizedHostname && d.status !== 'suspended',
      );
      if (existing) {
        throw new AppError('DOMAIN_ALREADY_EXISTS', `Domain already registered: ${input.normalizedHostname}`);
      }
      const now = new Date();
      const domain: Domain = {
        id: randomUUID(),
        projectId: input.projectId,
        hostname: input.hostname,
        normalizedHostname: input.normalizedHostname,
        status: 'pending',
        verificationMethod: input.verificationMethod,
        verificationTokenHash: input.verificationTokenHash,
        verifiedAt: null,
        lastVerificationAttemptAt: null,
        verificationFailureCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      store.set(domain.id, domain);
      return domain;
    },

    async findById(id: string): Promise<Domain | null> {
      return store.get(id) ?? null;
    },

    async findByNormalizedHostname(normalizedHostname: string): Promise<Domain | null> {
      return (
        [...store.values()].find(
          (d) => d.normalizedHostname === normalizedHostname && d.status !== 'suspended',
        ) ?? null
      );
    },

    async listByProject(projectId, options): Promise<PageResult<Domain>> {
      const all = [...store.values()]
        .filter((d) => d.projectId === projectId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const startIndex = options.cursor
        ? all.findIndex((d) => d.id === options.cursor) + 1
        : 0;
      const page = all.slice(startIndex, startIndex + options.limit);
      const nextCursor =
        startIndex + options.limit < all.length ? page[page.length - 1]?.id ?? null : null;
      return { items: page, nextCursor };
    },

    async rotateVerificationToken(id: string, newTokenHash: string): Promise<Domain | null> {
      const domain = store.get(id);
      if (!domain) return null;
      const wasVerified = domain.status === 'verified';
      const updated: Domain = {
        ...domain,
        verificationTokenHash: newTokenHash,
        status: wasVerified ? 'pending' : domain.status,
        verifiedAt: wasVerified ? null : domain.verifiedAt,
        updatedAt: new Date(),
      };
      store.set(id, updated);
      return updated;
    },

    async markVerificationAttempt(id, result): Promise<Domain | null> {
      const domain = store.get(id);
      if (!domain) return null;
      const now = new Date();
      const updated: Domain = result.success
        ? {
            ...domain,
            status: 'verified',
            verifiedAt: now,
            lastVerificationAttemptAt: now,
            verificationFailureCount: 0,
            updatedAt: now,
          }
        : {
            ...domain,
            status: domain.status === 'verified' ? 'verified' : 'failed',
            lastVerificationAttemptAt: now,
            verificationFailureCount: domain.verificationFailureCount + 1,
            updatedAt: now,
          };
      store.set(id, updated);
      return updated;
    },
  };
}
