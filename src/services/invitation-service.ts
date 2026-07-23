import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { AppError } from '../lib/app-error.js';
import { invitations, organization, member } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Auth } from '../auth/auth.js';
import { insertAuditEventRow } from '../repositories/postgres/audit-repository.js';
import { buildAuditMetadata } from '../lib/audit-events.js';
import { createNoopMetrics, type Metrics } from '../lib/metrics.js';

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

// Same hash-and-compare pattern as src/lib/verification-token.ts: a 256-bit
// random token is shown once in the API response; only its SHA-256 hash is
// stored, and comparisons are constant-time.
export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function verifyInvitationToken(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashInvitationToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export interface CreateInvitationInput {
  organizationId: string;
  email: string;
  role: 'admin' | 'member';
  invitedByUserId: string;
  requestId: string | null;
}

export interface CreateInvitationResult {
  id: string;
  token: string;
  expiresAt: Date;
}

export function createInvitationService(db: Database, metrics: Metrics = createNoopMetrics()) {
  async function createInvitation(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    const org = await db.query.organization.findFirst({
      where: eq(organization.id, input.organizationId),
    });
    if (!org) {
      throw new AppError('ORGANIZATION_NOT_FOUND', 'Organization not found');
    }

    const token = generateInvitationToken();
    const tokenHash = hashInvitationToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const rowId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invitations)
        .values({
          organizationId: input.organizationId,
          email: input.email.trim().toLowerCase(),
          role: input.role,
          tokenHash,
          status: 'pending',
          invitedByUserId: input.invitedByUserId,
          expiresAt,
        })
        .returning({ id: invitations.id });

      await insertAuditEventRow(tx, {
        organizationId: input.organizationId,
        actorUserId: input.invitedByUserId,
        actorApiKeyId: null,
        action: 'organization.invitation.created',
        targetType: 'invitation',
        targetId: row!.id,
        result: 'success',
        errorCode: null,
        requestId: input.requestId,
        // The invited email is never audit metadata (not on the allowlist)
        // — it would let anyone with audit-read access enumerate invited
        // addresses beyond what the invitation-list endpoint already shows
        // to owner/admin. roleAfter records what was granted.
        metadata: buildAuditMetadata({ roleAfter: input.role }),
      }, metrics);

      return row!.id;
    });

    return { id: rowId, token, expiresAt };
  }

  interface AcceptInvitationInput {
    token: string;
    name: string;
    password: string;
    auth: Auth;
    requestId: string | null;
  }

  async function acceptInvitation(input: AcceptInvitationInput): Promise<{ userId: string; organizationId: string }> {
    // Token lookup must not leak whether *any* invitation exists for a
    // given email; we only ever look up by hash-matched candidates.
    const candidates = await db.query.invitations.findMany({
      where: eq(invitations.status, 'pending'),
    });

    const match = candidates.find((c) => verifyInvitationToken(input.token, c.tokenHash));
    if (!match) {
      throw new AppError('INVITATION_NOT_FOUND', 'Invitation not found or already used');
    }
    if (match.expiresAt.getTime() < Date.now()) {
      // Mark expired but do not consume as "used" — a failed attempt must
      // not silently succeed, and an expired token must never work again.
      await db.update(invitations).set({ status: 'expired' }).where(eq(invitations.id, match.id));
      throw new AppError('INVITATION_EXPIRED', 'Invitation has expired');
    }

    return db.transaction(async (tx) => {
      // Re-check status inside the transaction: single-use is enforced by
      // the status flip below being the only path from pending -> accepted.
      const fresh = await tx.query.invitations.findFirst({ where: eq(invitations.id, match.id) });
      if (!fresh || fresh.status !== 'pending') {
        throw new AppError('INVITATION_ALREADY_USED', 'Invitation already used');
      }

      const txAuth = input.auth;
      const existingUser = await tx.query.user.findFirst({
        where: (u, { eq: eqOp }) => eqOp(u.email, fresh.email),
      });

      let userId: string;
      if (existingUser) {
        // An existing account's email must not be hijackable via an
        // invitation token: linking to an existing user requires that
        // user's own password, not just knowledge of the invite token.
        const verifyResult = await txAuth.api
          .signInEmail({ body: { email: fresh.email, password: input.password } })
          .catch(() => null);
        if (!verifyResult) {
          throw new AppError('INVITATION_EMAIL_MISMATCH', 'Account verification failed');
        }
        userId = existingUser.id;
      } else {
        const signUpResult = await txAuth.api.signUpEmail({
          body: { email: fresh.email, name: input.name, password: input.password },
        });
        userId = signUpResult.user.id;
      }

      const existingMembership = await tx.query.member.findFirst({
        where: and(eq(member.organizationId, fresh.organizationId), eq(member.userId, userId)),
      });
      if (!existingMembership) {
        await tx.insert(member).values({
          id: `mem_${userId}_${fresh.organizationId}`,
          organizationId: fresh.organizationId,
          userId,
          role: fresh.role,
          createdAt: new Date(),
        });
      }

      await tx
        .update(invitations)
        .set({ status: 'accepted', acceptedAt: new Date(), acceptedByUserId: userId })
        .where(eq(invitations.id, fresh.id));

      await insertAuditEventRow(tx, {
        organizationId: fresh.organizationId,
        actorUserId: userId,
        actorApiKeyId: null,
        action: 'organization.invitation.accepted',
        targetType: 'invitation',
        targetId: fresh.id,
        result: 'success',
        errorCode: null,
        requestId: input.requestId,
        metadata: buildAuditMetadata({ roleAfter: fresh.role }),
      }, metrics);

      return { userId, organizationId: fresh.organizationId };
    });
  }

  return { createInvitation, acceptInvitation };
}

export type InvitationService = ReturnType<typeof createInvitationService>;
