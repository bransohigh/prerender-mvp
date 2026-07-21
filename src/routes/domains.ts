import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAppError, AppError } from '../lib/app-error.js';
import { createApiKeyGuard } from '../lib/api-key-auth.js';
import { env } from '../config/env.js';
import type { DomainService } from '../services/domain-service.js';
import { toPublicDomain } from '../services/domain-service.js';
import type { ProjectService } from '../services/project-service.js';
import {
  verifyDomainOrThrow,
  createVerificationRateLimiter,
  createInFlightGuard,
  type VerificationRateLimiter,
  type InFlightGuard,
} from '../services/domain-verification-service.js';
import { discoverSitemapSources, assertDomainVerifiedForSitemap } from '../services/sitemap-discovery-service.js';
import type { DomainRepository, SitemapRepository } from '../repositories/types.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';

const createDomainSchema = z.object({
  hostname: z.string().min(1).max(253),
  verificationMethod: z.enum(['dns_txt', 'html_file']),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

export interface DomainRouteOptions {
  projectService: ProjectService;
  domainService: DomainService;
  domainRepository: DomainRepository;
  sitemapRepository: SitemapRepository;
  metrics?: Metrics;
  proxyUrl?: string;
  verificationRateLimiter?: VerificationRateLimiter;
  verificationInFlightGuard?: InFlightGuard;
}

function sendAppError(err: unknown, reply: import('fastify').FastifyReply, requestId: string) {
  if (isAppError(err)) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId });
  }
  return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE', requestId });
}

export const domainRoutes: FastifyPluginAsync<DomainRouteOptions> = async (app, opts) => {
  const {
    projectService,
    domainService,
    domainRepository,
    sitemapRepository,
  } = opts;
  const metrics = opts.metrics ?? createNoopMetrics();
  const rateLimiter = opts.verificationRateLimiter ?? createVerificationRateLimiter();
  const inFlightGuard = opts.verificationInFlightGuard ?? createInFlightGuard();

  const requireAdmin = createApiKeyGuard({
    headerName: 'x-admin-api-key',
    expectedKey: env.ADMIN_API_KEY,
    errorMessage: 'invalid_admin_api_key',
  });
  app.addHook('preHandler', requireAdmin);

  app.post('/projects/:projectId/domains', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = createDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
    }

    try {
      await projectService.getProject(projectId);
      const result = await domainService.createDomain({
        projectId,
        hostname: parsed.data.hostname,
        verificationMethod: parsed.data.verificationMethod,
      });

      request.log.info(
        { event: 'domain_created', domainId: result.domain.id, projectId, verificationMethod: parsed.data.verificationMethod },
        'Domain created',
      );

      return reply.code(201).send({
        domain: toPublicDomain(result.domain),
        verification: {
          method: result.verification.method,
          ...(result.verification.recordName
            ? {
                recordName: result.verification.recordName,
                recordType: result.verification.recordType,
                recordValue: result.verification.recordValue,
              }
            : {
                path: result.verification.filePath,
                content: result.verification.fileContent,
              }),
          token: result.plaintextToken,
        },
      });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get('/projects/:projectId/domains', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
    }
    try {
      await projectService.getProject(projectId);
      const page = await domainService.listDomains(projectId, parsed.data.limit, parsed.data.cursor ?? null);
      return reply.send({ items: page.items.map(toPublicDomain), nextCursor: page.nextCursor });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.get('/domains/:domainId', async (request, reply) => {
    const { domainId } = request.params as { domainId: string };
    try {
      const domain = await domainService.getDomain(domainId);
      return reply.send(toPublicDomain(domain));
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.post('/domains/:domainId/rotate-verification-token', async (request, reply) => {
    const { domainId } = request.params as { domainId: string };
    try {
      const result = await domainService.rotateToken(domainId);
      request.log.info({ event: 'domain_token_rotated', domainId }, 'Domain verification token rotated');
      return reply.send({
        domain: toPublicDomain(result.domain),
        verification: {
          method: result.verification.method,
          ...(result.verification.recordName
            ? {
                recordName: result.verification.recordName,
                recordType: result.verification.recordType,
                recordValue: result.verification.recordValue,
              }
            : {
                path: result.verification.filePath,
                content: result.verification.fileContent,
              }),
          token: result.plaintextToken,
        },
      });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });

  app.post('/domains/:domainId/verify', async (request, reply) => {
    const { domainId } = request.params as { domainId: string };
    const startedAt = Date.now();
    try {
      const domain = await domainService.getDomain(domainId);
      const verified = await verifyDomainOrThrow(
        domain,
        domainRepository,
        rateLimiter,
        inFlightGuard,
        { proxyUrl: opts.proxyUrl },
        metrics,
      );
      metrics.observeDomainVerificationDuration((Date.now() - startedAt) / 1000);
      request.log.info(
        { event: 'domain_verified', domainId, verificationMethod: domain.verificationMethod, result: 'success' },
        'Domain verification succeeded',
      );
      return reply.send(toPublicDomain(verified));
    } catch (err) {
      metrics.observeDomainVerificationDuration((Date.now() - startedAt) / 1000);
      if (err instanceof AppError) {
        request.log.warn(
          { event: 'domain_verification_failed', domainId, errorCode: err.code },
          'Domain verification failed',
        );
      }
      return sendAppError(err, reply, request.id);
    }
  });

  app.post('/domains/:domainId/discover-sitemaps', async (request, reply) => {
    const { domainId } = request.params as { domainId: string };
    try {
      const domain = await domainService.getDomain(domainId);
      assertDomainVerifiedForSitemap(domain);
      const result = await discoverSitemapSources(domain, sitemapRepository, { proxyUrl: opts.proxyUrl });
      request.log.info(
        { event: 'sitemap_discovery_completed', domainId, discoveredCount: result.sources.length },
        'Sitemap discovery completed',
      );
      return reply.send({
        sources: result.sources.map((s) => ({
          id: s.id,
          url: s.url,
          type: s.type,
          status: s.status,
        })),
        robotsFound: result.robotsFound,
      });
    } catch (err) {
      return sendAppError(err, reply, request.id);
    }
  });
};
