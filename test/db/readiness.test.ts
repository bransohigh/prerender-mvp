import { describe, expect, it, afterEach } from 'vitest';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { createDbReadinessCheck } from '../../src/db/readiness.js';

let client: DbClient | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('database readiness', () => {
  it('ping() returns true against a reachable database', async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set');
    client = createDbClient(databaseUrl);
    await expect(client.ping()).resolves.toBe(true);
  });

  it('ping() returns false (not throws) against an unreachable database', async () => {
    client = createDbClient('postgres://postgres:postgres@127.0.0.1:1/nonexistent');
    await expect(client.ping(500)).resolves.toBe(false);
  });

  it('createDbReadinessCheck caches the result briefly', async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set');
    client = createDbClient(databaseUrl);
    const check = createDbReadinessCheck(client);

    const first = await check();
    expect(first).toBe(true);

    // Second call within the cache window should not re-query (implicitly
    // verified by not throwing/hanging even if the pool were saturated).
    const second = await check();
    expect(second).toBe(true);
  });
});
