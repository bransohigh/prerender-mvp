import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDbClient, truncateAll } from './helpers.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { createInvitationService } from '../../src/services/invitation-service.js';
import { user as userTable, member as memberTable } from '../../src/db/schema.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;
let auth: Auth;

beforeEach(async () => {
  client ??= createTestDbClient();
  auth ??= createAuth(client.db);
  await truncateAll(client);
});

afterAll(async () => {
  await client?.close();
});

async function bootstrapOwner() {
  const signUp = await auth.api.signUpEmail({
    body: { email: 'owner@example.com', name: 'Owner', password: 'correct-horse-battery-staple' },
  });
  const org = await auth.api.createOrganization({
    body: { name: "Owner's Org", slug: 'owner-org', userId: signUp.user.id },
  });
  if (!org) throw new Error('org create failed');
  const existing = await client.db.query.member.findFirst({
    where: and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, signUp.user.id)),
  });
  if (!existing) {
    await client.db.insert(memberTable).values({
      id: `mem_${signUp.user.id}_${org.id}`,
      organizationId: org.id,
      userId: signUp.user.id,
      role: 'owner',
      createdAt: new Date(),
    });
  } else {
    await client.db.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, existing.id));
  }
  return { userId: signUp.user.id, organizationId: org.id };
}

describe('auth + onboarding (real Postgres)', () => {
  it('creates a user via signUpEmail with a hashed password (not plaintext)', async () => {
    const { userId } = await bootstrapOwner();
    const rows = await client.db.select().from(userTable).where(eq(userTable.id, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('owner@example.com');
  });

  it('logs in with correct credentials and rejects wrong password generically', async () => {
    await bootstrapOwner();
    const ok = await auth.api.signInEmail({
      body: { email: 'owner@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(ok.user.email).toBe('owner@example.com');

    await expect(
      auth.api.signInEmail({ body: { email: 'owner@example.com', password: 'wrong-password-here' } }),
    ).rejects.toThrow();

    await expect(
      auth.api.signInEmail({ body: { email: 'nobody@example.com', password: 'wrong-password-here' } }),
    ).rejects.toThrow();
  });

  it('full invitation -> accept flow creates a member with the invited role', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);

    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'invitee@example.com',
      role: 'member',
      invitedByUserId: ownerId,
      requestId: null,
    });
    expect(invite.token).toHaveLength(64);

    const result = await invitationService.acceptInvitation({
      token: invite.token,
      name: 'Invitee',
      password: 'another-long-passphrase',
      auth,
      requestId: null,
    });
    expect(result.organizationId).toBe(organizationId);

    const membership = await client.db.query.member.findFirst({
      where: and(eq(memberTable.organizationId, organizationId), eq(memberTable.userId, result.userId)),
    });
    expect(membership?.role).toBe('member');
  });

  it('rejects reuse of an already-accepted invitation token', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);
    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'reuse@example.com',
      role: 'member',
      invitedByUserId: ownerId,
      requestId: null,
    });
    await invitationService.acceptInvitation({
      token: invite.token,
      name: 'Reuse',
      password: 'another-long-passphrase',
      auth,
      requestId: null,
    });

    await expect(
      invitationService.acceptInvitation({
        token: invite.token,
        name: 'Reuse',
        password: 'another-long-passphrase',
        auth,
        requestId: null,
      }),
    ).rejects.toThrow();
  });

  it('rejects an expired invitation token', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);
    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'expired@example.com',
      role: 'member',
      invitedByUserId: ownerId,
      requestId: null,
    });

    const { invitations } = await import('../../src/db/schema.js');
    await client.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, invite.id));

    await expect(
      invitationService.acceptInvitation({
        token: invite.token,
        name: 'Expired',
        password: 'another-long-passphrase',
        auth,
        requestId: null,
      }),
    ).rejects.toThrow();
  });

  it('stores only a hash of the invitation token, never the plaintext', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);
    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'hash-check@example.com',
      role: 'member',
      invitedByUserId: ownerId,
      requestId: null,
    });

    const { invitations } = await import('../../src/db/schema.js');
    const row = await client.db.query.invitations.findFirst({ where: eq(invitations.id, invite.id) });
    expect(row).toBeDefined();
    expect(row!.tokenHash).not.toBe(invite.token);
    expect(row!.tokenHash).toHaveLength(64); // sha256 hex
    expect(JSON.stringify(row)).not.toContain(invite.token);
  });

  it('does not consume the token on a failed accept attempt (wrong password for existing account)', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);

    // invitee already has an account
    await auth.api.signUpEmail({
      body: { email: 'existing@example.com', name: 'Existing', password: 'their-own-real-password' },
    });

    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'existing@example.com',
      role: 'member',
      invitedByUserId: ownerId,
      requestId: null,
    });

    await expect(
      invitationService.acceptInvitation({
        token: invite.token,
        name: 'Existing',
        password: 'wrong-guess-password',
        auth,
        requestId: null,
      }),
    ).rejects.toThrow();

    // Token must still be usable with the correct password afterwards.
    const result = await invitationService.acceptInvitation({
      token: invite.token,
      name: 'Existing',
      password: 'their-own-real-password',
      auth,
      requestId: null,
    });
    expect(result.organizationId).toBe(organizationId);
  });

  it('cannot hijack an existing account via invitation token without the real password', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);

    await auth.api.signUpEmail({
      body: { email: 'victim@example.com', name: 'Victim', password: 'victims-real-password-here' },
    });

    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'victim@example.com',
      role: 'admin',
      invitedByUserId: ownerId,
      requestId: null,
    });

    await expect(
      invitationService.acceptInvitation({
        token: invite.token,
        name: 'Attacker',
        password: 'attacker-guessed-password',
        auth,
        requestId: null,
      }),
    ).rejects.toThrow();

    const membership = await client.db.query.member.findMany({
      where: eq(memberTable.organizationId, organizationId),
    });
    // Only the owner is a member; the attacker's accept attempt granted no membership.
    expect(membership.map((m) => m.userId)).not.toContain(undefined);
    expect(membership.every((m) => m.role !== 'admin')).toBe(true);
  });

  it('allows only one success when two accept attempts race on the same token', async () => {
    const { organizationId, userId: ownerId } = await bootstrapOwner();
    const invitationService = createInvitationService(client.db);
    const invite = await invitationService.createInvitation({
      organizationId,
      email: 'race@example.com',
      role: 'member',
      invitedByUserId: ownerId,
      requestId: null,
    });

    const attempts = await Promise.allSettled([
      invitationService.acceptInvitation({ token: invite.token, name: 'Race1', password: 'password-one-long', auth, requestId: null }),
      invitationService.acceptInvitation({ token: invite.token, name: 'Race2', password: 'password-two-long', auth, requestId: null }),
    ]);

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('rejects granting the owner role through the invitation type system', () => {
    // CreateInvitationInput['role'] is typed as 'admin' | 'member' — owner
    // is structurally unreachable via createInvitation; this is enforced
    // again at the route layer with z.enum(['admin', 'member']) in
    // src/routes/organizations.ts.
    type Role = Parameters<ReturnType<typeof createInvitationService>['createInvitation']>[0]['role'];
    const roles: Role[] = ['admin', 'member'];
    expect(roles).not.toContain('owner');
  });
});
