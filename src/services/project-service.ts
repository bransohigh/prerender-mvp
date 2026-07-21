import { AppError } from '../lib/app-error.js';
import { slugFromName } from '../lib/slug.js';
import type { Project, ProjectRepository, UpdateProjectInput } from '../repositories/types.js';

export interface CreateProjectRequest {
  name: string;
  slug?: string;
}

// Slug format is validated at the route layer (Zod schema) before reaching
// this service — this layer only handles lookup/uniqueness concerns.
export function createProjectService(repository: ProjectRepository) {
  return {
    async createProject(input: CreateProjectRequest): Promise<Project> {
      const slugCandidate = input.slug ? input.slug.toLowerCase() : slugFromName(input.name);
      return repository.create({ name: input.name, slug: slugCandidate });
    },

    async getProject(id: string): Promise<Project> {
      const project = await repository.findById(id);
      if (!project || project.status === 'deleted') {
        throw new AppError('PROJECT_NOT_FOUND', `Project not found: ${id}`);
      }
      return project;
    },

    async listProjects(limit: number, cursor?: string | null) {
      return repository.list({ limit, cursor });
    },

    async updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
      const updated = await repository.update(
        id,
        input.slug !== undefined ? { ...input, slug: input.slug.toLowerCase() } : input,
      );
      if (!updated) {
        throw new AppError('PROJECT_NOT_FOUND', `Project not found: ${id}`);
      }
      return updated;
    },

    async deleteProject(id: string): Promise<Project> {
      const deleted = await repository.softDeleteWithCascade(id);
      if (!deleted) {
        throw new AppError('PROJECT_NOT_FOUND', `Project not found: ${id}`);
      }
      return deleted;
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
