const MAX_SLUG_LENGTH = 63;

export function normalizeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/g, '');
  return slug;
}

export function slugFromName(name: string): string {
  const base = normalizeSlug(name);
  return base.length > 0 ? base : 'project';
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && slug.length <= MAX_SLUG_LENGTH;
}
