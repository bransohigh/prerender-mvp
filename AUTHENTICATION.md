# Authentication

Two independent authentication mechanisms exist. They are never
interchangeable — a browser session cannot render, and a render API key
cannot manage organizations/projects/domains.

## Browser session (management)

- Better Auth email/password, DB-backed opaque session cookie.
- Mounted at `/api/auth/*` (login: `POST /api/auth/sign-in/email`, logout:
  `POST /api/auth/sign-out`, current session: `GET /api/auth/get-session`).
- No public sign-up — `POST /api/auth/sign-up/*` is blocked (404) at the
  route layer. New users only join via invitation
  (`POST /v1/organizations/:organizationId/invitations` →
  `POST /v1/onboarding/accept`).
- First user/organization: `npm run auth:bootstrap-owner -- --email=<email> --name=<name>`
  (password via interactive TTY prompt only — never a CLI argument).
- Cookie: `prerender.session_token` in development, `__Secure-prerender.session_token`
  in production (HttpOnly, Secure in production, SameSite=Lax, Path=/, no
  Domain attribute). See TENANCY.md for the exact `__Secure-` vs `__Host-`
  clarification.
- Session lifetime 7 days, rolling refresh every 24h of activity. Logout
  invalidates the session server-side immediately.
- All `/v1/organizations/...` management routes require this session.
  Mutating requests additionally require an exact trusted `Origin` header
  (403 `CSRF_ORIGIN_REJECTED` otherwise — see SECURITY.md).
- Login is rate-limited by source IP and by an HMAC digest of the
  normalized email (never the raw email) — see SECURITY.md "Rate limiting".

## Project-scoped render API key (rendering only)

- Header: `x-render-api-key: pr_live_...`
- Created via `POST /v1/organizations/:organizationId/projects/:projectId/api-keys`
  (owner/admin only). Plaintext key shown exactly once, in the creation
  (and rotation) response — never retrievable again.
- `GET .../api-keys` returns only `id, name, prefix, status, createdAt,
  expiresAt, revokedAt, lastUsedAt` — never the key or its hash.
- `DELETE .../api-keys/:keyId` revokes (not physically deletes) the key —
  instantly invalid afterward.
- `POST .../api-keys/:keyId/rotate` — one atomic Postgres transaction:
  locks the original key row, creates the successor, revokes the original,
  records the rotation link. Concurrent rotation attempts on the same key
  are serialized by the row lock; exactly one succeeds.
- Key storage: Better Auth's own `apikey` table (256-bit random secret,
  SHA-256 hashed via a local wrapper around the plugin's `defaultKeyHasher`
  export — see `src/repositories/postgres/api-key-repository.ts`).
  `projectId`/`createdByUserId`/`revokedAt`/`rotatedFromKeyId`/
  `rotatedToKeyId` live in the key's `metadata` JSON (validated fail-closed
  on every read — malformed metadata is treated as "not found").
- `POST /v1/render` accepts **only** `x-render-api-key`. It rejects: the
  old global key, `x-api-key`, a key in the request body or query string,
  and any browser session (even a valid one, even for an owner).
- Render authorization order (all before a capacity slot is taken):
  header format → invalid-key IP rate limit → Better Auth key verification
  → metadata validation → organization active → project active + matches
  key's project → domain belongs to that exact project → domain verified
  → URL normalized + exact hostname match → SSRF/public-URL check →
  valid-key rate limit (by key id) → capacity → Chromium.
- `lastUsedAt` is Better Auth's own `apikey.lastRequest` column, updated
  automatically by `auth.api.verifyApiKey`'s built-in rate-limit tracking
  on every *successful* verification — never on an invalid/expired/revoked
  attempt.

## Breaking change (Checkpoint 3B)

The global `ADMIN_API_KEY` and `RENDER_API_KEY` environment variables, and
the `x-admin-api-key` header, have been removed entirely — there is no
fallback. Old unscoped management endpoints (`/v1/projects`, `/v1/domains`,
`/v1/sitemap-sources/...`) return `410 Gone` regardless of any header
presented. Deployments must set `BETTER_AUTH_SECRET`, `BETTER_AUTH_BASE_URL`,
and `AUTH_TRUSTED_ORIGINS` instead, run `npm run auth:bootstrap-owner` once,
and create project-scoped keys through the API for rendering.

## Render API is never browser-callable via CORS (Checkpoint 3C-3)

`/v1/render` is never registered with the cookie-session CSRF Origin hook
(it isn't cookie-authenticated), and management CORS's `allowedHeaders`
allowlist deliberately excludes `x-render-api-key` — so even if a browser
attempted a cross-origin credentialed request to it, the preflight would
fail before the actual request is sent. A browser session (even a valid
owner session) never authenticates a render request, and the presence or
absence of an `Origin` header never changes render-key authorization
either way. See SECURITY.md's CSRF/CORS section and TENANCY.md's route
security-class separation.

## Not implemented in this phase

2FA, social login, password-reset email, ownership transfer.
