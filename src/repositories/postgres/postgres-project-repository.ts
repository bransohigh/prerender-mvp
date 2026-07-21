import { and, asc, eq, gt, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import type {
  Project,
  ProjectRepository,
  CreateProjectInput,
  UpdateProjectInput,
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

export function createPostgresProjectRepository(db: Database): ProjectRepository {
  return {
    async create(input: CreateProjectInput): Promise<Project> {
      try {
        const [row] = await db.insert(projects).values(input).returning();
        return row as Project;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('PROJECT_SLUG_CONFLICT', `Slug already in use: ${input.slug}`);
        }
        throw err;
      }
    },

    async findById(id: string): Promise<Project | null> {
      const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return (row as Project) ?? null;
    },

    async findBySlug(slug: string): Promise<Project | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.slug, slug), ne(projects.status, 'deleted')))
        .limit(1);
      return (row as Project) ?? null;
    },

    async list(options): Promise<PageResult<Project>> {
      const conditions = [ne(projects.status, 'deleted')];
      if (options.cursor) {
        conditions.push(gt(projects.id, options.cursor));
      }
      const rows = await db
        .select()
        .from(projects)
        .where(and(...conditions))
        .orderBy(asc(projects.id))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit) as Project[];
      return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
    },

    async update(id: string, input: UpdateProjectInput): Promise<Project | null> {
      try {
        const [row] = await db
          .update(projects)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning();
        return (row as Project) ?? null;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('PROJECT_SLUG_CONFLICT', `Slug already in use: ${input.slug}`);
        }
        throw err;
      }
    },

    async softDeleteWithCascade(id: string): Promise<Project | null> {
      // domains/sitemap_sources/discovered_urls cascade via FK ON DELETE
      // CASCADE only on hard delete — here we soft-delete the project only
      // (status='deleted'); child rows are left in place per "hard delete
      // yapma" for projects. Domains under a deleted project become
      // unreachable via the project API but are not separately deleted.
      const [row] = await db
        .update(projects)
        .set({ status: 'deleted', updatedAt: new Date() })
        .where(eq(projects.id, id))
        .returning();
      return (row as Project) ?? null;
    },
  };
}
