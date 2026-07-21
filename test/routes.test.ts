import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeRepoSet, seedVerifiedDomain } from './helpers/fake-repos.js';
import type { RenderFn } from '../src/types/render.js';
import type { ApiKeyVerifier } from '../src/services/render-api-key-auth-service.js';
import type { Project, Domain } from '../src/repositories/types.js';

const VALID_KEY = `pr_live_${'a'.repeat(56)}`;
const ORG_ID = 'org_fake_1';
const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

function makeFakeRenderUrl(): RenderFn {
  return vi.fn<RenderFn>().mockResolvedValue({
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    title: 'Example',
    html: '<html><head><title>Example</title></head><body>Hello</body></html>',
    renderTimeMs: 42,
    renderedAt: new Date().toISOString(),
  });
}

function makeFakeRenderUrlError(message: string): RenderFn {
  return vi.fn<RenderFn>().mockRejectedValue(new Error(message));
}

// Fake ApiKeyVerifier: only VALID_KEY verifies successfully, with a fixed
// scope (org/project). Everything else (wrong key, old x-api-key value,
// missing key) returns valid:false, matching real Better Auth behavior.
function makeFakeVerifier(): ApiKeyVerifier {
  return {
    api: {
      verifyApiKey: (async (args: { body: { key: string } }) => {
        if (args.body.key !== VALID_KEY) {
          return { valid: false, error: { message: 'Invalid API key', code: 'INVALID_API_KEY' }, key: null };
        }
        return {
          valid: true,
          error: null,
          key: {
            id: 'apikey_fake_1',
            referenceId: ORG_ID,
            metadata: { projectId: PROJECT_ID, createdByUserId: 'user_fake_1', revokedAt: null, rotatedFromKeyId: null, rotatedToKeyId: null },
            expiresAt: null,
          },
        };
      }) as ApiKeyVerifier['api']['verifyApiKey'],
    },
  };
}

interface FakeTenantOptions {
  organizationStatus?: 'active' | 'suspended' | null;
  projectStatus?: 'active' | 'suspended' | 'deleted' | null;
  domain?: Domain | null;
}

function makeFakeTenant(options: FakeTenantOptions = {}) {
  const organizationStatus = options.organizationStatus ?? 'active';
  const projectStatus = options.projectStatus ?? 'active';
  return {
    getOrganizationStatus: async () => organizationStatus,
    getProjectForOrganization: async (): Promise<Project | null> =>
      projectStatus === null
        ? null
        : {
            id: PROJECT_ID,
            organizationId: ORG_ID,
            name: 'P',
            slug: 'p',
            status: projectStatus,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
    getDomainForOrganizationProject: async (): Promise<Domain | null> => options.domain ?? null,
  };
}

async function buildTestApp(renderUrl: RenderFn, tenantOptions: FakeTenantOptions & { domain?: Domain | null } = {}) {
  const repos = createFakeRepoSet();
  const domain = await seedVerifiedDomain(repos.domainRepository, 'example.com');
  const app = await buildApp({
    renderUrl,
    ...repos,
    renderApiKeyVerifier: makeFakeVerifier(),
    renderTenant: makeFakeTenant({ ...tenantOptions, domain: 'domain' in tenantOptions ? tenantOptions.domain : domain }),
  });
  return { app, domainId: domain.id };
}

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('200 ve status ok döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('POST /v1/render', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it('API key olmadan 401 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('yanlış API key ile 401 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': `pr_live_${'b'.repeat(56)}` },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('eski x-api-key header artık kabul edilmez', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY, 'x-api-key': 'anything' },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('yanlış prefix ile 401 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': `wrong_prefix_${'a'.repeat(56)}` },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('aşırı uzun key header ile 401 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': `pr_live_${'a'.repeat(600)}` },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('mükerrer x-render-api-key header (array) reddedilir', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': [VALID_KEY, VALID_KEY] as unknown as string },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('query string içinde apiKey alanı reddedilir', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/render?apiKey=${VALID_KEY}`,
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('body içinde apiKey alanı reddedilir', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://example.com', apiKey: VALID_KEY },
    });
    expect(res.statusCode).toBe(401);
  });

  it('url alanı olmadan 400 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('domainId alanı olmadan 400 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('geçersiz URL ile 400 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('bilinmeyen domainId ile 404 döner', async () => {
    ({ app } = await buildTestApp(makeFakeRenderUrl(), { domain: null }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId: '00000000-0000-0000-0000-000000000000', url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('DOMAIN_NOT_FOUND');
  });

  it('doğrulanmamış domain ile 409 döner', async () => {
    const repos = createFakeRepoSet();
    const unverified = await repos.domainRepository.create({
      projectId: PROJECT_ID,
      hostname: 'unverified.example.com',
      normalizedHostname: 'unverified.example.com',
      verificationMethod: 'dns_txt',
      verificationTokenHash: 'hash',
    });
    app = await buildApp({
      renderUrl: makeFakeRenderUrl(),
      ...repos,
      renderApiKeyVerifier: makeFakeVerifier(),
      renderTenant: makeFakeTenant({ domain: unverified }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId: unverified.id, url: 'https://unverified.example.com' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('DOMAIN_NOT_VERIFIED');
  });

  it('suspended organization ile 403 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl(), { organizationStatus: 'suspended' }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error).toBe('ORGANIZATION_SUSPENDED');
  });

  it('suspended project ile 403 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl(), { projectStatus: 'suspended' }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error).toBe('PROJECT_SUSPENDED');
  });

  it('domain hostname eşleşmeyen URL ile 400 döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://not-example.com/' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('URL_DOMAIN_MISMATCH');
  });

  it('geçerli istek ile response şeması doğru', async () => {
    const fakeRender = makeFakeRenderUrl();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(fakeRender));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(body).toHaveProperty('url');
    expect(body).toHaveProperty('finalUrl');
    expect(body).toHaveProperty('statusCode');
    expect(body).toHaveProperty('title');
    expect(body).toHaveProperty('html');
    expect(body).toHaveProperty('renderTimeMs');
    expect(body).toHaveProperty('renderedAt');
  });

  it('renderer hatası 422 döner ve stack trace sızdırmaz', async () => {
    const fakeRender = makeFakeRenderUrlError('Render hatası oluştu');
    let domainId: string;
    ({ app, domainId } = await buildTestApp(fakeRender));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe('Render hatası oluştu');
    expect(res.payload).not.toContain('at ');
    expect(res.payload).not.toContain('node_modules');
  });

  it('renderer yalnızca doğrulama sonrası çağrılır', async () => {
    const fakeRender = makeFakeRenderUrl();
    let domainId: string;
    ({ app, domainId } = await buildTestApp(fakeRender));

    // invalid body — renderer should not be called
    await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId },
    });
    expect(fakeRender).not.toHaveBeenCalled();

    // missing api key — renderer should not be called
    await app.inject({
      method: 'POST',
      url: '/v1/render',
      payload: { domainId, url: 'https://example.com' },
    });
    expect(fakeRender).not.toHaveBeenCalled();
  });

  it('hatalı body ile error detayı döner', async () => {
    let domainId: string;
    ({ app, domainId } = await buildTestApp(makeFakeRenderUrl()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/render',
      headers: { 'x-render-api-key': VALID_KEY },
      payload: { domainId, url: 123 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string; details?: unknown };
    expect(body.error).toBeDefined();
  });
});
