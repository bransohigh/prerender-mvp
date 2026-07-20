import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { isCapacityError } from '../lib/errors.js';
import type { RenderFn } from '../types/render.js';

const renderBodySchema = z.object({
  url: z.string().url().max(2048),
});

export interface RenderRouteOptions {
  renderUrl: RenderFn;
}

export const renderRoutes: FastifyPluginAsync<RenderRouteOptions> = async (
  app,
  opts,
) => {
  const { renderUrl } = opts;

  app.post('/render', async (request, reply) => {
    if (request.headers['x-api-key'] !== env.API_KEY) {
      return reply.code(401).send({ error: 'Geçersiz API anahtarı' });
    }

    const parsed = renderBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Geçersiz istek',
        details: parsed.error.flatten(),
      });
    }

    try {
      return await renderUrl(parsed.data.url);
    } catch (error) {
      if (isCapacityError(error)) {
        request.log.warn(
          { code: error.code, url: parsed.data.url },
          'Render kapasite hatası',
        );
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send({
            error: 'service_unavailable',
            code: error.code,
            message: error.message,
          });
      }

      request.log.error({ error, url: parsed.data.url }, 'Render işlemi başarısız');
      const message = error instanceof Error ? error.message : 'Bilinmeyen hata';
      return reply.code(422).send({ error: message });
    }
  });
};
