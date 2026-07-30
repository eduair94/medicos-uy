import { describe, expect, it, vi } from 'vitest';

import {
  InvalidOwnerResearchListQueryError,
  OwnerResearchDataIntegrityError,
} from '../../src/application/errors/owner-research.error';
import { ListOwnerProfessionalResearch } from '../../src/application/queries/list-owner-professional-research';

import type { PersistedOwnerResearchRecord } from '../../src/application/models/owner-research-read-model';
import type { OwnerResearchListReader } from '../../src/application/ports/owner-research-list-reader.port';

const professionalId = '01985bb6-9fd8-75e3-84a7-b9f81fbe7201';

function persistedRecord(
  researchView: unknown = validResearchView(),
): PersistedOwnerResearchRecord {
  return {
    professionalId,
    slug: 'ana-prueba',
    analysisVersion: 'professional-research-v1-test',
    runStatus: 'COMPLETED',
    reportId: 'synthetic_owner_research_report',
    generatedAt: '2026-07-30T12:00:00.000Z',
    queryAmbiguity: 'NONE',
    bestFlexibilityIndex: 0,
    counts: {
      candidates: 1,
      officialRegistryRecords: 1,
      institutionalCandidates: 0,
      schedules: 0,
      webCandidates: 0,
      publicReferenceCandidates: 0,
      ethicsCandidates: 1,
    },
    researchView,
  };
}

function validResearchView(): unknown {
  return {
    schemaVersion: 1,
    reportId: 'synthetic_owner_research_report',
    generatedAt: '2026-07-30T12:00:00.000Z',
    purpose: 'INTERNAL_PROFESSIONAL_RESEARCH',
    query: {
      mode: 'OPAQUE_MSP_ID',
      selectionRule: 'ALL_BEST_LOOSENESS_MATCHES',
      bestFlexibilityIndex: 0,
      ambiguity: 'NONE',
    },
    candidates: [],
    coverage: {
      mspSnapshotChecked: true,
      linkageSnapshotChecked: true,
      scheduleArtifactsChecked: 0,
      webEnrichmentSnapshotChecked: true,
      curatedReferenceLedgerChecked: true,
      ethicsMetadataSnapshotChecked: true,
      ethicsCasesObserved: 126,
      noFindingsProvesAbsence: false,
    },
    warnings: ['SYNTHETIC_TEST_WARNING'],
    delivery: {
      intendedSurface: 'AUTHENTICATED_PRIVATE_API',
      intendedAudience: 'OWNER_ONLY',
      canonicalUrlsIncluded: true,
      privateApiDeliveryAllowed: true,
      publicApiDeliveryAllowed: false,
      authenticationEnforcedBy: 'CALLING_API',
    },
    publication: {
      decision: 'NOT_PUBLISHED',
      destination: 'INTERNAL_RESEARCH_ONLY',
      publicExportAllowed: false,
      automaticIdentityConfirmation: false,
      automaticFactConfirmation: false,
    },
    internalHmacId: 'must-not-be-returned',
    sourceMetadata: {
      rawPath: 'must-not-be-returned',
    },
  };
}

function reader(
  result: Awaited<ReturnType<OwnerResearchListReader['listLatest']>>,
): OwnerResearchListReader & {
  listLatest: ReturnType<typeof vi.fn<OwnerResearchListReader['listLatest']>>;
} {
  return {
    listLatest: vi.fn().mockResolvedValue(result),
  };
}

describe('ListOwnerProfessionalResearch', () => {
  it('returns a full sanitized dossier page with explicit unverified labels', async () => {
    const repository = reader({
      records: [persistedRecord()],
      nextCursor: 'opaque-next-page',
    });

    const page = await new ListOwnerProfessionalResearch(repository).execute({
      cursor: 'opaque-current-page',
      limit: 10,
    });

    expect(repository.listLatest).toHaveBeenCalledWith({
      cursor: 'opaque-current-page',
      limit: 10,
    });
    expect(page).toMatchObject({
      pagination: {
        limit: 10,
        returned: 1,
        hasMore: true,
        nextCursor: 'opaque-next-page',
      },
      labels: {
        access: 'OWNER_ONLY',
        associations: 'UNVERIFIED_CANDIDATES_INCLUDED',
        projection: 'SANITIZED_OWNER_RESEARCH_VIEW',
      },
      items: [
        {
          professionalId,
          labels: {
            associationReview: 'UNVERIFIED_REVIEW_CANDIDATE',
            originalSourceVerificationRequired: true,
          },
          notice: {
            associationsAreUnconfirmedCandidates: true,
            verifyWithOriginalSource: true,
          },
          dossier: {
            coverage: {
              ethicsMetadataSnapshotChecked: true,
              ethicsCasesObserved: 126,
            },
          },
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('must-not-be-returned');
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { cursor: '' },
    { cursor: 'x'.repeat(1_001) },
  ])('rejects invalid list input before persistence: %j', async (input) => {
    const repository = reader({
      records: [],
    });

    await expect(
      new ListOwnerProfessionalResearch(repository).execute(input),
    ).rejects.toBeInstanceOf(InvalidOwnerResearchListQueryError);
    expect(repository.listLatest).not.toHaveBeenCalled();
  });

  it('fails the whole page closed when any persisted dossier violates the contract', async () => {
    const repository = reader({
      records: [persistedRecord({ schemaVersion: 2 })],
    });

    await expect(new ListOwnerProfessionalResearch(repository).execute({})).rejects.toBeInstanceOf(
      OwnerResearchDataIntegrityError,
    );
  });
});
