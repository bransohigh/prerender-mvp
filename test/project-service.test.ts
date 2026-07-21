import { describe, expect, it } from 'vitest';
import { createFakeProjectRepository } from '../src/repositories/fake/fake-project-repository.js';
import { createProjectService } from '../src/services/project-service.js';
import { AppError } from '../src/lib/app-error.js';

describe('ProjectService', () => {
  it('creates a project with an explicit slug', async () => {
    const service = createProjectService(createFakeProjectRepository());
    const project = await service.createProject({ name: 'Example', slug: 'example' });
    expect(project.slug).toBe('example');
    expect(project.status).toBe('active');
  });

  it('derives a slug from the name when none given', async () => {
    const service = createProjectService(createFakeProjectRepository());
    const project = await service.createProject({ name: 'My Cool Project' });
    expect(project.slug).toBe('my-cool-project');
  });

  it('rejects duplicate slugs', async () => {
    const service = createProjectService(createFakeProjectRepository());
    await service.createProject({ name: 'A', slug: 'dup' });
    await expect(service.createProject({ name: 'B', slug: 'dup' })).rejects.toMatchObject({
      code: 'PROJECT_SLUG_CONFLICT',
    });
  });

  it('getProject throws PROJECT_NOT_FOUND for unknown id', async () => {
    const service = createProjectService(createFakeProjectRepository());
    await expect(service.getProject('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(AppError);
  });

  it('getProject throws for a soft-deleted project', async () => {
    const service = createProjectService(createFakeProjectRepository());
    const project = await service.createProject({ name: 'A', slug: 'a' });
    await service.deleteProject(project.id);
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('updateProject only changes allowed fields', async () => {
    const service = createProjectService(createFakeProjectRepository());
    const project = await service.createProject({ name: 'A', slug: 'a' });
    const updated = await service.updateProject(project.id, { name: 'B' });
    expect(updated.name).toBe('B');
    expect(updated.slug).toBe('a');
  });

  it('deleteProject sets status to deleted (soft delete, not physical)', async () => {
    const service = createProjectService(createFakeProjectRepository());
    const project = await service.createProject({ name: 'A', slug: 'a' });
    const deleted = await service.deleteProject(project.id);
    expect(deleted.status).toBe('deleted');
  });

  it('listProjects paginates with a cursor', async () => {
    const service = createProjectService(createFakeProjectRepository());
    for (let i = 0; i < 5; i++) {
      await service.createProject({ name: `P${i}`, slug: `p${i}` });
    }
    const page1 = await service.listProjects(2, null);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await service.listProjects(2, page1.nextCursor);
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
  });

  it('listProjects excludes deleted projects', async () => {
    const service = createProjectService(createFakeProjectRepository());
    const project = await service.createProject({ name: 'A', slug: 'a' });
    await service.deleteProject(project.id);
    const page = await service.listProjects(20, null);
    expect(page.items.find((p) => p.id === project.id)).toBeUndefined();
  });
});
