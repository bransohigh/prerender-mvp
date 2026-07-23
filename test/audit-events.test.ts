import { describe, it, expect } from 'vitest';
import {
  buildAuditMetadata,
  AuditMetadataError,
  resolveActorFields,
  safeOrigin,
} from '../src/lib/audit-events.js';
import { encodeAuditCursor, decodeAuditCursor, InvalidAuditCursorError } from '../src/services/audit-service.js';

describe('buildAuditMetadata', () => {
  it('accepts allowlisted keys with primitive values', () => {
    expect(buildAuditMetadata({ roleBefore: 'member', roleAfter: 'admin', discoveredCount: 3 })).toEqual({
      roleBefore: 'member',
      roleAfter: 'admin',
      discoveredCount: 3,
    });
  });

  it('drops undefined values but keeps explicit null', () => {
    expect(buildAuditMetadata({ roleBefore: undefined, reasonCode: null })).toEqual({ reasonCode: null });
  });

  it('rejects a non-allowlisted key', () => {
    expect(() => buildAuditMetadata({ password: 'secret' } as never)).toThrow(AuditMetadataError);
  });

  it('rejects a URL-shaped raw value even under an allowlisted-looking key name', () => {
    expect(() =>
      buildAuditMetadata({ apiKeyName: 'x', fullUrl: 'https://example.com/secret?token=1' } as never),
    ).toThrow(AuditMetadataError);
  });

  it('rejects a non-primitive value under an allowlisted key', () => {
    expect(() => buildAuditMetadata({ reasonCode: { nested: true } as never })).toThrow(AuditMetadataError);
  });

  it('rejects an overly long string value', () => {
    expect(() => buildAuditMetadata({ reasonCode: 'x'.repeat(501) })).toThrow(AuditMetadataError);
  });
});

describe('safeOrigin', () => {
  it('strips path/query/fragment and keeps protocol+host', () => {
    expect(safeOrigin('https://Example.com/path?x=1#frag')).toBe('https://example.com');
  });

  it('keeps a non-default explicit port', () => {
    expect(safeOrigin('https://example.com:8443/a')).toBe('https://example.com:8443');
  });

  it('omits a default port', () => {
    expect(safeOrigin('https://example.com:443/a')).toBe('https://example.com');
    expect(safeOrigin('http://example.com:80/a')).toBe('http://example.com');
  });
});

describe('resolveActorFields', () => {
  it('sets exactly actorUserId for a user actor', () => {
    expect(resolveActorFields({ type: 'user', userId: 'u1' })).toEqual({ actorUserId: 'u1', actorApiKeyId: null });
  });

  it('sets exactly actorApiKeyId for an api_key actor', () => {
    expect(resolveActorFields({ type: 'api_key', apiKeyId: 'k1' })).toEqual({ actorUserId: null, actorApiKeyId: 'k1' });
  });

  it('sets neither for a system actor', () => {
    expect(resolveActorFields({ type: 'system' })).toEqual({ actorUserId: null, actorApiKeyId: null });
  });
});

describe('audit cursor encode/decode', () => {
  it('round-trips createdAt + id', () => {
    const cursor = { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'abc-123' };
    const token = encodeAuditCursor(cursor);
    const decoded = decodeAuditCursor(token);
    expect(decoded.createdAt.toISOString()).toBe(cursor.createdAt.toISOString());
    expect(decoded.id).toBe(cursor.id);
  });

  it('rejects a malformed token', () => {
    expect(() => decodeAuditCursor('not-a-valid-cursor')).toThrow(InvalidAuditCursorError);
  });

  it('rejects a token with an unparseable timestamp', () => {
    const token = Buffer.from('not-a-date|abc', 'utf8').toString('base64url');
    expect(() => decodeAuditCursor(token)).toThrow(InvalidAuditCursorError);
  });
});
