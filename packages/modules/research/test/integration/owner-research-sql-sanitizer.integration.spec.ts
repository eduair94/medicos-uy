import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sanitizeOwnerResearchDossier } from '../../src/application/models/owner-research-read-model';

const describeWithDocker =
  process.env['RUN_INTEGRATION_TESTS'] === 'true' ? describe : describe.skip;

function tamaraLikeResearchView(): Record<string, unknown> {
  const nameMatch = {
    kind: 'EXACT_NORMALIZED_NAME',
    flexibilityIndex: 0,
    canonicalTokenCount: 4,
    observedTokenCount: 4,
    exactObservedTokenCount: 4,
    initialObservedTokenCount: 0,
    meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
  };

  return {
    schemaVersion: 1,
    reportId: 'report-tamara',
    generatedAt: '2026-07-28T15:37:57.448Z',
    purpose: 'INTERNAL_PROFESSIONAL_RESEARCH',
    query: {
      input: 'private-query-canary',
      normalized: 'private-normalized-canary',
      mode: 'OPAQUE_MSP_ID',
      selectionRule: 'ALL_BEST_LOOSENESS_MATCHES',
      bestFlexibilityIndex: 0,
      ambiguity: 'NONE',
    },
    candidates: [
      {
        professional: {
          linkageId: 'private-linkage-canary',
          fullName: 'TAMARA - DIAZ SANZ FERNANDEZ',
          enabledTitles: [
            {
              title: 'DOCTOR EN MEDICINA',
              temporaryRegistration: null,
              recruiterCode: 'private-recruiter-canary',
            },
          ],
          provenance: {
            publisher: 'Ministerio de Salud Pública',
            dataset: 'InfoTítulos',
            sourceCutoffDate: '2026-06-30',
          },
        },
        queryMatch: nameMatch,
        institutionalCandidates: [
          {
            candidateId: 'provider-asociacion-espanola',
            institution: 'Asociación Española',
            status: 'exact_name_only',
            providerIdentity: {
              institution: 'Asociación Española',
              basis: 'institution_and_exact_name',
              sourceProfessionalId: '30358',
              normalizedName: 'tamara diaz sanz fernandez',
            },
            sourceDisplayNames: ['Tamara Díaz Sanz Fernández'],
            sourceSpecialties: ['SIQUIATRIA'],
            identityEvidence: ['Exact normalized name'],
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
                sourceProfessionalLabel: 'Tamara Díaz Sanz Fernández',
                professionalName: 'Tamara Díaz Sanz Fernández',
                specialty: 'SIQUIATRIA',
                venue: {
                  name: 'Sede Central',
                  address: 'Av. Italia',
                  phone: '0000',
                  dependency: 'Consultorio',
                },
                weeklySchedule: [
                  {
                    dayOfWeek: 'TUESDAY',
                    sourceLabel: 'Martes',
                    value: '09:00-12:00',
                  },
                ],
                frequency: 'WEEKLY',
                notes: 'Published roster',
                evidence: {
                  rawSnapshotPath: 'private-path-canary',
                },
              },
            ],
            unresolvedSourceRecords: [
              {
                recordId: 'unresolved-1',
                sourceFile: 'private-file-canary',
              },
            ],
            identityConfirmed: false,
            linkageDecision: 'NOT_LINKED',
            publicationDecision: 'NOT_PUBLISHED',
            requiresHumanReview: true,
            alerts: ['Candidate association only'],
          },
        ],
        webCandidates: [
          {
            schemaVersion: 1,
            candidateId: 'web-1',
            state: 'NEEDS_HUMAN_REVIEW',
            quarantine: true,
            subject: {
              displayName: 'Tamara Díaz Sanz',
            },
            claim: {
              category: 'ACADEMIC_MENTION',
              sourceId: 'claeh',
              publisher: 'Universidad CLAEH',
            },
            match: {
              kind: 'PARTIAL_TOKEN_SUBSET',
              flexibilityIndex: 1,
              meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
              ambiguity: 'HOMONYM',
              alerts: ['Human review required'],
              competingOpaqueProfessionalIds: ['private-competitor-canary'],
            },
            provenance: {
              canonicalUrl:
                'https://universidad.claeh.edu.uy/medicina/2018/07/10/jornada-de-actualizacion-para-el-equipo-de-salud/',
              retrievedAt: '2026-07-28T15:37:57.448Z',
              transport: 'DIRECT_FETCH',
              contentSha256: 'private-content-hash-canary',
              professionalSnapshotSha256: 'private-snapshot-hash-canary',
              sourcePolicySha256: 'private-policy-hash-canary',
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
              expiresAt: '2026-10-28T15:37:57.448Z',
              disposition: 'DELETE_OR_REVALIDATE',
            },
          },
        ],
        publicReferenceCandidates: [
          {
            reference: {
              schemaVersion: 1,
              referenceId: 'reference-1',
              referenceKind: 'CRAWLED_SOURCE_METADATA',
              publisher: 'Universidad CLAEH',
              canonicalUrl:
                'https://universidad.claeh.edu.uy/medicina/2018/07/10/jornada-de-actualizacion-para-el-equipo-de-salud/',
              title: 'Jornada de actualización',
              sourceDate: '2018-07-10',
              sourceDatePrecision: 'DAY',
              observedNames: ['Tamara Díaz Sanz'],
              claim: {
                relationship: 'MEDICAL_STUDENT_PRESENTATION',
                factualSummary: 'Public metadata mentions the observed name.',
                institutionContext: ['Universidad CLAEH'],
                doesNotEstablish: ['Identity'],
              },
              access: {
                mode: 'ALLOWLISTED_PUBLIC_PAGE',
                automatedFetchAllowed: true,
                contentStored: false,
                rightsNote: 'Metadata only',
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
            nameMatch,
            connection: 'DIRECT_NAME_CANDIDATE',
            alerts: ['Unconfirmed association'],
          },
        ],
        sourceCoverage: [
          {
            sourceId: 'colegio-medico-etica',
            publisher: 'Colegio Médico del Uruguay',
            sourceUrl: 'https://www.colegiomedico.org.uy/fallos-emitidos-por-el-tribunal-de-etica/',
            category: 'PROFESSIONAL_ETHICS_RULINGS',
            status: 'CHECKED',
            policyReviewedAt: '2026-07-28T15:37:57.448Z',
            automatedFetchPerformed: true,
            namedMatchStatus: 'NO_NAMED_MATCH_IN_CURRENT_VISIBLE_INDEX',
            noFindingProvesAbsence: true,
            identityDecision: 'NOT_LINKED',
            publicationDecision: 'NOT_PUBLISHED',
            warnings: ['Absence of a match is not proof of absence.'],
          },
        ],
        signalSummary: {
          officialRegistryRecords: 1,
          institutionalCandidates: 1,
          scheduleRecords: 1,
          webCandidates: 1,
          publicReferenceCandidates: 1,
          publishers: ['Ministerio de Salud Pública', 'Universidad CLAEH'],
          institutionContexts: ['Asociación Española', 'Universidad CLAEH'],
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
    warnings: ['Associations require human review.'],
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

function injectCanaryAtEveryObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(injectCanaryAtEveryObject);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries([
      ...Object.entries(value).map(([key, nestedValue]) => [
        key,
        injectCanaryAtEveryObject(nestedValue),
      ]),
      ['__unknown_canary__', 'must-not-cross-sql-boundary'],
    ]);
  }

  return value;
}

describeWithDocker('owner research SQL sanitizer', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('medicos_test')
      .withUsername('medicos')
      .withPassword('medicos_test')
      .start();
    pool = new Pool({
      connectionString: container.getConnectionUri(),
    });

    const migrationSql = await readFile(
      resolve(
        process.cwd(),
        'drizzle/research-private/migrations/0007_owner_research_read_model.sql',
      ),
      'utf8',
    );
    const functionDefinitions =
      /CREATE OR REPLACE FUNCTION research_private\.owner_jsonb_pick[\s\S]*?(?=(?:DROP VIEW IF EXISTS|CREATE(?: OR REPLACE)? VIEW) research_private\.owner_professional_dossier)/u.exec(
        migrationSql,
      )?.[0];

    if (functionDefinitions === undefined) {
      throw new Error('Could not locate owner research sanitizer function definitions.');
    }

    await pool.query('CREATE SCHEMA research_private');
    await pool.query(functionDefinitions);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('matches the strict API DTO and removes unknown keys at every object depth', async () => {
    const input = injectCanaryAtEveryObject(tamaraLikeResearchView());
    const expected = sanitizeOwnerResearchDossier(input);
    const result = await pool.query<{ readonly sanitized: unknown }>(
      `
        SELECT research_private.sanitize_owner_research_view($1::jsonb)
          AS sanitized
      `,
      [JSON.stringify(input)],
    );
    const sanitized = result.rows[0]?.sanitized;

    expect(sanitized).toEqual(expected);
    expect(JSON.stringify(sanitized)).not.toContain('__unknown_canary__');
    expect(JSON.stringify(sanitized)).not.toContain('private-query-canary');
    expect(JSON.stringify(sanitized)).not.toContain('private-linkage-canary');
    expect(JSON.stringify(sanitized)).not.toContain('private-content-hash-canary');
  });
});
