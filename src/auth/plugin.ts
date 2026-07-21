import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Auth } from './auth.js';

// Mounts Better Auth's handler under /api/auth/*, following the officially
// documented Fastify integration pattern (Better Auth ships Node/Next/Svelte
// adapters but no first-party Fastify plugin, so the Request/Response bridge
// is done by hand here). Registered with a raw body parser so the exact
// bytes Better Auth expects to verify/parse are preserved (Fastify's default
// JSON parser would otherwise consume and re-serialize the body, which is
// lossy for signed/encoded payloads).
export async function registerAuthRoutes(app: FastifyInstance, auth: Auth): Promise<void> {
  // Registered as a child scope so the raw-buffer content-type parser below
  // is encapsulated to /api/auth/* only and does not affect the JSON body
  // parsing used by the rest of the app's routes.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    registerAuthHandler(scope, auth);
  });
}

function registerAuthHandler(app: FastifyInstance, auth: Auth): void {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/api/auth/*',
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      // No open public signup: onboarding is invite-only (POST
      // /v1/onboarding/accept), so Better Auth's own sign-up endpoint must
      // never be reachable.
      const path = (request.params as { '*'?: string })['*'] ?? '';
      if (path.startsWith('sign-up')) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.append(key, value);
        }
      }

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const body = hasBody ? (request.body as Buffer) : undefined;

      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
      });

      const response = await auth.handler(webRequest);

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        // Fastify sets its own transfer-encoding/content-length; forwarding
        // the fetch Response's copies can conflict with Fastify's framing.
        if (key.toLowerCase() === 'transfer-encoding' || key.toLowerCase() === 'content-length') {
          return;
        }
        reply.header(key, value);
      });

      const buf = Buffer.from(await response.arrayBuffer());
      return reply.send(buf.length > 0 ? buf : null);
    },
  });
}
