import { sql } from 'drizzle-orm';
import { createAuth, type Auth } from '../auth/auth.js';
import { user as userTable, member as memberTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

export const MIN_OWNER_PASSWORD_LENGTH = 12;

export interface BootstrapOwnerInput {
  email: string;
  name: string;
  password: string;
  orgName?: string;
  orgSlug?: string;
}

export interface BootstrapOwnerResult {
  userId: string;
  organizationId: string;
  email: string;
}

export class BootstrapOwnerError extends Error {}

function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isC0 = code <= 31;
    const isDel = code === 127;
    const isTab = code === 9;
    if ((isC0 && !isTab) || isDel) {
      return true;
    }
  }
  return false;
}

// Reusable transactional logic behind `npm run auth:bootstrap-owner` (the
// CLI wrapper only handles argv/stdin). Only runs when the `user` table is
// empty at the time the transaction commits — checked both before and
// inside the transaction to close the pre-check/write race window. Creates
// the first user (via Better Auth, so the password goes through the same
// hashing path as normal signup), the first organization, and an owner
// membership, all atomically: any failure after the user is created (e.g.
// organization creation) rolls back the user row too.
export async function bootstrapOwner(db: Database, input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
  if (input.email.length === 0 || input.name.length === 0) {
    throw new BootstrapOwnerError('email and name are required.');
  }
  if (input.password.length === 0) {
    throw new BootstrapOwnerError('password is required.');
  }
  if (containsControlCharacter(input.password)) {
    throw new BootstrapOwnerError('Password must not contain control characters.');
  }
  if (input.password.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new BootstrapOwnerError(`Password must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`);
  }

  const preCheck = await db.select({ id: userTable.id }).from(userTable).limit(1);
  if (preCheck.length > 0) {
    throw new BootstrapOwnerError('Refusing: the user table is not empty. bootstrap-owner only runs once.');
  }

  return db.transaction(async (tx) => {
    const raceCheck = await tx.select({ id: userTable.id }).from(userTable).limit(1);
    if (raceCheck.length > 0) {
      throw new BootstrapOwnerError('Refusing: the user table is not empty (race detected).');
    }

    const txAuth: Auth = createAuth(tx as unknown as Database);

    const signUpResult = await txAuth.api.signUpEmail({
      body: { email: input.email, name: input.name, password: input.password },
    });
    const newUserId = signUpResult.user.id;

    const slug = input.orgSlug ?? `org-${newUserId.slice(0, 8)}`;
    const org = await txAuth.api.createOrganization({
      body: {
        name: input.orgName ?? `${input.name}'s Organization`,
        slug,
        userId: newUserId,
      },
    });
    if (!org) {
      throw new BootstrapOwnerError('Organization creation failed');
    }

    const members = await tx
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(sql`${memberTable.organizationId} = ${org.id} AND ${memberTable.userId} = ${newUserId}`);

    if (members.length === 0) {
      // createOrganization did not auto-add the creator (depends on plugin
      // config) — add explicitly as owner.
      await tx.insert(memberTable).values({
        id: `mem_${newUserId}_${org.id}`,
        organizationId: org.id,
        userId: newUserId,
        role: 'owner',
        createdAt: new Date(),
      });
    } else {
      await tx
        .update(memberTable)
        .set({ role: 'owner' })
        .where(sql`${memberTable.organizationId} = ${org.id} AND ${memberTable.userId} = ${newUserId}`);
    }

    return { userId: newUserId, organizationId: org.id, email: input.email };
  });
}
