import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function checkApiKey(headerValue: unknown, expected: string): boolean {
  return typeof headerValue === 'string' && timingSafeStringEqual(headerValue, expected);
}

export interface ApiKeyGuardOptions {
  headerName: string;
  expectedKey: string;
  errorMessage: string;
}

// Fastify preHandler that rejects the request with 401 unless the given
// header exactly matches (timing-safe) the expected key. Never logs the
// header value.
export function createApiKeyGuard(options: ApiKeyGuardOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const headerValue = request.headers[options.headerName];
    if (!checkApiKey(headerValue, options.expectedKey)) {
      await reply.code(401).send({ error: options.errorMessage, requestId: request.id });
    }
  };
}
