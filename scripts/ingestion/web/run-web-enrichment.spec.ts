import { describe, expect, it } from 'vitest';

import {
  parseProfessionalSeeds,
  parseWebEnrichmentPolicy,
  repairUtf8Mojibake,
} from './run-web-enrichment';

describe('web enrichment ingestion boundary', () => {
  it('repairs common UTF-8 mojibake before deterministic name matching', () => {
    expect(repairUtf8Mojibake('Tamara DÃ­az Sanz')).toBe('Tamara Díaz Sanz');
    expect(repairUtf8Mojibake('Tamara Diaz Sanz')).toBe('Tamara Diaz Sanz');
  });

  it('rejects publication-capable or expired source policies', () => {
    const policy = {
      schemaVersion: 1,
      policyId: 'test-v1',
      purpose: 'INTERNAL_DIRECTORY_RESEARCH',
      reviewedAt: '2026-07-01',
      validUntil: '2026-08-01',
      sources: [
        {
          sourceId: 'academic',
          publisher: 'Universidad',
          category: 'ACADEMIC_MENTION',
          enabled: true,
          allowedHosts: ['example.org'],
          seedUrls: ['https://example.org/event'],
          directFetchAllowed: false,
          rightsStatus: 'INTERNAL_RESEARCH_ONLY',
          internalResearchAllowed: true,
          publicationAllowed: false,
          retentionDays: 30,
        },
      ],
      safeguards: {
        sourceFirst: true,
        searchResultsAreEvidence: false,
        automaticIdentityConfirmation: false,
        automaticFactConfirmation: false,
        automaticPublication: false,
        publicExportAllowed: false,
        noFindingsProvesAbsence: false,
      },
    };

    expect(parseWebEnrichmentPolicy(policy, new Date('2026-07-28T00:00:00Z')).sources).toHaveLength(
      1,
    );
    expect(() =>
      parseWebEnrichmentPolicy(
        {
          ...policy,
          sources: [{ ...policy.sources[0], publicationAllowed: true }],
        },
        new Date('2026-07-28T00:00:00Z'),
      ),
    ).toThrow('publicationAllowed');
    expect(() => parseWebEnrichmentPolicy(policy, new Date('2026-08-02T00:00:00Z'))).toThrow(
      'expired',
    );
  });

  it('refuses raw identity fields in the professional seed file', () => {
    const safe = JSON.stringify({
      linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
      fullName: 'TAMARA DIAZ SANZ',
    });
    expect(parseProfessionalSeeds(`${safe}\n`)).toHaveLength(1);
    expect(() =>
      parseProfessionalSeeds(
        `${JSON.stringify({
          linkageId: `msp_doc_v1_${'a'.repeat(64)}`,
          fullName: 'TAMARA DIAZ SANZ',
          cedula: 'not-allowed',
        })}\n`,
      ),
    ).toThrow('raw identity data');
  });
});
