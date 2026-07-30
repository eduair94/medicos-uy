import { describe, expect, it, vi } from 'vitest';

import {
  InvalidOwnerResearchQueryError,
  OwnerResearchDataIntegrityError,
  OwnerResearchNotFoundError,
} from '../../src/application/errors/owner-research.error';
import { GetOwnerProfessionalResearch } from '../../src/application/queries/get-owner-professional-research';

import type { PersistedOwnerResearchRecord } from '../../src/application/models/owner-research-read-model';
import type { OwnerResearchReader } from '../../src/application/ports/owner-research-reader.port';

const professionalId = '1a8c34f4-9097-4d86-b670-e609c22e9683';

function researchView(): unknown {
  return {
    schemaVersion: 1,
    reportId: 'professional_research_v1_example',
    generatedAt: '2026-07-29T12:00:00.000Z',
    purpose: 'INTERNAL_PROFESSIONAL_RESEARCH',
    query: {
      input: 'msp_doc_v1_secret',
      normalized: 'msp_doc_v1_secret',
      mode: 'OPAQUE_MSP_ID',
      selectionRule: 'ALL_BEST_LOOSENESS_MATCHES',
      bestFlexibilityIndex: 0,
      ambiguity: 'NONE',
    },
    candidates: [
      {
        professional: {
          linkageId: 'msp_doc_v1_secret',
          fullName: 'TAMARA DIAZ SANZ FERNANDEZ',
          enabledTitles: [
            {
              title: 'DOCTOR EN MEDICINA',
              recruiterCode: 'government-internal-code',
              temporaryRegistration: null,
            },
          ],
          provenance: {
            publisher: 'MSP',
            dataset: 'Infotítulos',
            sourceCutoffDate: '2026-07-01',
          },
        },
        queryMatch: {
          kind: 'EXACT_NORMALIZED_NAME',
          flexibilityIndex: 0,
          canonicalTokenCount: 4,
          observedTokenCount: 4,
          exactObservedTokenCount: 4,
          initialObservedTokenCount: 0,
          meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
        },
        institutionalCandidates: [
          {
            candidateId: 'provider-candidate-1',
            institution: 'Asociación Española',
            status: 'exact_name_only',
            providerIdentity: {
              institution: 'Asociación Española',
              basis: 'source_professional_id',
              sourceProfessionalId: '30358',
              normalizedName: 'tamara diaz sanz fernandez',
            },
            sourceDisplayNames: ['DIAZ SANZ FERNANDEZ, TAMARA'],
            sourceSpecialties: ['SIQUIATRIA'],
            identityEvidence: ['exact_normalized_full_name'],
            schedules: [
              {
                schemaVersion: 1,
                recordId: 'schedule-1',
                source: {
                  id: 'asociacion-espanola',
                  institution: 'Asociación Española',
                  url: 'https://www.asesp.com.uy/Agenda-Medica/Agenda-Medica-uc30',
                },
                observedAt: '2026-07-28T15:06:32.048Z',
                scheduleType: 'published_consultation_roster',
                appointmentAvailability: 'not_observed',
                sourceProfessionalId: '30358',
                sourceProfessionalLabel: 'DIAZ SANZ FERNANDEZ, TAMARA',
                professionalName: 'DIAZ SANZ FERNANDEZ, TAMARA',
                specialty: 'SIQUIATRIA',
                venue: {
                  name: 'Sede Central',
                },
                weeklySchedule: [
                  {
                    dayOfWeek: 'TUESDAY',
                    sourceLabel: 'Martes',
                    value: '09:00-12:00',
                  },
                ],
                evidence: {
                  rawSnapshotPath: 'C:/private/raw.html',
                  rawSnapshotSha256: 'secret-hash',
                  sourceRowNumber: 1037,
                },
              },
            ],
            unresolvedSourceRecords: [
              {
                sourceFile: 'data/private/schedules.ndjson',
                recordId: 'missing-1',
              },
            ],
            identityConfirmed: false,
            linkageDecision: 'NOT_LINKED',
            publicationDecision: 'NOT_PUBLISHED',
            requiresHumanReview: true,
            alerts: ['INSTITUTIONAL_NAME_MATCH_IS_NOT_AN_AUTOMATIC_IDENTITY_LINK'],
          },
        ],
        webCandidates: [
          {
            schemaVersion: 1,
            candidateId: 'web-candidate-1',
            state: 'NEEDS_HUMAN_REVIEW',
            quarantine: true,
            subject: {
              opaqueProfessionalId: 'msp_doc_v1_secret',
              displayName: 'TAMARA DIAZ SANZ FERNANDEZ',
            },
            claim: {
              category: 'ACADEMIC_MENTION',
              sourceId: 'claeh',
              publisher: 'CLAEH',
            },
            match: {
              kind: 'EXACT_NORMALIZED_NAME',
              flexibilityIndex: 0,
              meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
              ambiguity: 'NONE',
              competingOpaqueProfessionalIds: ['msp_doc_v1_other-secret'],
              alerts: ['NAME_RELATION_IS_NOT_IDENTITY_PROOF'],
            },
            provenance: {
              canonicalUrl: 'https://universidad.claeh.edu.uy/example',
              contentSha256: 'secret-content-hash',
              retrievedAt: '2026-07-28T12:00:00.000Z',
              transport: 'DIRECT_FETCH',
              professionalSnapshotSha256: 'secret-professional-hash',
              sourcePolicySha256: 'secret-policy-hash',
            },
            linkageDecision: {
              decision: 'NOT_LINKED',
              identityConfirmed: false,
            },
            factDecision: {
              factConfirmed: false,
            },
            publicationDecision: {
              decision: 'NOT_PUBLISHED',
              destination: 'INTERNAL_QUARANTINE_ONLY',
              publicExportAllowed: false,
            },
            retention: {
              expiresAt: '2026-08-28T12:00:00.000Z',
              disposition: 'DELETE_OR_REVALIDATE',
            },
          },
        ],
        publicReferenceCandidates: [
          {
            reference: {
              schemaVersion: 1,
              referenceId: 'reference-1',
              referenceKind: 'PUBLIC_METADATA_REFERENCE',
              publisher: 'ResearchGate',
              canonicalUrl: 'https://www.researchgate.net/publication/example',
              title: 'Academic metadata',
              sourceDate: '2024',
              sourceDatePrecision: 'YEAR',
              observedNames: ['Tamara Díaz-Sanz'],
              claim: {
                relationship: 'ACADEMIC_RESEARCH_COAUTHOR',
                factualSummary: 'Named as a coauthor in public metadata.',
                institutionContext: ['Hospital Vilardebó'],
                doesNotEstablish: ['IDENTITY', 'EMPLOYMENT'],
              },
              access: {
                mode: 'PUBLIC_METADATA_ONLY',
                automatedFetchAllowed: false,
                contentStored: false,
                rightsNote: 'Metadata only.',
              },
              corroboratesReferenceIds: [],
              decision: {
                identityConfirmed: false,
                factConfirmed: false,
                linkageDecision: 'NOT_LINKED',
                publicationDecision: 'NOT_PUBLISHED',
                publicExportAllowed: false,
                requiresHumanReview: true,
              },
            },
            nameMatch: {
              kind: 'PARTIAL_TOKEN_SUBSET',
              flexibilityIndex: 1,
              canonicalTokenCount: 4,
              observedTokenCount: 2,
              exactObservedTokenCount: 2,
              initialObservedTokenCount: 0,
              meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
            },
            connection: 'DIRECT_NAME_CANDIDATE',
            alerts: ['PUBLIC_REFERENCE_REQUIRES_HUMAN_REVIEW'],
          },
        ],
        sourceCoverage: [
          {
            sourceId: 'cmu-ethics',
            publisher: 'Colegio Médico del Uruguay',
            sourceUrl: 'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/',
            category: 'PROFESSIONAL_ETHICS_RULINGS',
            status: 'CHECKED',
            policyReviewedAt: '2026-07-29T00:00:00.000Z',
            automatedFetchPerformed: true,
            namedMatchStatus: 'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX',
            noFindingProvesAbsence: false,
            identityDecision: 'NOT_LINKED',
            publicationDecision: 'NOT_PUBLISHED',
            warnings: ['NO_FINDING_DOES_NOT_PROVE_ABSENCE'],
          },
        ],
        signalSummary: {
          officialRegistryRecords: 1,
          institutionalCandidates: 1,
          scheduleRecords: 1,
          webCandidates: 1,
          publicReferenceCandidates: 1,
          publishers: ['MSP', 'Asociación Española', 'CLAEH', 'ResearchGate'],
          institutionContexts: ['Hospital Vilardebó'],
        },
      },
    ],
    coverage: {
      mspSnapshotChecked: true,
      linkageSnapshotChecked: true,
      scheduleArtifactsChecked: 1,
      webEnrichmentSnapshotChecked: true,
      curatedReferenceLedgerChecked: true,
      noFindingsProvesAbsence: false,
    },
    warnings: ['NAME_MATCHING_GENERATES_REVIEW_CANDIDATES_ONLY'],
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
  };
}

function persistedRecord(view: unknown = researchView()): PersistedOwnerResearchRecord {
  return {
    professionalId,
    slug: 'tamara-diaz-sanz-fernandez-1a8c34f49097',
    analysisVersion: 'professional-research-v1',
    runStatus: 'COMPLETED',
    reportId: 'professional_research_v1_example',
    generatedAt: '2026-07-29T12:00:00.000Z',
    queryAmbiguity: 'NONE',
    bestFlexibilityIndex: 0,
    counts: {
      candidates: 1,
      officialRegistryRecords: 1,
      institutionalCandidates: 1,
      schedules: 1,
      webCandidates: 1,
      publicReferenceCandidates: 1,
      ethicsCandidates: 0,
    },
    researchView: view,
  };
}

function reader(record: PersistedOwnerResearchRecord | undefined): OwnerResearchReader & {
  findLatestByProfessional: ReturnType<
    typeof vi.fn<OwnerResearchReader['findLatestByProfessional']>
  >;
} {
  return {
    findLatestByProfessional: vi.fn().mockResolvedValue(record),
  };
}

describe('GetOwnerProfessionalResearch', () => {
  it('returns candidate evidence while reconstructing a path- and HMAC-free response', async () => {
    const repository = reader(persistedRecord());
    const result = await new GetOwnerProfessionalResearch(repository).execute(
      ` ${professionalId} `,
    );

    expect(repository.findLatestByProfessional).toHaveBeenCalledWith({
      kind: 'PUBLIC_UUID',
      value: professionalId,
    });
    expect(result.dossier.candidates[0]?.institutionalCandidates[0]).toMatchObject({
      identityConfirmed: false,
      status: 'exact_name_only',
      sourceSpecialties: ['SIQUIATRIA'],
      schedules: [
        {
          observedAt: '2026-07-28T15:06:32.048Z',
          specialty: 'SIQUIATRIA',
          weeklySchedule: [
            {
              dayOfWeek: 'TUESDAY',
              value: '09:00-12:00',
            },
          ],
        },
      ],
    });
    expect(result.dossier.candidates[0]?.webCandidates[0]).toMatchObject({
      match: {
        kind: 'EXACT_NORMALIZED_NAME',
        flexibilityIndex: 0,
      },
      linkageDecision: {
        identityConfirmed: false,
      },
      factDecision: {
        factConfirmed: false,
      },
      provenance: {
        canonicalUrl: 'https://universidad.claeh.edu.uy/example',
      },
    });
    expect(result.dossier.candidates[0]?.publicReferenceCandidates[0]?.reference.decision).toEqual({
      identityConfirmed: false,
      factConfirmed: false,
      linkageDecision: 'NOT_LINKED',
      publicationDecision: 'NOT_PUBLISHED',
      publicExportAllowed: false,
      requiresHumanReview: true,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('msp_doc_v1_');
    expect(serialized).not.toContain('government-internal-code');
    expect(serialized).not.toContain('rawSnapshotPath');
    expect(serialized).not.toContain('sourceFile');
    expect(serialized).not.toContain('secret-hash');
    expect(serialized).not.toContain('Sha256');
  });

  it('normalizes a slug without accepting arbitrary path-like input', async () => {
    const repository = reader(persistedRecord());
    await new GetOwnerProfessionalResearch(repository).execute(
      ' Tamara-Diaz-Sanz-Fernandez-1A8C34F49097 ',
    );

    expect(repository.findLatestByProfessional).toHaveBeenCalledWith({
      kind: 'SLUG',
      value: 'tamara-diaz-sanz-fernandez-1a8c34f49097',
    });
  });

  it('rejects malformed identifiers before persistence', async () => {
    const repository = reader(undefined);

    await expect(
      new GetOwnerProfessionalResearch(repository).execute('../research'),
    ).rejects.toBeInstanceOf(InvalidOwnerResearchQueryError);
    expect(repository.findLatestByProfessional).not.toHaveBeenCalled();
  });

  it('returns not found when no current dossier exists', async () => {
    await expect(
      new GetOwnerProfessionalResearch(reader(undefined)).execute(professionalId),
    ).rejects.toBeInstanceOf(OwnerResearchNotFoundError);
  });

  it('fails closed when persisted JSON no longer satisfies the owner contract', async () => {
    await expect(
      new GetOwnerProfessionalResearch(reader(persistedRecord({ schemaVersion: 2 }))).execute(
        professionalId,
      ),
    ).rejects.toBeInstanceOf(OwnerResearchDataIntegrityError);
  });
});
