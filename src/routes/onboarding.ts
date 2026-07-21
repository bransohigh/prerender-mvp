import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAppError } from '../lib/app-error.js';
import type { Auth } from '../auth/auth.js';
import type { InvitationService } from '../services/invitation-service.js';

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

  app.post('/onboarding/accept', async (request, reply) => {
    try {
      const body = acceptSchema.parse(request.body);
      const result = await invitationService.acceptInvitation({
        token: body.token,
        name: body.name,
        password: body.password,
        auth,
      });
      return reply.code(200).send({ organizationId: result.organizationId });
    } catch (err) {
      if (isAppError(err)) {
        return reply.code(err.statusCode).send({ error: err.code });
      }
      throw err;
    }
  });
}
