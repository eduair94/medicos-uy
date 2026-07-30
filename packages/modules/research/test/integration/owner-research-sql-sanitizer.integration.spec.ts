import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sanitizeOwnerResearchDossier } from '../../src/application/models/owner-research-read-model';

const describeWithDocker =
  process.env['RUN_INTEGRATION_TESTS'] === 'true' ? describe : describe.skip;

const ETHICS_CASE_ID = `ethics_case_v1_${'a'.repeat(64)}`;

function exactNameMatch(): Record<string, unknown> {
  return {
    kind: 'EXACT_NORMALIZED_NAME',
    flexibilityIndex: 0,
    canonicalTokenCount: 2,
    observedTokenCount: 2,
    exactObservedTokenCount: 2,
    initialObservedTokenCount: 0,
    meaning: 'LOOSENESS_NOT_IDENTITY_CONFIDENCE',
  };
}

function syntheticResearchView(): Record<string, unknown> {
  const nameMatch = exactNameMatch();

  return {
    schemaVersion: 1,
    reportId: `professional_research_v1_${'b'.repeat(64)}`,
    generatedAt: '2026-07-29T12:00:00.000Z',
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
          fullName: 'ANA PRUEBA',
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
        institutionalCandidates: [],
        webCandidates: [],
        publicReferenceCandidates: [],
        ethicsCaseCandidates: [
          {
            ethicsCase: {
              schemaVersion: 1,
              ethicsCaseId: ETHICS_CASE_ID,
              sourceCaseKey: '101/2026',
              publisher: 'Colegio Médico del Uruguay',
              tribunal: 'Tribunal de Ética Médica',
              title: 'Expediente sintético 101/2026',
              canonicalUrl:
                'https://www.colegiomedico.org.uy/fallos/expediente-sintetico-101-2026/',
              collectionMode: 'AUTOMATED_PUBLIC_METADATA_SNAPSHOT',
              visibility: 'ORIGINAL',
              outcome: 'UNKNOWN',
              finalityStatus: 'UNKNOWN',
              currentnessVerified: false,
              sourceDate: '2026-06-01',
              sourceDatePrecision: 'DAY',
              observedRespondentNames: ['ANA PRUEBA'],
              documents: [
                {
                  label: 'Documento sintético',
                  sourceDate: '2026-06-01',
                  sourceDatePrecision: 'DAY',
                  contentFetched: false,
                  downloadUrl: 'private-document-url-canary',
                },
              ],
              firstObservedAt: '2026-07-29T12:00:00.000Z',
              lastObservedAt: '2026-07-29T12:00:00.000Z',
              contentStored: false,
              source: {
                sitemapUrl: 'https://www.colegiomedico.org.uy/fallos-sitemap.xml',
                sitemapLastModified: '2026-07-29',
                robotsUrl: 'https://www.colegiomedico.org.uy/robots.txt',
                pageMetadataOnly: true,
                robotsSha256: 'private-robots-hash-canary',
              },
              sourceMetadata: {
                private: 'must-not-cross-sql-boundary',
              },
            },
            observedName: 'ANA PRUEBA',
            nameMatch,
            decision: {
              identityConfirmed: false,
              factConfirmed: false,
              linkageDecision: 'NOT_LINKED',
              publicationDecision: 'NOT_PUBLISHED',
              publicExportAllowed: false,
              requiresHumanReview: true,
              privateReviewer: 'must-not-cross-sql-boundary',
            },
            alerts: ['Coincidencia exacta pendiente de revisión humana.'],
            candidateSha256: 'private-candidate-hash-canary',
          },
        ],
        sourceCoverage: [
          {
            sourceId: 'colegio-medico-etica',
            publisher: 'Colegio Médico del Uruguay',
            sourceUrl: 'https://www.colegiomedico.org.uy/fallos-sitemap.xml',
            category: 'PROFESSIONAL_ETHICS_RULINGS',
            status: 'CHECKED',
            policyReviewedAt: '2026-07-29T12:00:00.000Z',
            automatedFetchPerformed: true,
            namedMatchStatus: 'CANDIDATE_REQUIRES_HUMAN_REVIEW',
            noFindingProvesAbsence: false,
            identityDecision: 'NOT_LINKED',
            publicationDecision: 'NOT_PUBLISHED',
            warnings: ['Una coincidencia nominal no confirma identidad ni hechos.'],
          },
        ],
        signalSummary: {
          officialRegistryRecords: 1,
          institutionalCandidates: 0,
          scheduleRecords: 0,
          webCandidates: 0,
          publicReferenceCandidates: 0,
          ethicsCandidates: 1,
          publishers: ['Ministerio de Salud Pública', 'Colegio Médico del Uruguay'],
          institutionContexts: [],
          privateCount: 999,
        },
      },
    ],
    coverage: {
      mspSnapshotChecked: true,
      linkageSnapshotChecked: true,
      scheduleArtifactsChecked: 0,
      webEnrichmentSnapshotChecked: true,
      curatedReferenceLedgerChecked: true,
      ethicsMetadataSnapshotChecked: true,
      ethicsCasesObserved: 1,
      noFindingsProvesAbsence: false,
      privateCoverage: 'must-not-cross-sql-boundary',
    },
    warnings: ['Las asociaciones son candidatas no confirmadas.'],
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

async function installMigrationPrerequisites(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE ROLE medicos_migrator NOLOGIN;
    CREATE ROLE medicos_catalog_reader NOLOGIN;
    CREATE ROLE medicos_public_query NOLOGIN;
    CREATE ROLE medicos_private_ingestor NOLOGIN;
    CREATE ROLE medicos_owner_research_reader NOLOGIN;

    CREATE SCHEMA ingestion_private;
    CREATE TABLE ingestion_private.snapshot (
      snapshot_id varchar(120) PRIMARY KEY
    );
    CREATE TABLE ingestion_private.professional_profile (
      snapshot_id varchar(120) NOT NULL,
      internal_hmac_id varchar(75) NOT NULL,
      PRIMARY KEY (snapshot_id, internal_hmac_id),
      FOREIGN KEY (snapshot_id)
        REFERENCES ingestion_private.snapshot(snapshot_id)
    );
    CREATE TABLE ingestion_private.msp_catalog_identity (
      professional_public_id uuid NOT NULL,
      internal_hmac_id varchar(75) NOT NULL
    );

    CREATE SCHEMA catalog;
    CREATE TABLE catalog.public_professional (
      id uuid PRIMARY KEY
    );
    CREATE TABLE catalog.public_professional_route (
      professional_id uuid NOT NULL,
      slug text NOT NULL,
      route_kind text NOT NULL
    );
  `);
}

async function applyResearchMigrations(pool: Pool): Promise<void> {
  for (const file of [
    '0006_professional_research.sql',
    '0007_owner_research_read_model.sql',
    '0008_cmu_ethics_metadata_snapshot.sql',
  ]) {
    const migrationSql = await readFile(
      resolve(process.cwd(), 'drizzle/research-private/migrations', file),
      'utf8',
    );
    await pool.query(migrationSql);
  }
}

async function withRole<T>(
  pool: Pool,
  role: 'medicos_owner_research_reader' | 'medicos_public_query',
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query(`SET ROLE ${role}`);
    return await operation(client);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

function automatedEthicsCaseInsert(
  idCharacter: string,
  sourceCaseKey: string,
): {
  readonly text: string;
  readonly values: unknown[];
} {
  return {
    text: `
      INSERT INTO research_private.ethics_case (
        ethics_case_id,
        publisher,
        source_case_key,
        tribunal,
        title,
        canonical_url,
        collection_mode,
        visibility,
        outcome,
        finality_status,
        currentness_verified,
        source_date,
        source_date_precision,
        document_sha256,
        source_metadata,
        content_stored,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        $1,
        'Colegio Médico del Uruguay',
        $2,
        'Tribunal de Ética Médica',
        'Expediente sintético',
        'https://www.colegiomedico.org.uy/fallos/expediente-sintetico/',
        'AUTOMATED_PUBLIC_METADATA_SNAPSHOT',
        'ORIGINAL',
        'UNKNOWN',
        'UNKNOWN',
        false,
        '2026-06-01',
        'DAY',
        NULL,
        $3::jsonb,
        false,
        '2026-07-29T12:00:00.000Z',
        '2026-07-29T12:00:00.000Z'
      )
    `,
    values: [
      `ethics_case_v1_${idCharacter.repeat(64)}`,
      sourceCaseKey,
      JSON.stringify({
        safeguards: {
          pageMetadataOnly: true,
          pdfFetched: false,
          documentContentFetched: false,
          automaticIdentityConfirmation: false,
          automaticFactConfirmation: false,
          publicExportAllowed: false,
        },
      }),
    ],
  };
}

describeWithDocker('owner research SQL migrations and sanitizer', () => {
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

    await installMigrationPrerequisites(pool);
    await applyResearchMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('applies 0008 and keeps the read model owner-only', async () => {
    const privileges = await pool.query<{
      readonly owner_schema_usage: boolean;
      readonly owner_view_select: boolean;
      readonly owner_function_execute: boolean;
      readonly owner_ethics_table_select: boolean;
      readonly public_view_select: boolean;
      readonly public_function_execute: boolean;
    }>(`
      SELECT
        has_schema_privilege(
          'medicos_owner_research_reader',
          'research_private',
          'USAGE'
        ) AS owner_schema_usage,
        has_table_privilege(
          'medicos_owner_research_reader',
          'research_private.owner_professional_dossier',
          'SELECT'
        ) AS owner_view_select,
        has_function_privilege(
          'medicos_owner_research_reader',
          'research_private.sanitize_owner_research_view(jsonb)',
          'EXECUTE'
        ) AS owner_function_execute,
        has_table_privilege(
          'medicos_owner_research_reader',
          'research_private.ethics_case',
          'SELECT'
        ) AS owner_ethics_table_select,
        has_table_privilege(
          'medicos_public_query',
          'research_private.owner_professional_dossier',
          'SELECT'
        ) AS public_view_select,
        has_function_privilege(
          'medicos_public_query',
          'research_private.sanitize_owner_research_view(jsonb)',
          'EXECUTE'
        ) AS public_function_execute
    `);

    expect(privileges.rows[0]).toEqual({
      owner_schema_usage: true,
      owner_view_select: true,
      owner_function_execute: true,
      owner_ethics_table_select: false,
      public_view_select: false,
      public_function_execute: false,
    });

    await expect(
      withRole(pool, 'medicos_owner_research_reader', async (client) =>
        client.query('SELECT count(*) FROM research_private.owner_professional_dossier'),
      ),
    ).resolves.toBeDefined();
    await expect(
      withRole(pool, 'medicos_owner_research_reader', async (client) =>
        client.query('SELECT count(*) FROM research_private.ethics_case'),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      withRole(pool, 'medicos_public_query', async (client) =>
        client.query('SELECT count(*) FROM research_private.owner_professional_dossier'),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('matches the strict API DTO while removing private and unknown fields', async () => {
    const input = injectCanaryAtEveryObject(syntheticResearchView());
    const expected = sanitizeOwnerResearchDossier(input);
    const result = await pool.query<{ readonly sanitized: unknown }>(
      `
        SELECT research_private.sanitize_owner_research_view($1::jsonb)
          AS sanitized
      `,
      [JSON.stringify(input)],
    );
    const sanitized = result.rows[0]?.sanitized;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toEqual(expected);
    expect(serialized).not.toContain('__unknown_canary__');
    expect(serialized).not.toContain('private-query-canary');
    expect(serialized).not.toContain('private-linkage-canary');
    expect(serialized).not.toContain('private-document-url-canary');
    expect(serialized).not.toContain('private-candidate-hash-canary');
    expect(serialized).not.toContain('sourceMetadata');
    expect(serialized).toContain('ethicsCaseCandidates');
    expect(serialized).toContain('ethicsMetadataSnapshotChecked');
  });

  it('accepts safe metadata-only cases and rejects missing safeguards', async () => {
    const validInsert = automatedEthicsCaseInsert('c', 'fixture-valid-101/2026');
    await expect(pool.query(validInsert.text, validInsert.values)).resolves.toBeDefined();

    const unsafeInsert = automatedEthicsCaseInsert('d', 'fixture-unsafe-102/2026');
    const incompleteMetadata = JSON.stringify({
      safeguards: {
        pageMetadataOnly: true,
      },
    });

    await expect(
      pool.query(unsafeInsert.text, [
        unsafeInsert.values[0],
        unsafeInsert.values[1],
        incompleteMetadata,
      ]),
    ).rejects.toThrow(/ck_research_ethics_case_automated_metadata/u);
  });
});
