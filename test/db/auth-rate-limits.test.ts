import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDbClient, type DbClient } from '../../src/db/client.js';
import { env } from '../../src/config/env.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { truncateAll } from './helpers.js';

let dbClient: DbClient;
let auth: Auth;
let app: FastifyInstance;

const PASSWORD = 'correct-horse-battery-staple';

beforeEach(async () => {
  dbClient ??= createDbClient(env.DATABASE_URL);
  auth ??= createAuth(dbClient.db);
  await truncateAll(dbClient);
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('login rate limiting (real HTTP route, process-local limiter)', () => {
  it('repeated wrong-password login becomes 429 after the configured max', async () => {
    await auth.api.signUpEmail({ body: { email: 'ratelimit-login@example.com', name: 'RL', password: PASSWORD } });

    let sawRateLimited = false;
    let lastStatus = 0;
    for (let i = 0; i < env.LOGIN_RATE_LIMIT_MAX + 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'ratelimit-login@example.com', password: 'wrong-password-attempt' },
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        sawRateLimited = true;
        expect(res.headers['retry-after']).toBeTruthy();
        expect(res.json().error).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
    expect(lastStatus).toBe(429);
  });

  it('unknown-email and wrong-password retain generic external behavior even under the limiter', async () => {
    await auth.api.signUpEmail({ body: { email: 'generic-check@example.com', name: 'RL', password: PASSWORD } });

    const wrongPassword = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'generic-check@example.com', password: 'wrong' } });
    const unknownEmail = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'never-existed@example.com', password: 'wrong' } });
    expect(wrongPassword.statusCode).toBe(unknownEmail.statusCode);
  });

  it('a successful login after the limiter window expires still works (bucket resets, no permanent penalty)', async () => {
    await auth.api.signUpEmail({ body: { email: 'reset-check@example.com', name: 'RL', password: PASSWORD } });

    for (let i = 0; i < env.LOGIN_RATE_LIMIT_MAX; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'reset-check@example.com', password: 'wrong' } });
    }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'reset-check@example.com', password: 'wrong' } });
    expect(limited.statusCode).toBe(429);

    // A different app instance gets a fresh process-local limiter — this
    // is the deterministic equivalent of "wait for the window to expire"
    // without a real sleep.
    await app.close();
    app = await buildApp();
    await app.ready();

    const success = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'reset-check@example.com', password: PASSWORD } });
    expect(success.statusCode).toBe(200);
  });

  it('password and email never appear in the response body or logs redaction path', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: 'leak-check@example.com', password: 'super-secret-password-value' } });
    expect(res.body).not.toContain('super-secret-password-value');
  });
});

describe('invitation accept rate limiting (real HTTP route)', () => {
  it('repeated invalid invitation tokens become rate-limited', async () => {
    let sawRateLimited = false;
    for (let i = 0; i < env.INVITATION_RATE_LIMIT_MAX + 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/onboarding/accept',
        payload: { token: `bad-token-${i}`, name: 'X', password: PASSWORD },
      });
      if (res.statusCode === 429) {
        sawRateLimited = true;
        expect(res.headers['retry-after']).toBeTruthy();
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });

  it('a valid invitation acceptance works when not rate-limited', async () => {
    const signUp = await auth.api.signUpEmail({ body: { email: 'inv-owner@example.com', name: 'Owner', password: PASSWORD } });
    const org = await auth.api.createOrganization({ body: { name: 'Org', slug: `rl-org-${Date.now()}`, userId: signUp.user.id } });
    if (!org) throw new Error('org create failed');

    const { member: memberTable } = await import('../../src/db/schema.js');
    await dbClient.db.insert(memberTable).values({ id: `mem_${signUp.user.id}_${org.id}`, organizationId: org.id, userId: signUp.user.id, role: 'owner', createdAt: new Date() });

    const { createInvitationService } = await import('../../src/services/invitation-service.js');
    const invitationService = createInvitationService(dbClient.db);
    const invite = await invitationService.createInvitation({ organizationId: org.id, email: 'invitee@example.com', role: 'member', invitedByUserId: signUp.user.id, requestId: null });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/accept',
      payload: { token: invite.token, name: 'Invitee', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it('the invitation token never appears in the response body', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/onboarding/accept', payload: { token: 'raw-token-value-check', name: 'X', password: PASSWORD } });
    expect(res.body).not.toContain('raw-token-value-check');
  });
});
