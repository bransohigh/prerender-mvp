import { domainToASCII } from 'node:url';
import net from 'node:net';
import { isBlockedHostname, normalizeHostname as lowerTrimTrailingDot } from './url-security.js';

export type InvalidHostnameReason =
  | 'empty'
  | 'contains_scheme'
  | 'contains_path'
  | 'contains_port'
  | 'contains_credentials'
  | 'wildcard'
  | 'ip_address'
  | 'blocked_hostname'
  | 'single_label'
  | 'idna_failed'
  | 'too_long';

export class InvalidHostnameError extends Error {
  readonly reason: InvalidHostnameReason;
  constructor(reason: InvalidHostnameReason, message: string) {
    super(message);
    this.name = 'InvalidHostnameError';
    this.reason = reason;
  }
}

const MAX_HOSTNAME_LENGTH = 253;

// Deterministic normalization: lowercase, trailing dot removed, IDNA/
// punycode ASCII form, no scheme/path/query/fragment/port/credentials,
// no wildcard, no IP address, no localhost/private/internal/single-label
// names. Throws InvalidHostnameError with a stable reason on rejection.
export function normalizeAndValidateHostname(rawInput: string): string {
  const input = rawInput.trim();
  if (input.length === 0) {
    throw new InvalidHostnameError('empty', 'Hostname boş olamaz');
  }

  if (/[a-z]+:\/\//i.test(input) || input.includes('://')) {
    throw new InvalidHostnameError('contains_scheme', 'Hostname scheme içermemeli (örn. https://)');
  }
  if (input.includes('/') || input.includes('?') || input.includes('#')) {
    throw new InvalidHostnameError('contains_path', 'Hostname path/query/fragment içermemeli');
  }
  if (input.includes('@')) {
    throw new InvalidHostnameError('contains_credentials', 'Hostname kimlik bilgisi içermemeli');
  }
  if (/\s/.test(input)) {
    throw new InvalidHostnameError('contains_path', 'Hostname boşluk içermemeli');
  }
  if (input.includes('*')) {
    throw new InvalidHostnameError('wildcard', 'Wildcard hostname kabul edilmez');
  }

  // A bare ":port" suffix — but be careful not to reject IPv6 literals here;
  // IPv6 literals are rejected separately below via net.isIP.
  const portMatch = input.match(/^[^[\]]+:(\d+)$/);
  if (portMatch) {
    throw new InvalidHostnameError('contains_port', 'Hostname port içermemeli');
  }

  const lowered = lowerTrimTrailingDot(input);

  if (net.isIP(lowered)) {
    throw new InvalidHostnameError('ip_address', 'IP adresi hostname olarak kabul edilmez');
  }

  let ascii: string;
  try {
    ascii = domainToASCII(lowered);
  } catch {
    throw new InvalidHostnameError('idna_failed', 'IDNA normalizasyonu başarısız');
  }
  if (!ascii) {
    throw new InvalidHostnameError('idna_failed', 'IDNA normalizasyonu başarısız');
  }

  if (ascii.length > MAX_HOSTNAME_LENGTH) {
    throw new InvalidHostnameError('too_long', `Hostname ${MAX_HOSTNAME_LENGTH} karakteri aşamaz`);
  }

  if (!ascii.includes('.')) {
    throw new InvalidHostnameError('single_label', 'Tek etiketli (single-label) hostname kabul edilmez');
  }

  if (isBlockedHostname(ascii)) {
    throw new InvalidHostnameError('blocked_hostname', 'Yerel veya metadata hostname kabul edilmez');
  }

  return ascii;
}
