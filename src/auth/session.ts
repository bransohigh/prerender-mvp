import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/app-error.js';
import type { Auth } from './auth.js';

export interface SessionContext {
  userId: string;
  email: string;
  activeOrganizationId: string | null;
}

function requestToHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }
  return headers;
}

// Reads the opaque session cookie via Better Auth's own session lookup —
// never trusts a client-supplied user/org id directly. Throws
// AppError('UNAUTHENTICATED') if there is no valid session, which route
// handlers surface as a generic 401 (no distinction between "no cookie" and
// "expired session" is given to the client, matching the enumeration-safety
// posture used for login).
export async function requireSession(request: FastifyRequest, auth: Auth): Promise<SessionContext> {
  const result = await auth.api.getSession({ headers: requestToHeaders(request) });
  if (!result?.session || !result.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return {
    userId: result.user.id,
    email: result.user.email,
    activeOrganizationId: result.session.activeOrganizationId ?? null,
  };
}
