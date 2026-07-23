import { describe, expect, it } from 'vitest';
import { normalizeOriginForComparison, createOriginCheckHook } from '../src/lib/csrf.js';
import { parseTrustedOrigins } from '../src/lib/trusted-origins.js';
import { createNoopMetrics, type Metrics, type CsrfRejectionReason } from '../src/lib/metrics.js';

function createSpyMetrics(): Metrics & { csrfCalls: CsrfRejectionReason[] } {
  const csrfCalls: CsrfRejectionReason[] = [];
  return {
    ...createNoopMetrics(),
    incrementCsrfRejection: (reason) => {
      csrfCalls.push(reason);
    },
    csrfCalls,
  };
}

describe('normalizeOriginForComparison', () => {
  it('accepts a plain https origin unchanged', () => {
    expect(normalizeOriginForComparison('https://example.com')).toBe('https://example.com');
  });

  it('lowercases the hostname', () => {
    expect(normalizeOriginForComparison('https://EXAMPLE.com')).toBe('https://example.com');
  });

  it('collapses the default HTTPS port', () => {
    expect(normalizeOriginForComparison('https://example.com:443')).toBe('https://example.com');
  });

  it('collapses the default HTTP port', () => {
    expect(normalizeOriginForComparison('http://example.com:80')).toBe('http://example.com');
  });

  it('keeps a non-default explicit port', () => {
    expect(normalizeOriginForComparison('https://example.com:444')).toBe('https://example.com:444');
  });

  it('rejects a path', () => {
    expect(normalizeOriginForComparison('https://example.com/path')).toBeNull();
  });

  it('rejects a query string', () => {
    expect(normalizeOriginForComparison('https://example.com?query=1')).toBeNull();
  });

  it('rejects a fragment', () => {
    expect(normalizeOriginForComparison('https://example.com#fragment')).toBeNull();
  });

  it('rejects a username', () => {
    expect(normalizeOriginForComparison('https://user@example.com')).toBeNull();
  });

  it('rejects username+password', () => {
    expect(normalizeOriginForComparison('https://user:pass@example.com')).toBeNull();
  });

  it('rejects the literal string "null"', () => {
    expect(normalizeOriginForComparison('null')).toBeNull();
  });

  it('rejects malformed strings', () => {
    expect(normalizeOriginForComparison('not a url at all')).toBeNull();
    expect(normalizeOriginForComparison('')).toBeNull();
  });

  it('whitespace/control-character variants normalize safely (WHATWG URL strips tab/newline and trims edges) -- never to a DIFFERENT trusted-looking origin', () => {
    expect(normalizeOriginForComparison('https://example.com' + ' ')).toBe('https://example.com');
    expect(normalizeOriginForComparison('https://exa' + String.fromCharCode(10) + 'mple.com')).toBe('https://example.com');
  });

  it('rejects a non-http(s) scheme', () => {
    expect(normalizeOriginForComparison('ftp://example.com')).toBeNull();
    expect(normalizeOriginForComparison('javascript://example.com')).toBeNull();
  });

  it('never matches by prefix/suffix/substring — distinguishes confusable hostnames', () => {
    // These must all normalize to something OTHER than "https://example.com"
    // — a prefix/suffix/includes-based comparison would conflate at least
    // one of these with the trusted entry.
    expect(normalizeOriginForComparison('https://example.com.attacker.test')).toBe('https://example.com.attacker.test');
    expect(normalizeOriginForComparison('https://attacker-example.com')).toBe('https://attacker-example.com');
    expect(normalizeOriginForComparison('https://sub.example.com')).toBe('https://sub.example.com');
    expect(normalizeOriginForComparison('https://notexample.com')).toBe('https://notexample.com');
  });
});

function makeRequest(overrides: { method: string; origin?: string }) {
  return {
    method: overrides.method,
    headers: overrides.origin !== undefined ? { origin: overrides.origin } : {},
    id: 'req-1',
  } as never;
}

function makeReply() {
  const calls: Array<{ code: number; body: unknown }> = [];
  return {
    code(code: number) {
      return {
        send: (body: unknown) => {
          calls.push({ code, body });
        },
      };
    },
    calls,
  } as unknown as { code: (n: number) => { send: (b: unknown) => void }; calls: Array<{ code: number; body: unknown }> };
}

describe('createOriginCheckHook', () => {
  const trustedOrigins = new Set(parseTrustedOrigins('https://example.com', true));
  const hook = createOriginCheckHook(trustedOrigins);

  it('allows a GET with no Origin header (not a mutating method)', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'GET' }), reply as never);
    expect(reply.calls).toHaveLength(0);
  });

  it('accepts an exact trusted Origin on a mutating method', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://example.com' }), reply as never);
    expect(reply.calls).toHaveLength(0);
  });

  it('accepts a mixed-case/default-port variant of the trusted Origin', async () => {
    const reply1 = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://EXAMPLE.com' }), reply1 as never);
    expect(reply1.calls).toHaveLength(0);

    const reply2 = makeReply();
    await hook(makeRequest({ method: 'PATCH', origin: 'https://example.com:443' }), reply2 as never);
    expect(reply2.calls).toHaveLength(0);
  });

  it('rejects a sibling subdomain', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://sub.example.com' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
    expect((reply.calls[0]?.body as { error: string }).error).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('rejects a prefix-confusable hostname', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://example.com.attacker.test' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects a suffix-confusable hostname', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://attacker-example.com' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects the wrong scheme', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'http://example.com' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects the wrong explicit port', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'DELETE', origin: 'https://example.com:444' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects a path/query/fragment on an otherwise-trusted origin', async () => {
    for (const origin of ['https://example.com/path', 'https://example.com?q=1', 'https://example.com#f']) {
      const reply = makeReply();
      await hook(makeRequest({ method: 'POST', origin }), reply as never);
      expect(reply.calls[0]?.code).toBe(403);
    }
  });

  it('rejects credentials in the Origin', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://user:pass@example.com' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects a missing Origin on a mutating method', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects the literal Origin: null', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'null' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('rejects a malformed Origin', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'not-a-url' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });

  it('never reveals the configured trusted-origin list in the rejection body', async () => {
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://evil.example.com' }), reply as never);
    const body = JSON.stringify(reply.calls[0]?.body);
    expect(body).not.toContain('example.com');
  });

  it('gives the same generic response shape whether Origin is missing, malformed, or untrusted', async () => {
    const shapes: unknown[] = [];
    for (const origin of [undefined, 'not-a-url', 'https://evil.example.com']) {
      const reply = makeReply();
      await hook(makeRequest({ method: 'POST', origin }), reply as never);
      shapes.push(reply.calls[0]?.body);
    }
    const [a, b, c] = shapes as Array<{ error: string; message: string }>;
    expect(a!.error).toBe(b!.error);
    expect(b!.error).toBe(c!.error);
    expect(a!.message).toBe(b!.message);
  });
});

describe('createOriginCheckHook CSRF rejection metrics', () => {
  const trustedOrigins = new Set(parseTrustedOrigins('https://example.com', true));

  it('increments missing_origin for a missing Origin', async () => {
    const spy = createSpyMetrics();
    const hook = createOriginCheckHook(trustedOrigins, spy);
    await hook(makeRequest({ method: 'POST' }), makeReply() as never);
    expect(spy.csrfCalls).toEqual(['missing_origin']);
  });

  it('increments malformed_origin for a malformed Origin', async () => {
    const spy = createSpyMetrics();
    const hook = createOriginCheckHook(trustedOrigins, spy);
    await hook(makeRequest({ method: 'POST', origin: 'not-a-url' }), makeReply() as never);
    expect(spy.csrfCalls).toEqual(['malformed_origin']);
  });

  it('increments untrusted_origin for a well-formed but untrusted Origin', async () => {
    const spy = createSpyMetrics();
    const hook = createOriginCheckHook(trustedOrigins, spy);
    await hook(makeRequest({ method: 'POST', origin: 'https://evil.example.com' }), makeReply() as never);
    expect(spy.csrfCalls).toEqual(['untrusted_origin']);
  });

  it('increments nothing for an accepted trusted Origin', async () => {
    const spy = createSpyMetrics();
    const hook = createOriginCheckHook(trustedOrigins, spy);
    await hook(makeRequest({ method: 'POST', origin: 'https://example.com' }), makeReply() as never);
    expect(spy.csrfCalls).toEqual([]);
  });

  it('label values are always one of the three fixed reasons, never a derived/raw string', async () => {
    const spy = createSpyMetrics();
    const hook = createOriginCheckHook(trustedOrigins, spy);
    for (const origin of [undefined, 'not-a-url', 'https://evil.example.com', 'https://example.com.attacker.test']) {
      await hook(makeRequest({ method: 'POST', origin }), makeReply() as never);
    }
    for (const reason of spy.csrfCalls) {
      expect(['missing_origin', 'malformed_origin', 'untrusted_origin']).toContain(reason);
    }
  });

  it('a throwing metrics client does not prevent the 403 rejection response', async () => {
    const throwingMetrics: Metrics = { ...createNoopMetrics(), incrementCsrfRejection: () => { throw new Error('boom'); } };
    const hook = createOriginCheckHook(trustedOrigins, throwingMetrics);
    const reply = makeReply();
    await hook(makeRequest({ method: 'POST', origin: 'https://evil.example.com' }), reply as never);
    expect(reply.calls[0]?.code).toBe(403);
  });
});

describe('parseTrustedOrigins startup validation', () => {
  it('rejects a wildcard origin', () => {
    expect(() => parseTrustedOrigins('*', true)).toThrow();
  });

  it('rejects an HTTP origin in production', () => {
    expect(() => parseTrustedOrigins('http://example.com', true)).toThrow();
  });

  it('accepts an HTTP origin in development', () => {
    expect(() => parseTrustedOrigins('http://localhost:3000', false)).not.toThrow();
  });

  it('rejects an origin with a path', () => {
    expect(() => parseTrustedOrigins('https://example.com/app', true)).toThrow();
  });

  it('rejects an origin with credentials', () => {
    expect(() => parseTrustedOrigins('https://user:pass@example.com', true)).toThrow();
  });

  it('normalizes case and default port at config-parse time too', () => {
    expect(parseTrustedOrigins('https://EXAMPLE.com:443', true)).toEqual(['https://example.com']);
  });
});
