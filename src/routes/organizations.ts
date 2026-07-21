import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { AppError, isAppError } from '../lib/app-error.js';
import { requireSession } from '../auth/session.js';
import { member } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Auth } from '../auth/auth.js';
import type { InvitationService } from '../services/invitation-service.js';

const createInvitationSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['admin', 'member']),
});

export interface OrganizationRoutesOptions {
  auth: Auth;
  db: Database;
  invitationService: InvitationService;
}

// Minimal org-scoped surface for Milestone 1 (invite-only onboarding). The
// full organization/project/domain route tree with the owner/admin/member
// permission matrix is built out separately (tenancy milestone) — this file
// only covers what onboarding needs: creating an invitation as an
// owner/admin of the target org.
export async function organizationRoutes(app: FastifyInstance, options: OrganizationRoutesOptions): Promise<void> {
  const { auth, db, invitationService } = options;

  app.post<{ Params: { organizationId: string }; Body: unknown }>(
    '/organizations/:organizationId/invitations',
    async (request, reply) => {
      try {
        const session = await requireSession(request, auth);
        const { organizationId } = request.params;

        const membership = await db.query.member.findFirst({
          where: and(eq(member.organizationId, organizationId), eq(member.userId, session.userId)),
        });
        // 404 (not 403) on both "not a member" and "insufficient role" so
        // the response never confirms the organization exists to a caller
        // without access to it.
        if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
          throw new AppError('ORGANIZATION_NOT_FOUND', 'Organization not found');
        }

        const body = createInvitationSchema.parse(request.body);
        const result = await invitationService.createInvitation({
          organizationId,
          email: body.email,
          role: body.role,
          invitedByUserId: session.userId,
        });

        return reply.code(201).send({
          id: result.id,
          token: result.token,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (err) {
        if (isAppError(err)) {
          return reply.code(err.statusCode).send({ error: err.code });
        }
        throw err;
      }
    },
  );
}
