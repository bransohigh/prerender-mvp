// Central owner/admin/member permission matrix. Every organization-scoped
// route checks a permission from this list via requireOrganizationPermission
// (src/auth/tenant-context.ts) — no route hand-rolls its own role check, so
// the matrix stays in one place and is unit-testable on its own.

export type OrganizationRole = 'owner' | 'admin' | 'member';

export type OrganizationPermission =
  | 'organization.read'
  | 'organization.update'
  | 'organization.delete'
  | 'member.list'
  | 'member.role.change'
  | 'member.remove'
  | 'invitation.create.member'
  | 'invitation.create.admin'
  | 'invitation.list'
  | 'invitation.cancel'
  | 'project.read'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'domain.read'
  | 'domain.create'
  | 'domain.update'
  | 'domain.verify'
  | 'domain.rotate_token'
  | 'sitemap.read'
  | 'sitemap.discover'
  | 'sitemap.fetch'
  | 'api_key.create'
  | 'api_key.list'
  | 'api_key.revoke'
  | 'api_key.rotate'
  | 'audit.read';

const OWNER_PERMISSIONS: OrganizationPermission[] = [
  'organization.read',
  'organization.update',
  'organization.delete',
  'member.list',
  'member.role.change',
  'member.remove',
  'invitation.create.member',
  'invitation.create.admin',
  'invitation.list',
  'invitation.cancel',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'domain.read',
  'domain.create',
  'domain.update',
  'domain.verify',
  'domain.rotate_token',
  'sitemap.read',
  'sitemap.discover',
  'sitemap.fetch',
  'api_key.create',
  'api_key.list',
  'api_key.revoke',
  'api_key.rotate',
  'audit.read',
];

const ADMIN_PERMISSIONS: OrganizationPermission[] = [
  'organization.read',
  'member.list',
  'invitation.create.member',
  'invitation.create.admin',
  'invitation.list',
  'invitation.cancel',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'domain.read',
  'domain.create',
  'domain.update',
  'domain.verify',
  'domain.rotate_token',
  'sitemap.read',
  'sitemap.discover',
  'sitemap.fetch',
  'api_key.create',
  'api_key.list',
  'api_key.revoke',
  'api_key.rotate',
  'audit.read',
  // Deliberately excluded: organization.update/delete, member.role.change,
  // member.remove (of an owner), invitation targeting the owner role.
];

const MEMBER_PERMISSIONS: OrganizationPermission[] = [
  'organization.read',
  'member.list',
  'project.read',
  'domain.read',
  'sitemap.read',
  // Read-only: no create/update/delete/verify/rotate/invite/api-key/audit
  // permissions.
];

const MATRIX: Record<OrganizationRole, ReadonlySet<OrganizationPermission>> = {
  owner: new Set(OWNER_PERMISSIONS),
  admin: new Set(ADMIN_PERMISSIONS),
  member: new Set(MEMBER_PERMISSIONS),
};

export function roleHasPermission(role: OrganizationRole, permission: OrganizationPermission): boolean {
  return MATRIX[role].has(permission);
}

// admin may invite 'member' or 'admin' but never 'owner' (ownership transfer
// is out of scope entirely); owner has the same restriction — there is no
// permission that grants the owner role via invitation anywhere in this
// matrix, by design.
export function roleCanInvite(role: OrganizationRole, targetRole: 'admin' | 'member'): boolean {
  if (targetRole === 'admin') return roleHasPermission(role, 'invitation.create.admin');
  return roleHasPermission(role, 'invitation.create.member');
}
