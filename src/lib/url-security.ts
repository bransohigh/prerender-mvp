import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

const blockedHostnames = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data',
]);

const blockedIpv4Cidrs: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
];

const blockedIpv6Cidrs: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['2001:db8::', 32],
  ['ff00::', 8],
];

export function isBlockedIp(ip: string): boolean {
  if (!net.isIP(ip)) return true;

  const addr = ipaddr.process(ip);
  const ranges = addr.kind() === 'ipv4' ? blockedIpv4Cidrs : blockedIpv6Cidrs;

  return ranges.some(([range, prefix]) =>
    addr.match(ipaddr.parse(range), prefix),
  );
}

export function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  while (h.endsWith('.')) {
    h = h.slice(0, -1);
  }
  return h;
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    blockedHostnames.has(normalized) || normalized.endsWith('.local')
  );
}

export function assertAllowedPort(parsed: URL): void {
  const port = parsed.port;
  if (port === '') return;

  const portNum = Number(port);
  if (parsed.protocol === 'http:' && portNum === 80) return;
  if (parsed.protocol === 'https:' && portNum === 443) return;

  throw new Error(
    'Yalnızca HTTP için 80 ve HTTPS için 443 portuna izin verilir',
  );
}

export async function resolveDns(
  hostname: string,
): Promise<{ address: string; family: number }[]> {
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses;
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOTFOUND') {
      throw new Error('Alan adı çözümlenemedi', { cause: err });
    }
    if (code === 'EAI_AGAIN' || code === 'ETIMEOUT' || code === 'TIMEOUT') {
      throw new Error('DNS çözümleme zaman aşımına uğradı', { cause: err });
    }
    throw new Error('DNS çözümleme hatası', { cause: err });
  }
}

export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Geçersiz URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Yalnızca HTTP ve HTTPS URL’leri kabul edilir');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Kimlik bilgisi içeren URL’ler kabul edilmez');
  }

  assertAllowedPort(parsed);

  const hostname = normalizeHostname(parsed.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error('Yerel veya metadata adresleri kabul edilmez');
  }

  const addresses = await resolveDns(hostname);
  if (addresses.length === 0) {
    throw new Error('Alan adı çözümlenemedi');
  }

  if (addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error('Özel veya ayrılmış IP adresleri kabul edilmez');
  }

  return parsed;
}
