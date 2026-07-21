import { and, asc, eq, gt, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { domains } from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import type {
  Domain,
  DomainRepository,
  CreateDomainInput,
  PageResult,
} from '../types.js';

const UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const direct = (err as { code?: string }).code;
  if (direct) return direct;
  // Newer drizzle-orm versions wrap the raw pg error under `.cause`
  // (DrizzleQueryError) instead of exposing `.code` directly.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    return (cause as { code?: string }).code;
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === UNIQUE_VIOLATION;
}

export function createPostgresDomainRepository(db: Database): DomainRepository {
  return {
    async create(input: CreateDomainInput): Promise<Domain> {
      try {
        const [row] = await db
          .insert(domains)
          .values({
            projectId: input.projectId,
            hostname: input.hostname,
            normalizedHostname: input.normalizedHostname,
            verificationMethod: input.verificationMethod,
            verificationTokenHash: input.verificationTokenHash,
          })
          .returning();
        return row as Domain;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('DOMAIN_ALREADY_EXISTS', `Domain already registered: ${input.normalizedHostname}`);
        }
        throw err;
      }
    },

    async findById(id: string): Promise<Domain | null> {
      const [row] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
      return (row as Domain) ?? null;
    },

    async findByNormalizedHostname(normalizedHostname: string): Promise<Domain | null> {
      const [row] = await db
        .select()
        .from(domains)
        .where(
          and(eq(domains.normalizedHostname, normalizedHostname), ne(domains.status, 'suspended')),
        )
        .limit(1);
      return (row as Domain) ?? null;
    },

    async listByProject(projectId, options): Promise<PageResult<Domain>> {
      const conditions = [eq(domains.projectId, projectId)];
      if (options.cursor) {
        conditions.push(gt(domains.id, options.cursor));
      }
      const rows = await db
        .select()
        .from(domains)
        .where(and(...conditions))
        .orderBy(asc(domains.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit) as Domain[];
      return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
    },

    async rotateVerificationToken(id: string, newTokenHash: string): Promise<Domain | null> {
      const [existing] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
      if (!existing) return null;
      const wasVerified = existing.status === 'verified';
      const [row] = await db
        .update(domains)
        .set({
          verificationTokenHash: newTokenHash,
          status: wasVerified ? 'pending' : existing.status,
          verifiedAt: wasVerified ? null : existing.verifiedAt,
          updatedAt: new Date(),
        })
        .where(eq(domains.id, id))
        .returning();
      return (row as Domain) ?? null;
    },

    async markVerificationAttempt(id, result): Promise<Domain | null> {
      const now = new Date();
      if (result.success) {
        const [row] = await db
          .update(domains)
          .set({
            status: 'verified',
            verifiedAt: now,
            lastVerificationAttemptAt: now,
            verificationFailureCount: 0,
            updatedAt: now,
          })
          .where(eq(domains.id, id))
          .returning();
        return (row as Domain) ?? null;
      }

      const [existing] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
      if (!existing) return null;
      const [row] = await db
        .update(domains)
        .set({
          status: existing.status === 'verified' ? 'verified' : 'failed',
          lastVerificationAttemptAt: now,
          verificationFailureCount: existing.verificationFailureCount + 1,
          updatedAt: now,
        })
        .where(eq(domains.id, id))
        .returning();
      return (row as Domain) ?? null;
    },
  };
}
