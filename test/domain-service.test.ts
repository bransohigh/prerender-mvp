import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeDomainRepository } from '../src/repositories/fake/fake-domain-repository.js';
import { createDomainService, toPublicDomain } from '../src/services/domain-service.js';
import { verifyTokenAgainstHash } from '../src/lib/verification-token.js';
import { AppError } from '../src/lib/app-error.js';

describe('DomainService.createDomain', () => {
  it('creates a pending domain and returns the plaintext token exactly once', async () => {
    const service = createDomainService(createFakeDomainRepository());
    const result = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'dns_txt',
    });
    expect(result.domain.status).toBe('pending');
    expect(result.plaintextToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never stores the plaintext token — only its hash', async () => {
    const service = createDomainService(createFakeDomainRepository());
    const result = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'dns_txt',
    });
    expect(result.domain.verificationTokenHash).not.toBe(result.plaintextToken);
    expect(verifyTokenAgainstHash(result.plaintextToken, result.domain.verificationTokenHash)).toBe(true);
  });

  it('builds DNS TXT verification instructions', async () => {
    const service = createDomainService(createFakeDomainRepository());
    const result = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'dns_txt',
    });
    expect(result.verification.recordName).toBe('_prerender-verification.www.example.com');
    expect(result.verification.recordType).toBe('TXT');
    expect(result.verification.recordValue).toContain(result.plaintextToken);
  });

  it('builds HTML file verification instructions', async () => {
    const service = createDomainService(createFakeDomainRepository());
    const result = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'html_file',
    });
    expect(result.verification.filePath).toBe('/.well-known/prerender-verification.txt');
    expect(result.verification.fileContent).toContain(result.plaintextToken);
  });

  it('rejects an invalid hostname', async () => {
    const service = createDomainService(createFakeDomainRepository());
    await expect(
      service.createDomain({ projectId: randomUUID(), hostname: 'localhost', verificationMethod: 'dns_txt' }),
    ).rejects.toMatchObject({ code: 'INVALID_DOMAIN' });
  });

  it('rejects a duplicate active domain', async () => {
    const service = createDomainService(createFakeDomainRepository());
    await service.createDomain({ projectId: randomUUID(), hostname: 'www.example.com', verificationMethod: 'dns_txt' });
    await expect(
      service.createDomain({ projectId: randomUUID(), hostname: 'www.example.com', verificationMethod: 'dns_txt' }),
    ).rejects.toMatchObject({ code: 'DOMAIN_ALREADY_EXISTS' });
  });

  it('treats apex and www as separate domains', async () => {
    const service = createDomainService(createFakeDomainRepository());
    await service.createDomain({ projectId: randomUUID(), hostname: 'example.com', verificationMethod: 'dns_txt' });
    await expect(
      service.createDomain({ projectId: randomUUID(), hostname: 'www.example.com', verificationMethod: 'dns_txt' }),
    ).resolves.toBeDefined();
  });
});

describe('DomainService.rotateToken', () => {
  it('generates a new token that invalidates the old one', async () => {
    const service = createDomainService(createFakeDomainRepository());
    const created = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'dns_txt',
    });
    const rotated = await service.rotateToken(created.domain.id);
    expect(rotated.plaintextToken).not.toBe(created.plaintextToken);
    expect(verifyTokenAgainstHash(created.plaintextToken, rotated.domain.verificationTokenHash)).toBe(false);
    expect(verifyTokenAgainstHash(rotated.plaintextToken, rotated.domain.verificationTokenHash)).toBe(true);
  });

  it('resets a verified domain back to pending', async () => {
    const repo = createFakeDomainRepository();
    const service = createDomainService(repo);
    const created = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'dns_txt',
    });
    await repo.markVerificationAttempt(created.domain.id, { success: true });

    const rotated = await service.rotateToken(created.domain.id);
    expect(rotated.domain.status).toBe('pending');
    expect(rotated.domain.verifiedAt).toBeNull();
  });

  it('throws DOMAIN_NOT_FOUND for unknown domain', async () => {
    const service = createDomainService(createFakeDomainRepository());
    await expect(service.rotateToken(randomUUID())).rejects.toBeInstanceOf(AppError);
  });
});

describe('toPublicDomain', () => {
  it('never includes the token hash', async () => {
    const service = createDomainService(createFakeDomainRepository());
    const result = await service.createDomain({
      projectId: randomUUID(),
      hostname: 'www.example.com',
      verificationMethod: 'dns_txt',
    });
    const publicView = toPublicDomain(result.domain);
    expect(publicView).not.toHaveProperty('verificationTokenHash');
    expect(JSON.stringify(publicView)).not.toContain(result.plaintextToken);
  });
});
