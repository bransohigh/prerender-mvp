import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDbClient, truncateAll } from './helpers.js';
import {
  bootstrapOwner,
  BootstrapOwnerError,
  MIN_OWNER_PASSWORD_LENGTH,
} from '../../src/services/bootstrap-owner-service.js';
import { user as userTable, member as memberTable, organization as organizationTable } from '../../src/db/schema.js';
import type { DbClient } from '../../src/db/client.js';

let client: DbClient;

beforeEach(async () => {
  client ??= createTestDbClient();
  await truncateAll(client);
});

afterAll(async () => {
  await client?.close();
});

const validInput = {
  email: 'first-owner@example.com',
  name: 'First Owner',
  password: 'correct-horse-battery-staple',
};

describe('bootstrapOwner', () => {
  it('succeeds against an empty user table and creates user + org + owner membership atomically', async () => {
    const result = await bootstrapOwner(client.db, validInput);

    const users = await client.db.select().from(userTable).where(eq(userTable.id, result.userId));
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe(validInput.email);

    const orgs = await client.db
      .select()
      .from(organizationTable)
      .where(eq(organizationTable.id, result.organizationId));
    expect(orgs).toHaveLength(1);

    const members = await client.db.select().from(memberTable).where(eq(memberTable.userId, result.userId));
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe('owner');
    expect(members[0]!.organizationId).toBe(result.organizationId);
  });

  it('rejects a second bootstrap once a user exists', async () => {
    await bootstrapOwner(client.db, validInput);

    await expect(
      bootstrapOwner(client.db, { email: 'second@example.com', name: 'Second', password: validInput.password }),
    ).rejects.toThrow(BootstrapOwnerError);

    const users = await client.db.select().from(userTable);
    expect(users).toHaveLength(1);
  });

  it('rejects a password shorter than the minimum length', async () => {
    await expect(
      bootstrapOwner(client.db, { ...validInput, password: 'short' }),
    ).rejects.toThrow(BootstrapOwnerError);
    expect(MIN_OWNER_PASSWORD_LENGTH).toBe(12);

    const users = await client.db.select().from(userTable);
    expect(users).toHaveLength(0);
  });

  it('rejects a password containing control characters', async () => {
    const withControlChar = `${validInput.password}${String.fromCharCode(1)}`;
    await expect(
      bootstrapOwner(client.db, { ...validInput, password: withControlChar }),
    ).rejects.toThrow(BootstrapOwnerError);

    const users = await client.db.select().from(userTable);
    expect(users).toHaveLength(0);
  });

  it('rejects empty email or name', async () => {
    await expect(bootstrapOwner(client.db, { ...validInput, email: '' })).rejects.toThrow(BootstrapOwnerError);
    await expect(bootstrapOwner(client.db, { ...validInput, name: '' })).rejects.toThrow(BootstrapOwnerError);
  });

  it('rolls back the user row if organization creation fails', async () => {
    // An invalid slug (empty) causes Better Auth's createOrganization to
    // reject the request after the user has already been created within
    // the same transaction — the transaction must roll back both.
    await expect(
      bootstrapOwner(client.db, { ...validInput, orgSlug: '' }),
    ).rejects.toThrow();

    const users = await client.db.select().from(userTable);
    expect(users).toHaveLength(0);
    const orgs = await client.db.select().from(organizationTable);
    expect(orgs).toHaveLength(0);
  });
});
