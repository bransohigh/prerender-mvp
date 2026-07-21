import { randomUUID } from 'node:crypto';
import { createFakeProjectRepository } from '../../src/repositories/fake/fake-project-repository.js';
import { createFakeDomainRepository } from '../../src/repositories/fake/fake-domain-repository.js';
import { createFakeSitemapRepository } from '../../src/repositories/fake/fake-sitemap-repository.js';
import { createFakeDiscoveredUrlRepository } from '../../src/repositories/fake/fake-discovered-url-repository.js';
import { hashVerificationToken } from '../../src/lib/verification-token.js';
import type { Domain, DomainRepository } from '../../src/repositories/types.js';

export function createFakeRepoSet() {
  return {
    projectRepository: createFakeProjectRepository(),
    domainRepository: createFakeDomainRepository(),
    sitemapRepository: createFakeSitemapRepository(),
    discoveredUrlRepository: createFakeDiscoveredUrlRepository(),
  };
}

// Directly injects a pre-verified domain into a fake DomainRepository,
// bypassing the normal create+verify flow — useful for tests that only
// care about render/sitemap authorization, not verification itself.
export async function seedVerifiedDomain(
  domainRepository: DomainRepository,
  hostname: string,
  projectId = randomUUID(),
): Promise<Domain> {
  const created = await domainRepository.create({
    projectId,
    hostname,
    normalizedHostname: hostname,
    verificationMethod: 'dns_txt',
    verificationTokenHash: hashVerificationToken('test-token-not-used'),
  });
  const verified = await domainRepository.markVerificationAttempt(created.id, { success: true });
  return verified!;
}
