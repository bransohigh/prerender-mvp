import dns from 'node:dns/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  assertSafePublicUrl,
  isBlockedIp,
  isBlockedHostname,
  normalizeHostname,
  assertAllowedPort,
} from '../src/lib/url-security.js';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

const mockLookup = vi.mocked(dns.lookup);

function mockPublicDns() {
  mockLookup.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
  ] as never);
}

function mockPrivateDns() {
  mockLookup.mockResolvedValue([
    { address: '192.168.1.1', family: 4 },
  ] as never);
}

function mockMixedDns() {
  mockLookup.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ] as never);
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------- isBlockedIp ----------

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
  ])('bloklar private/reserved IPv4: %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1'])(
    'public IPv4 kabul eder: %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it.each(['::1', 'fc00::1', 'fe80::1', '2001:db8::1', 'ff02::1'])(
    'bloklar private/reserved IPv6: %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    },
  );

  it('IPv4-mapped IPv6 ::ffff:127.0.0.1 reddeder', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('IPv4-mapped IPv6 ::ffff:10.0.0.1 reddeder', () => {
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('IPv4-mapped IPv6 ::ffff:169.254.169.254 reddeder', () => {
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('IPv4-mapped IPv6 ::ffff:192.168.1.1 reddeder', () => {
    expect(isBlockedIp('::ffff:192.168.1.1')).toBe(true);
  });

  it('public IPv4-mapped IPv6 kabul eder', () => {
    expect(isBlockedIp('::ffff:93.184.216.34')).toBe(false);
  });

  it('geçersiz IP reddeder', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

// ---------- normalizeHostname ----------

describe('normalizeHostname', () => {
  it('trailing dot kaldırır', () => {
    expect(normalizeHostname('example.com.')).toBe('example.com');
  });

  it('birden fazla trailing dot kaldırır', () => {
    expect(normalizeHostname('example.com..')).toBe('example.com');
  });

  it('lowercase yapar', () => {
    expect(normalizeHostname('EXAMPLE.COM')).toBe('example.com');
  });
});

// ---------- isBlockedHostname ----------

describe('isBlockedHostname', () => {
  it('localhost reddeder', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
  });

  it('localhost. reddeder', () => {
    expect(isBlockedHostname('localhost.')).toBe(true);
  });

  it('example.local reddeder', () => {
    expect(isBlockedHostname('example.local')).toBe(true);
  });

  it('example.local. reddeder', () => {
    expect(isBlockedHostname('example.local.')).toBe(true);
  });

  it('metadata.google.internal reddeder', () => {
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });

  it('metadata.google.internal. reddeder', () => {
    expect(isBlockedHostname('metadata.google.internal.')).toBe(true);
  });

  it('public hostname kabul eder', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
  });
});

// ---------- assertAllowedPort ----------

describe('assertAllowedPort', () => {
  it('http:// varsayılan port kabul eder', () => {
    expect(() => assertAllowedPort(new URL('http://example.com'))).not.toThrow();
  });

  it('http://example.com:80 kabul eder', () => {
    expect(() => assertAllowedPort(new URL('http://example.com:80'))).not.toThrow();
  });

  it('https:// varsayılan port kabul eder', () => {
    expect(() => assertAllowedPort(new URL('https://example.com'))).not.toThrow();
  });

  it('https://example.com:443 kabul eder', () => {
    expect(() => assertAllowedPort(new URL('https://example.com:443'))).not.toThrow();
  });

  it('http://example.com:443 reddeder', () => {
    expect(() => assertAllowedPort(new URL('http://example.com:443'))).toThrow();
  });

  it('https://example.com:80 reddeder', () => {
    expect(() => assertAllowedPort(new URL('https://example.com:80'))).toThrow();
  });

  it.each([22, 3000, 3306, 5432, 6379, 8080])(
    'port %d reddeder',
    (port) => {
      expect(() =>
        assertAllowedPort(new URL(`http://example.com:${port}`)),
      ).toThrow();
    },
  );
});

// ---------- assertSafePublicUrl ----------

describe('assertSafePublicUrl', () => {
  describe('protokol kontrolleri', () => {
    it.each(['file:///etc/passwd', 'ftp://example.com', 'data:text/html,hi', 'javascript:alert(1)'])(
      '%s reddeder',
      async (url) => {
        await expect(assertSafePublicUrl(url)).rejects.toThrow();
      },
    );

    it('http kabul eder', async () => {
      mockPublicDns();
      await expect(assertSafePublicUrl('http://example.com')).resolves.toBeDefined();
    });

    it('https kabul eder', async () => {
      mockPublicDns();
      await expect(assertSafePublicUrl('https://example.com')).resolves.toBeDefined();
    });
  });

  describe('kimlik bilgisi kontrolleri', () => {
    it('username içeren URL reddeder', async () => {
      await expect(
        assertSafePublicUrl('https://user@example.com'),
      ).rejects.toThrow();
    });

    it('username:password içeren URL reddeder', async () => {
      await expect(
        assertSafePublicUrl('https://user:pass@example.com'),
      ).rejects.toThrow();
    });
  });

  describe('port kontrolleri', () => {
    it('http varsayılan port kabul eder', async () => {
      mockPublicDns();
      await expect(assertSafePublicUrl('http://example.com')).resolves.toBeDefined();
    });

    it('http:80 kabul eder', async () => {
      mockPublicDns();
      await expect(assertSafePublicUrl('http://example.com:80')).resolves.toBeDefined();
    });

    it('https:443 kabul eder', async () => {
      mockPublicDns();
      await expect(assertSafePublicUrl('https://example.com:443')).resolves.toBeDefined();
    });

    it('http:8080 reddeder', async () => {
      await expect(assertSafePublicUrl('http://example.com:8080')).rejects.toThrow();
    });

    it('https:80 reddeder', async () => {
      await expect(assertSafePublicUrl('https://example.com:80')).rejects.toThrow();
    });
  });

  describe('hostname kontrolleri', () => {
    it('localhost reddeder', async () => {
      await expect(assertSafePublicUrl('http://localhost')).rejects.toThrow();
    });

    it('localhost. trailing dot reddeder', async () => {
      await expect(assertSafePublicUrl('http://localhost.')).rejects.toThrow();
    });
  });

  describe('DNS kontrolleri', () => {
    it('private IP çözümleyen hostname reddeder', async () => {
      mockPrivateDns();
      await expect(
        assertSafePublicUrl('http://example.com'),
      ).rejects.toThrow('Özel veya ayrılmış IP');
    });

    it('karışık public+private DNS sonucu reddeder', async () => {
      mockMixedDns();
      await expect(
        assertSafePublicUrl('http://example.com'),
      ).rejects.toThrow('Özel veya ayrılmış IP');
    });

    it('ENOTFOUND DNS hatası anlaşılır mesaj döner', async () => {
      mockLookup.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      );
      await expect(
        assertSafePublicUrl('http://nonexistent.example'),
      ).rejects.toThrow('Alan adı çözümlenemedi');
    });

    it('DNS timeout hatası anlaşılır mesaj döner', async () => {
      mockLookup.mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }),
      );
      await expect(
        assertSafePublicUrl('http://slow.example'),
      ).rejects.toThrow('DNS çözümleme zaman aşımına uğradı');
    });

    it('bilinmeyen DNS hatası kontrollü döner', async () => {
      mockLookup.mockRejectedValue(new Error('unknown'));
      await expect(
        assertSafePublicUrl('http://broken.example'),
      ).rejects.toThrow('DNS çözümleme hatası');
    });
  });

  describe('geçersiz URL', () => {
    it('boş string reddeder', async () => {
      await expect(assertSafePublicUrl('')).rejects.toThrow('Geçersiz URL');
    });

    it('URL olmayan string reddeder', async () => {
      await expect(assertSafePublicUrl('not a url')).rejects.toThrow('Geçersiz URL');
    });
  });
});
