import dns from 'node:dns/promises';
import { dnsTxtRecordName } from './verification-token.js';

export type DnsVerificationFailureReason =
  | 'nxdomain'
  | 'timeout'
  | 'servfail'
  | 'not_found'
  | 'dns_error';

export interface DnsVerificationResult {
  success: boolean;
  failureReason?: DnsVerificationFailureReason;
}

export type TxtResolver = (hostname: string) => Promise<string[][]>;

const defaultTxtResolver: TxtResolver = (hostname) => dns.resolveTxt(hostname);

// Verifies a DNS TXT record at `_prerender-verification.<hostname>` contains
// a TXT value exactly matching `expectedValue` (case-sensitive, exact match
// — not a substring match). Never makes an HTTP request; DNS TXT lookup
// only. Multi-segment TXT records (returned by Node as string[] per record)
// are joined before comparison, since resolvers may split long values.
export async function verifyDnsTxt(
  normalizedHostname: string,
  expectedValue: string,
  options?: { resolver?: TxtResolver; timeoutMs?: number },
): Promise<DnsVerificationResult> {
  const resolver = options?.resolver ?? defaultTxtResolver;
  const timeoutMs = options?.timeoutMs ?? 5000;
  const recordName = dnsTxtRecordName(normalizedHostname);

  let records: string[][];
  try {
    records = await Promise.race([
      resolver(recordName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs),
      ),
    ]);
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { success: false, failureReason: 'nxdomain' };
    }
    if (code === 'ETIMEOUT' || code === 'EAI_AGAIN') {
      return { success: false, failureReason: 'timeout' };
    }
    if (code === 'ESERVFAIL') {
      return { success: false, failureReason: 'servfail' };
    }
    return { success: false, failureReason: 'dns_error' };
  }

  const joinedValues = records.map((segments) => segments.join(''));
  const match = joinedValues.some((value) => value === expectedValue);

  if (!match) {
    return { success: false, failureReason: 'not_found' };
  }

  return { success: true };
}
