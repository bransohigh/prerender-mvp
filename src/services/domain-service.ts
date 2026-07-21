import { AppError } from '../lib/app-error.js';
import { normalizeAndValidateHostname, InvalidHostnameError } from '../lib/domain-normalize.js';
import {
  generateVerificationToken,
  hashVerificationToken,
  dnsTxtRecordName,
  dnsTxtRecordValue,
  htmlVerificationFileContent,
  HTML_VERIFICATION_PATH,
} from '../lib/verification-token.js';
import type { Domain, DomainRepository, VerificationMethod } from '../repositories/types.js';

export interface CreateDomainRequest {
  projectId: string;
  hostname: string;
  verificationMethod: VerificationMethod;
}

export interface VerificationInstructions {
  method: VerificationMethod;
  recordName?: string;
  recordType?: string;
  recordValue?: string;
  filePath?: string;
  fileContent?: string;
}

export interface CreateDomainResult {
  domain: Domain;
  plaintextToken: string;
  verification: VerificationInstructions;
}

function buildVerificationInstructions(
  method: VerificationMethod,
  normalizedHostname: string,
  token: string,
): VerificationInstructions {
  if (method === 'dns_txt') {
    return {
      method,
      recordName: dnsTxtRecordName(normalizedHostname),
      recordType: 'TXT',
      recordValue: dnsTxtRecordValue(token),
    };
  }
  return {
    method,
    filePath: HTML_VERIFICATION_PATH,
    fileContent: htmlVerificationFileContent(token),
  };
}

export function createDomainService(repository: DomainRepository) {
  return {
    async createDomain(input: CreateDomainRequest): Promise<CreateDomainResult> {
      let normalizedHostname: string;
      try {
        normalizedHostname = normalizeAndValidateHostname(input.hostname);
      } catch (err) {
        if (err instanceof InvalidHostnameError) {
          throw new AppError('INVALID_DOMAIN', err.message);
        }
        throw err;
      }

      const token = generateVerificationToken();
      const domain = await repository.create({
        projectId: input.projectId,
        hostname: input.hostname,
        normalizedHostname,
        verificationMethod: input.verificationMethod,
        verificationTokenHash: hashVerificationToken(token),
      });

      return {
        domain,
        plaintextToken: token,
        verification: buildVerificationInstructions(input.verificationMethod, normalizedHostname, token),
      };
    },

    async getDomain(id: string): Promise<Domain> {
      const domain = await repository.findById(id);
      if (!domain) {
        throw new AppError('DOMAIN_NOT_FOUND', `Domain not found: ${id}`);
      }
      return domain;
    },

    async listDomains(projectId: string, limit: number, cursor?: string | null) {
      return repository.listByProject(projectId, { limit, cursor });
    },

    async rotateToken(id: string): Promise<{ domain: Domain; plaintextToken: string; verification: VerificationInstructions }> {
      const existing = await repository.findById(id);
      if (!existing) {
        throw new AppError('DOMAIN_NOT_FOUND', `Domain not found: ${id}`);
      }
      const token = generateVerificationToken();
      const updated = await repository.rotateVerificationToken(id, hashVerificationToken(token));
      if (!updated) {
        throw new AppError('DOMAIN_NOT_FOUND', `Domain not found: ${id}`);
      }
      return {
        domain: updated,
        plaintextToken: token,
        verification: buildVerificationInstructions(updated.verificationMethod, updated.normalizedHostname, token),
      };
    },
  };
}

export type DomainService = ReturnType<typeof createDomainService>;

// Response DTO that strips token/hash fields — used by every domain route
// except the create/rotate responses (which include the plaintext token
// exactly once).
export function toPublicDomain(domain: Domain) {
  return {
    id: domain.id,
    projectId: domain.projectId,
    hostname: domain.hostname,
    normalizedHostname: domain.normalizedHostname,
    status: domain.status,
    verificationMethod: domain.verificationMethod,
    verifiedAt: domain.verifiedAt,
    lastVerificationAttemptAt: domain.lastVerificationAttemptAt,
    verificationFailureCount: domain.verificationFailureCount,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}
