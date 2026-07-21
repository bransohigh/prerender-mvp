import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAppError } from '../lib/app-error.js';
import { createApiKeyGuard } from '../lib/api-key-auth.js';
import { env } from '../config/env.js';
import { isValidSlug } from '../lib/slug.js';
import type { ProjectService } from '../services/project-service.js';

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(63)
    .refine((s) => isValidSlug(s.toLowerCase()), { message: 'Invalid slug format' })
    .optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z
    .string()
    .min(1)
    .max(63)
    .refine((s) => isValidSlug(s.toLowerCase()), { message: 'Invalid slug format' })
    .optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  cursor: z.string().uuid().optional(),
});

export interface ProjectRouteOptions {
  projectService: ProjectService;
}

export const projectRoutes: FastifyPluginAsync<ProjectRouteOptions> = async (app, opts) => {
  const { projectService } = opts;
  const requireAdmin = createApiKeyGuard({
    headerName: 'x-admin-api-key',
    expectedKey: env.ADMIN_API_KEY,
    errorMessage: 'invalid_admin_api_key',
  });

  app.addHook('preHandler', requireAdmin);

  app.post('/projects', async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
    }
    try {
      const project = await projectService.createProject(parsed.data);
      return reply.code(201).send(project);
    } catch (err) {
      if (isAppError(err)) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: request.id });
      }
      request.log.error({ event: 'project_create_failed', error: err }, 'Project creation failed');
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE', requestId: request.id });
    }
  });

  app.get('/projects', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
    }
    const page = await projectService.listProjects(parsed.data.limit, parsed.data.cursor ?? null);
    return reply.send(page);
  });

  app.get('/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      const project = await projectService.getProject(projectId);
      return reply.send(project);
    } catch (err) {
      if (isAppError(err)) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: request.id });
      }
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE', requestId: request.id });
    }
  });

  app.patch('/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parsed = updateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten(), requestId: request.id });
    }
    try {
      const updated = await projectService.updateProject(projectId, parsed.data);
      return reply.send(updated);
    } catch (err) {
      if (isAppError(err)) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: request.id });
      }
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE', requestId: request.id });
    }
  });

  app.delete('/projects/:projectId', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      await projectService.deleteProject(projectId);
      return reply.code(204).send();
    } catch (err) {
      if (isAppError(err)) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: request.id });
      }
      return reply.code(503).send({ error: 'DATABASE_UNAVAILABLE', requestId: request.id });
    }
  });
};
