import { describe, expect, it, vi } from 'vitest';
import { verifyDnsTxt } from '../src/lib/dns-verification.js';

describe('verifyDnsTxt', () => {
  it('succeeds on exact match', async () => {
    const resolver = vi.fn().mockResolvedValue([['prerender-verification=abc123']]);
    const result = await verifyDnsTxt('example.com', 'prerender-verification=abc123', { resolver });
    expect(result.success).toBe(true);
  });

  it('joins multi-segment TXT records before comparison', async () => {
    const resolver = vi.fn().mockResolvedValue([['prerender-verif', 'ication=abc123']]);
    const result = await verifyDnsTxt('example.com', 'prerender-verification=abc123', { resolver });
    expect(result.success).toBe(true);
  });

  it('evaluates multiple TXT records and matches any one of them', async () => {
    const resolver = vi.fn().mockResolvedValue([
      ['v=spf1 include:_spf.example.com ~all'],
      ['prerender-verification=abc123'],
    ]);
    const result = await verifyDnsTxt('example.com', 'prerender-verification=abc123', { resolver });
    expect(result.success).toBe(true);
  });

  it('fails when no record matches', async () => {
    const resolver = vi.fn().mockResolvedValue([['prerender-verification=wrong']]);
    const result = await verifyDnsTxt('example.com', 'prerender-verification=abc123', { resolver });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('not_found');
  });

  it('is case-sensitive (does not match differently-cased token)', async () => {
    const resolver = vi.fn().mockResolvedValue([['prerender-verification=ABC123']]);
    const result = await verifyDnsTxt('example.com', 'prerender-verification=abc123', { resolver });
    expect(result.success).toBe(false);
  });

  it('does not do substring matching', async () => {
    const resolver = vi.fn().mockResolvedValue([['prerender-verification=abc123extra']]);
    const result = await verifyDnsTxt('example.com', 'prerender-verification=abc123', { resolver });
    expect(result.success).toBe(false);
  });

  it('maps ENOTFOUND to nxdomain', async () => {
    const resolver = vi.fn().mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
    const result = await verifyDnsTxt('example.com', 'x', { resolver });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('nxdomain');
  });

  it('maps ENODATA to nxdomain', async () => {
    const resolver = vi.fn().mockRejectedValue(Object.assign(new Error('no data'), { code: 'ENODATA' }));
    const result = await verifyDnsTxt('example.com', 'x', { resolver });
    expect(result.failureReason).toBe('nxdomain');
  });

  it('maps timeout errors to timeout', async () => {
    const resolver = vi.fn().mockRejectedValue(Object.assign(new Error('t'), { code: 'EAI_AGAIN' }));
    const result = await verifyDnsTxt('example.com', 'x', { resolver });
    expect(result.failureReason).toBe('timeout');
  });

  it('maps ESERVFAIL to servfail', async () => {
    const resolver = vi.fn().mockRejectedValue(Object.assign(new Error('s'), { code: 'ESERVFAIL' }));
    const result = await verifyDnsTxt('example.com', 'x', { resolver });
    expect(result.failureReason).toBe('servfail');
  });

  it('maps unknown errors to dns_error', async () => {
    const resolver = vi.fn().mockRejectedValue(new Error('mystery'));
    const result = await verifyDnsTxt('example.com', 'x', { resolver });
    expect(result.failureReason).toBe('dns_error');
  });

  it('times out if the resolver never resolves', async () => {
    const resolver = vi.fn(() => new Promise<string[][]>(() => {}));
    const result = await verifyDnsTxt('example.com', 'x', { resolver, timeoutMs: 20 });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('timeout');
  });

  it('queries the _prerender-verification.<hostname> record name', async () => {
    const resolver = vi.fn().mockResolvedValue([]);
    await verifyDnsTxt('example.com', 'x', { resolver });
    expect(resolver).toHaveBeenCalledWith('_prerender-verification.example.com');
  });
});
