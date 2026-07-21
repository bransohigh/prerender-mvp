// Stable application error codes with fixed HTTP status mappings. Route
// handlers catch AppError and send { error: code, message } — raw
// database/DNS/XML-parser/HTTP-client errors never reach the response.

export type AppErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_SLUG_CONFLICT'
  | 'DOMAIN_NOT_FOUND'
  | 'DOMAIN_ALREADY_EXISTS'
  | 'DOMAIN_NOT_VERIFIED'
  | 'DOMAIN_VERIFICATION_FAILED'
  | 'DOMAIN_VERIFICATION_RATE_LIMITED'
  | 'DOMAIN_VERIFICATION_IN_PROGRESS'
  | 'VERIFICATION_TOKEN_INVALID'
  | 'SITEMAP_SOURCE_NOT_FOUND'
  | 'SITEMAP_NOT_FOUND'
  | 'SITEMAP_FETCH_FAILED'
  | 'SITEMAP_TOO_LARGE'
  | 'SITEMAP_PARSE_FAILED'
  | 'SITEMAP_LIMIT_EXCEEDED'
  | 'URL_DOMAIN_MISMATCH'
  | 'INVALID_DOMAIN'
  | 'INVALID_RENDER_URL'
  | 'DATABASE_UNAVAILABLE';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  PROJECT_NOT_FOUND: 404,
  PROJECT_SLUG_CONFLICT: 409,
  DOMAIN_NOT_FOUND: 404,
  DOMAIN_ALREADY_EXISTS: 409,
  DOMAIN_NOT_VERIFIED: 409,
  DOMAIN_VERIFICATION_FAILED: 422,
  DOMAIN_VERIFICATION_RATE_LIMITED: 429,
  DOMAIN_VERIFICATION_IN_PROGRESS: 409,
  VERIFICATION_TOKEN_INVALID: 422,
  SITEMAP_SOURCE_NOT_FOUND: 404,
  SITEMAP_NOT_FOUND: 404,
  SITEMAP_FETCH_FAILED: 422,
  SITEMAP_TOO_LARGE: 422,
  SITEMAP_PARSE_FAILED: 422,
  SITEMAP_LIMIT_EXCEEDED: 422,
  URL_DOMAIN_MISMATCH: 400,
  INVALID_DOMAIN: 400,
  INVALID_RENDER_URL: 400,
  DATABASE_UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;

  constructor(code: AppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
