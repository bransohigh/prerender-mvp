import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/app-error.js';
import type {
  Project,
  ProjectRepository,
  CreateProjectInput,
  UpdateProjectInput,
  PageResult,
} from '../types.js';

export function createFakeProjectRepository(): ProjectRepository {
  const store = new Map<string, Project>();

  return {
    async create(input: CreateProjectInput): Promise<Project> {
      const existing = [...store.values()].find(
        (p) => p.slug === input.slug && p.status !== 'deleted',
      );
      if (existing) {
        throw new AppError('PROJECT_SLUG_CONFLICT', `Slug already in use: ${input.slug}`);
      }
      const now = new Date();
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        slug: input.slug,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      store.set(project.id, project);
      return project;
    },

    async findById(id: string): Promise<Project | null> {
      return store.get(id) ?? null;
    },

    async findBySlug(slug: string): Promise<Project | null> {
      return [...store.values()].find((p) => p.slug === slug && p.status !== 'deleted') ?? null;
    },

    async list(options): Promise<PageResult<Project>> {
      const all = [...store.values()]
        .filter((p) => p.status !== 'deleted')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const startIndex = options.cursor
        ? all.findIndex((p) => p.id === options.cursor) + 1
        : 0;
      const page = all.slice(startIndex, startIndex + options.limit);
      const nextCursor =
        startIndex + options.limit < all.length ? page[page.length - 1]?.id ?? null : null;
      return { items: page, nextCursor };
    },

    async update(id: string, input: UpdateProjectInput): Promise<Project | null> {
      const project = store.get(id);
      if (!project) return null;
      if (input.slug && input.slug !== project.slug) {
        const conflict = [...store.values()].find(
          (p) => p.slug === input.slug && p.id !== id && p.status !== 'deleted',
        );
        if (conflict) {
          throw new AppError('PROJECT_SLUG_CONFLICT', `Slug already in use: ${input.slug}`);
        }
      }
      const updated: Project = {
        ...project,
        ...input,
        updatedAt: new Date(),
      };
      store.set(id, updated);
      return updated;
    },

    async softDeleteWithCascade(id: string): Promise<Project | null> {
      const project = store.get(id);
      if (!project) return null;
      const updated: Project = { ...project, status: 'deleted', updatedAt: new Date() };
      store.set(id, updated);
      return updated;
    },
  };
}
