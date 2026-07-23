import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAppError } from '../lib/app-error.js';
import type { Auth } from '../auth/auth.js';
import type { InvitationService } from '../services/invitation-service.js';
import { env } from '../config/env.js';
import { createRateLimiter } from '../lib/rate-limiter.js';
import { invitationTokenDigest } from '../lib/rate-limit-keys.js';

const acceptSchema = z.object({
  token: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  password: z.string().min(12).max(128),
});

export interface OnboardingRoutesOptions {
  auth: Auth;
  invitationService: InvitationService;
}

export async function onboardingRoutes(app: FastifyInstance, options: OnboardingRoutesOptions): Promise<void> {
  const { auth, invitationService } = options;

  // Keyed by source IP and by an HMAC digest of the presented token
  // (never the raw token — see src/lib/rate-limit-keys.ts). Bounds both a
  // single IP guessing many tokens and repeated failures against one
  // specific token from rotating IPs.
  const ipLimiter = createRateLimiter({ windowMs: env.INVITATION_RATE_LIMIT_WINDOW_MS, maxAttempts: env.INVITATION_RATE_LIMIT_MAX });
  const tokenLimiter = createRateLimiter({ windowMs: env.INVITATION_RATE_LIMIT_WINDOW_MS, maxAttempts: env.INVITATION_RATE_LIMIT_MAX });
  app.addHook('onClose', () => {
    ipLimiter.shutdown();
    tokenLimiter.shutdown();
  });

  app.post('/onboarding/accept', async (request, reply) => {
    const ipDecision = ipLimiter.check(request.ip);
    if (!ipDecision.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(ipDecision.retryAfterSeconds))
        .send({ error: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id });
    }

    try {
      const body = acceptSchema.parse(request.body);
      const tokenKey = invitationTokenDigest(env.BETTER_AUTH_SECRET, body.token);
      const tokenDecision = tokenLimiter.check(tokenKey);
      if (!tokenDecision.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(tokenDecision.retryAfterSeconds))
          .send({ error: 'RATE_LIMITED', message: 'Too many requests', requestId: request.id });
      }

      const result = await invitationService.acceptInvitation({
        token: body.token,
        name: body.name,
        password: body.password,
        auth,
        requestId: request.id,
      });
      // Success clears this token's bucket — irrelevant in practice since
      // the token is single-use and about to be marked accepted, but keeps
      // limiter state from lingering for a value that will never be
      // retried again.
      tokenLimiter.reset(tokenKey);
      return reply.code(200).send({ organizationId: result.organizationId });
    } catch (err) {
      if (isAppError(err)) {
        return reply.code(err.statusCode).send({ error: err.code });
      }
      throw err;
    }
  });
}
