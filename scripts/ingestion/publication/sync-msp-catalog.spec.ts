import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MSP_CATALOG_PROJECTION_APPROVAL,
  MSP_INFOTITULOS_OFFICIAL_URL,
  loadMspCatalogProjectionConfiguration,
  projectLatestMspSnapshot,
  type MspCatalogProjectionConnection,
} from './sync-msp-catalog';

const temporaryDirectories: string[] = [];
const PUBLICATION_REVIEWED_AT = '2026-07-29T02:30:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('MSP catalog projection configuration', () => {
  it('requires an explicit approval, the private ingestor role and a pinned CA', async () => {
    const directory = join(tmpdir(), `medicos-msp-projection-${randomUUID()}`);
    temporaryDirectories.push(directory);
    await mkdir(directory);
    const caPath = join(directory, 'ca.pem');
    await writeFile(
      caPath,
      '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n',
      'utf8',
    );

    await expect(
      loadMspCatalogProjectionConfiguration({
        MSP_CATALOG_PROJECTION_APPROVAL,
        PROFESSIONAL_ANALYSIS_DATABASE_URL:
          'postgresql://medicos_private_ingestor:secret@db.example/medicos_catalog',
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'db.internal.example',
        PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: 'factual-v3-0123456789abcdef',
        MSP_CATALOG_PROJECTION_REVIEWED_BY: 'Integration operator',
        MSP_CATALOG_PROJECTION_REVIEWED_AT: PUBLICATION_REVIEWED_AT,
        MSP_CATALOG_PROJECTION_REVIEW_REFERENCE: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).resolves.toMatchObject({
      databaseUrl: 'postgresql://medicos_private_ingestor:secret@db.example/medicos_catalog',
      databaseSslServername: 'db.internal.example',
      expectedSnapshotId: 'factual-v3-0123456789abcdef',
      publicationReviewedAt: PUBLICATION_REVIEWED_AT,
    });

    await expect(
      loadMspCatalogProjectionConfiguration({
        MSP_CATALOG_PROJECTION_APPROVAL,
        PROFESSIONAL_ANALYSIS_DATABASE_URL:
          'postgresql://medicos_public_query:secret@db.example/medicos_catalog',
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'db.internal.example',
        PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: 'factual-v3-0123456789abcdef',
        MSP_CATALOG_PROJECTION_REVIEWED_BY: 'Integration operator',
        MSP_CATALOG_PROJECTION_REVIEWED_AT: PUBLICATION_REVIEWED_AT,
        MSP_CATALOG_PROJECTION_REVIEW_REFERENCE: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('MSP_CATALOG_PROJECTION_DATABASE_URL must use medicos_private_ingestor');

    await expect(
      loadMspCatalogProjectionConfiguration({
        MSP_CATALOG_PROJECTION_APPROVAL,
        PROFESSIONAL_ANALYSIS_DATABASE_URL:
          'postgresql://medicos_private_ingestor@db.example/medicos_catalog',
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'https://db.internal.example',
        PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: 'factual-v3-0123456789abcdef',
        MSP_CATALOG_PROJECTION_REVIEWED_BY: 'Integration operator',
        MSP_CATALOG_PROJECTION_REVIEWED_AT: PUBLICATION_REVIEWED_AT,
        MSP_CATALOG_PROJECTION_REVIEW_REFERENCE: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('MSP_CATALOG_PROJECTION_DATABASE_URL must use medicos_private_ingestor');

    await expect(
      loadMspCatalogProjectionConfiguration({
        MSP_CATALOG_PROJECTION_APPROVAL,
        PROFESSIONAL_ANALYSIS_DATABASE_URL: 'not-a-postgresql-url',
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'db.internal.example',
        PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: 'factual-v3-0123456789abcdef',
        MSP_CATALOG_PROJECTION_REVIEWED_BY: 'Integration operator',
        MSP_CATALOG_PROJECTION_REVIEWED_AT: PUBLICATION_REVIEWED_AT,
        MSP_CATALOG_PROJECTION_REVIEW_REFERENCE: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('must be a valid PostgreSQL URL');

    await expect(
      loadMspCatalogProjectionConfiguration({
        MSP_CATALOG_PROJECTION_APPROVAL,
        PROFESSIONAL_ANALYSIS_DATABASE_URL:
          'postgresql://medicos_private_ingestor:secret@db.example/medicos_catalog',
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'https://db.internal.example',
        PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: 'factual-v3-0123456789abcdef',
        MSP_CATALOG_PROJECTION_REVIEWED_BY: 'Integration operator',
        MSP_CATALOG_PROJECTION_REVIEWED_AT: PUBLICATION_REVIEWED_AT,
        MSP_CATALOG_PROJECTION_REVIEW_REFERENCE: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('SSL_SERVERNAME is invalid');

    await expect(
      loadMspCatalogProjectionConfiguration({
        MSP_CATALOG_PROJECTION_APPROVAL,
        PROFESSIONAL_ANALYSIS_DATABASE_URL:
          'postgresql://medicos_private_ingestor:secret@db.example/medicos_catalog',
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_CA_PATH: caPath,
        PROFESSIONAL_ANALYSIS_DATABASE_SSL_SERVERNAME: 'db.internal.example',
        PROFESSIONAL_ANALYSIS_EXPECTED_SNAPSHOT_ID: 'factual-v3-0123456789abcdef',
        MSP_CATALOG_PROJECTION_REVIEWED_BY: 'Integration operator',
        MSP_CATALOG_PROJECTION_REVIEWED_AT: '2026-07-29T02:30:00-03:00',
        MSP_CATALOG_PROJECTION_REVIEW_REFERENCE: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('MSP_CATALOG_PROJECTION_REVIEWED_AT must be a valid UTC ISO-8601 timestamp');
  });
});

describe('MSP catalog projection transaction', () => {
  it('commits one validated projection result', async () => {
    const calls: string[] = [];
    let projectionValues: readonly unknown[] | undefined;
    const connection: MspCatalogProjectionConnection = {
      query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        calls.push(text);

        if (text.includes('refresh_msp_public_projection')) {
          projectionValues = values;
          return Promise.resolve({
            rows: [
              {
                snapshot_id: 'factual-v3-0123456789abcdef',
                projected_professionals: '2',
                suppressed_professionals: '0',
                enabled_registered_titles: '3',
              },
            ] as unknown as readonly Row[],
            rowCount: 1,
          });
        }

        if (text.includes('analyze_msp_public_projection')) {
          return Promise.resolve({
            rows: [{}] as unknown as readonly Row[],
            rowCount: 1,
          });
        }

        return Promise.resolve({
          rows: [],
          rowCount: 0,
        });
      },
    };

    await expect(
      projectLatestMspSnapshot(connection, {
        expectedSnapshotId: 'factual-v3-0123456789abcdef',
        publicationReviewedBy: 'Integration operator',
        publicationReviewedAt: PUBLICATION_REVIEWED_AT,
        publicationReviewReference: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).resolves.toEqual({
      snapshotId: 'factual-v3-0123456789abcdef',
      projectedProfessionals: 2,
      suppressedProfessionals: 0,
      enabledRegisteredTitles: 3,
    });
    expect(calls[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(calls.at(-2)).toBe('COMMIT');
    expect(calls.at(-1)).toContain('analyze_msp_public_projection');
    expect(projectionValues).toEqual([
      'Integration operator',
      MSP_INFOTITULOS_OFFICIAL_URL,
      'factual-v3-0123456789abcdef',
      PUBLICATION_REVIEWED_AT,
    ]);
  });

  it('rolls back malformed PostgreSQL results', async () => {
    const calls: string[] = [];
    const connection: MspCatalogProjectionConnection = {
      query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);

        return Promise.resolve({
          rows: (text.includes('refresh_msp_public_projection')
            ? [
                {
                  snapshot_id: 'factual-v3-0123456789abcdef',
                  projected_professionals: '-1',
                  suppressed_professionals: '0',
                  enabled_registered_titles: '1',
                },
              ]
            : []) as unknown as readonly Row[],
          rowCount: text.includes('refresh_msp_public_projection') ? 1 : 0,
        });
      },
    };

    await expect(
      projectLatestMspSnapshot(connection, {
        expectedSnapshotId: 'factual-v3-0123456789abcdef',
        publicationReviewedBy: 'Integration operator',
        publicationReviewedAt: PUBLICATION_REVIEWED_AT,
        publicationReviewReference: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('invalid projected professional count');
    expect(calls.at(-1)).toBe('ROLLBACK');
  });

  it('fails explicitly without rolling back an already committed projection when ANALYZE fails', async () => {
    const calls: string[] = [];
    const connection: MspCatalogProjectionConnection = {
      query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);

        if (text.includes('refresh_msp_public_projection')) {
          return Promise.resolve({
            rows: [
              {
                snapshot_id: 'factual-v3-0123456789abcdef',
                projected_professionals: '2',
                suppressed_professionals: '0',
                enabled_registered_titles: '3',
              },
            ] as unknown as readonly Row[],
            rowCount: 1,
          });
        }

        if (text.includes('analyze_msp_public_projection')) {
          return Promise.reject(new Error('synthetic ANALYZE failure'));
        }

        return Promise.resolve({
          rows: [],
          rowCount: 0,
        });
      },
    };

    await expect(
      projectLatestMspSnapshot(connection, {
        expectedSnapshotId: 'factual-v3-0123456789abcdef',
        publicationReviewedBy: 'Integration operator',
        publicationReviewedAt: PUBLICATION_REVIEWED_AT,
        publicationReviewReference: MSP_INFOTITULOS_OFFICIAL_URL,
      }),
    ).rejects.toThrow('MSP catalog projection committed but PostgreSQL statistics refresh failed');
    expect(calls.at(-2)).toBe('COMMIT');
    expect(calls.at(-1)).toContain('analyze_msp_public_projection');
    expect(calls).not.toContain('ROLLBACK');
  });
});
