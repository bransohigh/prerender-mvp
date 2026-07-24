import { createHash } from 'node:crypto';

// Bump whenever renderer behavior changes in a way that affects generated
// HTML for an EXISTING profile input (e.g. a Chromium/Playwright upgrade
// that changes default rendering behavior) — this deliberately
// invalidates every existing cache identity built with the old version,
// even if none of the allowlisted fields below changed. This is separate
// from CACHE_KEY_VERSION (src/lib/cache-identity.ts), which is for the
// cache-key FORMULA itself, not renderer behavior.
export const RENDER_PROFILE_VERSION = 1;

// Only fields that genuinely change generated HTML belong here. Never
// requestId, API key, user id, organization name, timestamps, logging
// options, or any other field that doesn't affect the rendered output —
// this type is the allowlist; there is no path for extra properties to
// enter the fingerprint (see computeRenderProfileHash's explicit field
// list below, which ignores anything not named here).
export interface RenderProfileInput {
  waitStrategy?: string;
  timeoutProfile?: string;
  userAgentProfile?: string;
  javascriptEnabled?: boolean;
  resourceBlockingProfile?: string;
}

interface CanonicalRenderProfile {
  version: number;
  waitStrategy: string;
  timeoutProfile: string;
  userAgentProfile: string;
  javascriptEnabled: boolean;
  resourceBlockingProfile: string;
}

const DEFAULT_PROFILE: Omit<CanonicalRenderProfile, 'version'> = {
  waitStrategy: 'networkidle',
  timeoutProfile: 'default',
  userAgentProfile: 'default',
  javascriptEnabled: true,
  resourceBlockingProfile: 'default',
};

// Canonical serialization: JSON.stringify's replacer-array form fixes the
// key order to exactly this list regardless of the input object's own
// property insertion order, so two RenderProfileInput objects with the
// same values but different key order always hash identically.
const CANONICAL_KEY_ORDER: Array<keyof CanonicalRenderProfile> = [
  'version',
  'javascriptEnabled',
  'resourceBlockingProfile',
  'timeoutProfile',
  'userAgentProfile',
  'waitStrategy',
];

function canonicalize(input: RenderProfileInput): string {
  const merged: CanonicalRenderProfile = { version: RENDER_PROFILE_VERSION, ...DEFAULT_PROFILE, ...input };
  return JSON.stringify(merged, CANONICAL_KEY_ORDER);
}

export function computeRenderProfileHash(input: RenderProfileInput = {}): string {
  return createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}
