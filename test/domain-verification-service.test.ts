import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeDomainRepository } from '../src/repositories/fake/fake-domain-repository.js';
import {
  performDomainVerification,
  verifyDomainOrThrow,
  createVerificationRateLimiter,
  createInFlightGuard,
} from '../src/services/domain-verification-service.js';
import { generateVerificationToken, hashVerificationToken, dnsTxtRecordValue } from '../src/lib/verification-token.js';
import { AppError } from '../src/lib/app-error.js';
import type { Domain } from '../src/repositories/types.js';

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  const now = new Date();
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    hostname: 'example.com',
    normalizedHostname: 'example.com',
    status: 'pending',
    verificationMethod: 'dns_txt',
    verificationTokenHash: hashVerificationToken('placeholder'),
    verifiedAt: null,
    lastVerificationAttemptAt: null,
    verificationFailureCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('performDomainVerification (dns_txt)', () => {
  it('succeeds when DNS TXT record hashes to the stored hash', async () => {
    const token = generateVerificationToken();
    const domain = makeDomain({ verificationTokenHash: hashVerificationToken(token) });
    const resolver = async () => [[dnsTxtRecordValue(token)]];
    const outcome = await performDomainVerification(domain, { dnsResolver: resolver });
    expect(outcome.success).toBe(true);
  });

  it('fails when DNS TXT token does not match the stored hash', async () => {
    const domain = makeDomain({ verificationTokenHash: hashVerificationToken(generateVerificationToken()) });
    const resolver = async () => [[dnsTxtRecordValue(generateVerificationToken())]];
    const outcome = await performDomainVerification(domain, { dnsResolver: resolver });
    expect(outcome.success).toBe(false);
    expect(outcome.success === false && outcome.errorCode).toBe('dns_not_found');
  });

  it('fails with dns_nxdomain when the record does not exist', async () => {
    const domain = makeDomain();
    const resolver = async () => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    const outcome = await performDomainVerification(domain, { dnsResolver: resolver });
    expect(outcome.success).toBe(false);
    expect(outcome.success === false && outcome.errorCode).toBe('dns_nxdomain');
  });

  it('never requires plaintext token storage to verify', async () => {
    // The domain object passed in only has a hash — this test documents
    // that no plaintext token field exists anywhere on Domain.
    const domain = makeDomain();
    expect(domain).not.toHaveProperty('verificationToken');
    expect(Object.keys(domain)).not.toContain('token');
  });
});

describe('createVerificationRateLimiter', () => {
  it('allows up to the configured max attempts per window', () => {
    const limiter = createVerificationRateLimiter(3, 60_000);
    const domainId = randomUUID();
    expect(limiter.tryAcquire(domainId)).toBe(true);
    expect(limiter.tryAcquire(domainId)).toBe(true);
    expect(limiter.tryAcquire(domainId)).toBe(true);
    expect(limiter.tryAcquire(domainId)).toBe(false);
  });

  it('tracks separate domains independently', () => {
    const limiter = createVerificationRateLimiter(1, 60_000);
    const a = randomUUID();
    const b = randomUUID();
    expect(limiter.tryAcquire(a)).toBe(true);
    expect(limiter.tryAcquire(b)).toBe(true);
    expect(limiter.tryAcquire(a)).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const limiter = createVerificationRateLimiter(1, 20);
    const domainId = randomUUID();
    expect(limiter.tryAcquire(domainId)).toBe(true);
    expect(limiter.tryAcquire(domainId)).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(limiter.tryAcquire(domainId)).toBe(true);
  });
});

describe('createInFlightGuard', () => {
  it('rejects a second concurrent acquire for the same key', () => {
    const guard = createInFlightGuard();
    expect(guard.acquire('a')).toBe(true);
    expect(guard.acquire('a')).toBe(false);
    guard.release('a');
    expect(guard.acquire('a')).toBe(true);
  });
});

describe('verifyDomainOrThrow', () => {
  it('marks the domain verified on success', async () => {
    const repo = createFakeDomainRepository();
    const token = generateVerificationToken();
    const created = await repo.create({
      projectId: randomUUID(),
      hostname: 'example.com',
      normalizedHostname: 'example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(token),
    });

    const resolver = async () => [[dnsTxtRecordValue(token)]];
    const result = await verifyDomainOrThrow(
      created,
      repo,
      createVerificationRateLimiter(),
      createInFlightGuard(),
      { dnsResolver: resolver },
    );
    expect(result.status).toBe('verified');
    expect(result.verifiedAt).not.toBeNull();
  });

  it('throws DOMAIN_VERIFICATION_FAILED and records the failed attempt', async () => {
    const repo = createFakeDomainRepository();
    const created = await repo.create({
      projectId: randomUUID(),
      hostname: 'example.com',
      normalizedHostname: 'example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });

    const resolver = async () => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    await expect(
      verifyDomainOrThrow(created, repo, createVerificationRateLimiter(), createInFlightGuard(), {
        dnsResolver: resolver,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_VERIFICATION_FAILED' });

    const after = await repo.findById(created.id);
    expect(after!.verificationFailureCount).toBe(1);
    expect(after!.status).toBe('failed');
  });

  it('throws DOMAIN_VERIFICATION_RATE_LIMITED after too many attempts', async () => {
    const repo = createFakeDomainRepository();
    const created = await repo.create({
      projectId: randomUUID(),
      hostname: 'example.com',
      normalizedHostname: 'example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });
    const rateLimiter = createVerificationRateLimiter(0, 60_000);

    await expect(
      verifyDomainOrThrow(created, repo, rateLimiter, createInFlightGuard(), {}),
    ).rejects.toMatchObject({ code: 'DOMAIN_VERIFICATION_RATE_LIMITED' });
  });

  it('throws DOMAIN_VERIFICATION_IN_PROGRESS for concurrent calls on the same domain', async () => {
    const repo = createFakeDomainRepository();
    const created = await repo.create({
      projectId: randomUUID(),
      hostname: 'example.com',
      normalizedHostname: 'example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: hashVerificationToken(generateVerificationToken()),
    });
    const inFlightGuard = createInFlightGuard();

    let resolveDns!: () => void;
    const slowResolver = () =>
      new Promise<string[][]>((resolve) => {
        resolveDns = () => resolve([]);
      });

    const p1 = verifyDomainOrThrow(created, repo, createVerificationRateLimiter(), inFlightGuard, {
      dnsResolver: slowResolver,
    }).catch((e: unknown) => e as AppError);

    await new Promise((r) => setTimeout(r, 5));

    await expect(
      verifyDomainOrThrow(created, repo, createVerificationRateLimiter(), inFlightGuard, {}),
    ).rejects.toMatchObject({ code: 'DOMAIN_VERIFICATION_IN_PROGRESS' });

    resolveDns();
    await p1;
  });
});
