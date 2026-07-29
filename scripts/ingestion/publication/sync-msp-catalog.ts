import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';

export const MSP_CATALOG_PROJECTION_APPROVAL = 'PROJECT_OFFICIAL_MSP_FIELDS' as const;
export const MSP_INFOTITULOS_OFFICIAL_URL =
  'https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos';
const FACTUAL_SNAPSHOT_ID_PATTERN = /^factual-v3-[0-9a-f]{16}$/u;
const UTC_REVIEW_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

interface ProjectionRow extends Record<string, unknown> {
  readonly snapshot_id: string;
  readonly projected_professionals: string;
  readonly suppressed_professionals: string;
  readonly enabled_registered_titles: string;
}

export interface MspCatalogProjectionResult {
  readonly snapshotId: string;
  readonly projectedProfessionals: number;
  readonly suppressedProfessionals: number;
  readonly enabledRegisteredTitles: number;
}

export interface MspCatalogProjectionConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number;
  }>;
}

export interface MspCatalogProjectionConfiguration {
  readonly databaseUrl: string;
  readonly databaseCa: string;
  readonly databaseSslServername: string;
  readonly expectedSnapshotId: string;
  readonly publicationReviewedBy: string;
  readonly publicationReviewedAt: string;
  readonly publicationReviewReference: typeof MSP_INFOTITULOS_OFFICIAL_URL;
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function checkedCount(value: string, field: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }

  const count = Number(value);

  if (!Number.isSafeInteger(count)) {
    throw new Error(`PostgreSQL returned an unsafe ${field}`);
  }

  return count;
}

export async function loadMspCatalogProjectionConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<MspCatalogProjectionConfiguration> {
  if (
    requiredEnvironmentValue(environment, 'MSP_CATALOG_PROJECTION_APPROVAL') !==
    MSP_CATALOG_PROJECTION_APPROVAL
  ) {
    throw new Error('MSP_CATALOG_PROJECTION_APPROVAL is missing or invalid');
  }

  const databaseUrl = requiredEnvironmentValue(
    {
      MSP_CATALOG_PROJECTION_DATABASE_URL:
        environment['MSP_CATALOG_PROJECTION_DATABASE_URL'] ??
        environment['PROFESSIONAL_ANALYSIS_DATABASE_URL'] ??
        environment['PRIVATE_INGESTION_DATABASE_URL'],
    },
    'MSP_CATALOG_PROJECTION_DATABASE_URL',
  );
  let parsedDatabaseUrl: URL;

  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('MSP_CATALOG_PROJECTION_DATABASE_URL must be a valid PostgreSQL URL');
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol) ||
    parsedDatabaseUrl.hostname.length === 0 ||
    parsedDatabaseUrl.password.length === 0 ||
    decodeURIComponent(parsedDatabaseUrl.username) !== 'medicos_private_ingestor' ||
    parsedDatabaseUrl.pathname !== '/medicos_catalog' ||
    parsedDatabaseUrl.search.length > 0 ||
    parsedDatabaseUrl.hash.length > 0
  ) {
    throw new Error(
      'MSP_CATALOG_PROJECTION_DATABASE_URL must use medicos_private_ingestor on medicos_catalog without URL options',
    );
  }

  const caPath = resolve(
    requiredEnvironmentValue(
      {
        MSP_CATALOG_PROJECTION_DATABASE_SSL_CA_PATH:
          environment['MSP_CATALOG_PROJECTION_DATABASE_SSL_CA_PATH'] ??
          environment['PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH'] ??
          environment['PRIVATE_INGESTION_DATABASE_SSL_CA_PATH'],
      },
      'MSP_CATALOG_PROJECTION_DATABASE_SSL_CA_PATH',
    ),
  );
  const databaseCa = await readFile(caPath, 'utf8');

  if (!databaseCa.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('MSP_CATALOG_PROJECTION_DATABASE_SSL_CA_PATH is not a PEM certificate');
  }

  const databaseSslServername = requiredEnvironmentValue(
    {
      MSP_CATALOG_PROJECTION_DATABASE_SSL_SERVERNAME:
        environment['MSP_CATALOG_PROJECTION_DATABASE_SSL_SERVERNAME'] ??
        environment['PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME'] ??
        environment['PRIVATE_INGESTION_DATABASE_SSL_SERVERNAME'],
    },
    'MSP_CATALOG_PROJECTION_DATABASE_SSL_SERVERNAME',
  );

  if (
    databaseSslServername.includes('://') ||
    databaseSslServername.includes('/') ||
    databaseSslServername.length > 253
  ) {
    throw new Error('MSP_CATALOG_PROJECTION_DATABASE_SSL_SERVERNAME is invalid');
  }

  const expectedSnapshotId = requiredEnvironmentValue(
    environment,
    'PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID',
  );

  if (!FACTUAL_SNAPSHOT_ID_PATTERN.test(expectedSnapshotId)) {
    throw new Error('PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID is invalid');
  }

  const publicationReviewedBy = requiredEnvironmentValue(
    environment,
    'MSP_CATALOG_PROJECTION_REVIEWED_BY',
  );

  if (publicationReviewedBy.length > 200) {
    throw new Error('MSP_CATALOG_PROJECTION_REVIEWED_BY must not exceed 200 characters');
  }

  const rawPublicationReviewedAt = requiredEnvironmentValue(
    environment,
    'MSP_CATALOG_PROJECTION_REVIEWED_AT',
  );
  const publicationReviewedAtDate = new Date(rawPublicationReviewedAt);

  if (
    !UTC_REVIEW_TIMESTAMP_PATTERN.test(rawPublicationReviewedAt) ||
    !Number.isFinite(publicationReviewedAtDate.getTime())
  ) {
    throw new Error('MSP_CATALOG_PROJECTION_REVIEWED_AT must be a valid UTC ISO-8601 timestamp');
  }
  const publicationReviewedAt = publicationReviewedAtDate.toISOString();

  if (
    requiredEnvironmentValue(environment, 'MSP_CATALOG_PROJECTION_REVIEW_REFERENCE') !==
    MSP_INFOTITULOS_OFFICIAL_URL
  ) {
    throw new Error('MSP_CATALOG_PROJECTION_REVIEW_REFERENCE must be the official MSP URL');
  }

  return {
    databaseUrl,
    databaseCa,
    databaseSslServername,
    expectedSnapshotId,
    publicationReviewedBy,
    publicationReviewedAt,
    publicationReviewReference: MSP_INFOTITULOS_OFFICIAL_URL,
  };
}

export async function projectLatestMspSnapshot(
  connection: MspCatalogProjectionConnection,
  publicationReview: Pick<
    MspCatalogProjectionConfiguration,
    | 'expectedSnapshotId'
    | 'publicationReviewedAt'
    | 'publicationReviewedBy'
    | 'publicationReviewReference'
  >,
): Promise<MspCatalogProjectionResult> {
  await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

  try {
    const projection = await connection.query<ProjectionRow>(
      `SELECT
        snapshot_id,
        projected_professionals::text,
        suppressed_professionals::text,
        enabled_registered_titles::text
      FROM catalog.refresh_msp_public_projection($1, $2, $3, $4)`,
      [
        publicationReview.publicationReviewedBy,
        publicationReview.publicationReviewReference,
        publicationReview.expectedSnapshotId,
        publicationReview.publicationReviewedAt,
      ],
    );

    if (projection.rowCount !== 1 || projection.rows[0] === undefined) {
      throw new Error('MSP catalog projection did not return exactly one result');
    }

    const row = projection.rows[0];
    const result: MspCatalogProjectionResult = {
      snapshotId: row.snapshot_id,
      projectedProfessionals: checkedCount(
        row.projected_professionals,
        'projected professional count',
      ),
      suppressedProfessionals: checkedCount(
        row.suppressed_professionals,
        'suppressed professional count',
      ),
      enabledRegisteredTitles: checkedCount(
        row.enabled_registered_titles,
        'enabled registered-title count',
      ),
    };

    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'MSP catalog projection failed and PostgreSQL rollback also failed',
        { cause: rollbackError },
      );
    }

    throw error;
  }
}

export async function runMspCatalogProjection(
  configuration: MspCatalogProjectionConfiguration,
): Promise<MspCatalogProjectionResult> {
  const client = new Client({
    connectionString: configuration.databaseUrl,
    application_name: 'medicos-msp-catalog-projection',
    connectionTimeoutMillis: 5_000,
    // The initial 27k-profile backfill can exceed five minutes on shared server 104.
    statement_timeout: 900_000,
    idle_in_transaction_session_timeout: 300_000,
    ssl: {
      ca: configuration.databaseCa,
      rejectUnauthorized: true,
      servername: configuration.databaseSslServername,
    },
  });

  await client.connect();

  try {
    return await projectLatestMspSnapshot(
      {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values: readonly unknown[] = [],
        ) {
          const result = await client.query(text, [...values]);

          return {
            rows: result.rows as readonly Row[],
            rowCount: result.rowCount ?? 0,
          };
        },
      },
      configuration,
    );
  } finally {
    await client.end();
  }
}

function loadOptionalDataEnvironment(): void {
  try {
    process.loadEnvFile(resolve('.env.data.local'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

if (require.main === module) {
  loadOptionalDataEnvironment();
  void loadMspCatalogProjectionConfiguration(process.env)
    .then(runMspCatalogProjection)
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ event: 'msp_catalog_projection_completed', ...result })}\n`,
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ event: 'msp_catalog_projection_failed', message })}\n`,
      );
      process.exitCode = 1;
    });
}
