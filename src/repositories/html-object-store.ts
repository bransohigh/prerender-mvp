import type { CacheContentEncoding } from '../lib/cache-storage-key.js';

// Provider-independent HTML object storage interface (Phase 8A-2). No
// operation exposes AWS/Cloudflare/filesystem-specific types — callers
// interact only with these domain types. Every operation takes a
// server-generated, already-validated storage key (see
// src/lib/cache-storage-key.ts) — never a client-controlled string.
// Objects are never public; nothing here returns or accepts a public URL.

export interface HtmlObjectMetadata {
  contentEncoding: CacheContentEncoding;
  contentBytes: number;
  // Set by the store on write, when the provider can report it; may be
  // absent for adapters that don't track it. Not used for anything
  // security-relevant.
  createdAt?: Date;
}

export interface PutHtmlObjectInput {
  storageKey: string;
  body: Buffer;
  contentEncoding: CacheContentEncoding;
  // If true and the provider supports it, the write fails instead of
  // silently overwriting an existing object at the same key. Since keys
  // are content-addressed and immutable (see cache-storage-key.ts), a
  // collision at the same key should only ever happen when the exact
  // same bytes would be written again — conditional creation lets a
  // caller detect and short-circuit that case instead of re-writing.
  ifNotExists?: boolean;
}

export interface StoredHtmlObject {
  body: Buffer;
  metadata: HtmlObjectMetadata;
}

export type ObjectStorageErrorCode =
  | 'not_found'
  | 'already_exists'
  | 'invalid_key'
  | 'size_limit_exceeded'
  | 'provider_error';

// Fixed, safe error code only — never wraps or exposes raw provider error
// text, filesystem paths, or credentials in the message (see individual
// adapters).
export class ObjectStorageError extends Error {
  readonly code: ObjectStorageErrorCode;
  constructor(code: ObjectStorageErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HtmlObjectStore {
  putObject(input: PutHtmlObjectInput): Promise<HtmlObjectMetadata>;
  // Returns null for a missing object rather than throwing — a "not
  // found" read is an expected, non-exceptional outcome for callers.
  getObject(storageKey: string): Promise<StoredHtmlObject | null>;
  headObject(storageKey: string): Promise<HtmlObjectMetadata | null>;
  // Idempotent: deleting an already-missing key is not an error.
  deleteObject(storageKey: string): Promise<void>;
}
